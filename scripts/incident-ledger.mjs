#!/usr/bin/env node
// incident-ledger.mjs — HIP-3 喂价事件台账（纯函数核心 + 零依赖 CLI）。
//
// 动机：雷达快照只有 30 天保留期（data 分支每月孤儿重建物理销毁历史），墓碑
// 窗口只有 96 快照（48h）——红/黄/陷阱事件今天是头条，一个月后就什么都不剩。
// 台账把"瞬态告警"提升为"永久事件记录"：open → resolved 状态机 + 峰值证据 +
// 证据快照引用。台账文件放 main 分支（incidents.jsonl），不进 data 分支，
// 永不被清理；体积增长是事件级（KB/月），不是快照级（MB/天）。
//
// 数据流：radar-core.classify / tombstoneDexs 是唯一分级来源（与状态页同源，
// 本模块不复制任何分级逻辑）。告警行直接从快照重算，不读 alarms.jsonl——
// 状态页生成失败不阻断台账记录（丢台账点的代价高于页面短暂陈旧，同 rationale）。
//
// 状态机（防抖动）：
//   - 事件键 = `dex:asset`（DEX 墓碑 = `dex:*`）；resolved 后再次告警开新
//     episode（#1、#2…），老 episode 是历史，不复活。
//   - open 事件在本轮告警缺席 → misses+1；连续缺席 ≥ RESOLVE_SNAPSHOTS
//     （默认 3 ≈ 90 分钟）→ resolved（resolvedAt = 当前采样时刻）。
//     单点缺席不关事件：一次 API 抖动不该把 48h 的事件记成两段。
//   - 升级只记峰值：peakGrade / peakDevBps / peakNotionalUsd / peakTs +
//     peakSnapshot（快照文件名，证据链接；随 30 天保留期过期，JSONL 里
//     保留字段，链接腐烂是诚实成本）。
//
// 用法：
//   node scripts/incident-ledger.mjs <snapshot.json> --history <snapshotsDir> \
//        --ledger <incidents.jsonl> [--out <file>]
// 默认原地写回 --ledger；--out - 打 stdout。输出 JSONL，每行一个事件。

import fs from 'node:fs';
import path from 'node:path';
import { classify, tombstoneDexs, TOMBSTONE_WINDOW } from './radar-core.mjs';

/** 连续缺席多少个采样点才判 resolved（30 分钟采样 → 3 ≈ 90 分钟）。 */
export const RESOLVE_SNAPSHOTS = 3;

// 严重度排序（市场级事件内部比较）：red > yellow > trap。
// 墓碑是 DEX 级结论，不参与市场事件的升级比较（互斥：墓碑 DEX 的市场不分级）。
const SEVERITY = { red: 3, yellow: 2, trap: 1 };

// Hyperliquid 的 asset 名自带 dex 前缀（快照里 asset="xyz:ICE"、dex="xyz"），
// 事件键与显示名去掉冗余前缀——id 读作 xyz:ICE#1，不是 xyz:xyz:ICE#1。
function shortAsset(dex, asset) {
  const a = String(asset ?? '');
  return a.startsWith(`${dex}:`) ? a.slice(dex.length + 1) : a;
}

/** 事件键：市场 = dex:asset（去冗余前缀），DEX 墓碑 = dex:*。 */
export function eventKey(row) {
  return row.grade === 'tombstone' ? `${row.dex}:*` : `${row.dex}:${shortAsset(row.dex, row.asset)}`;
}

/** 采样时刻 → data 分支上的证据快照文件名（与 sample-oracles.mjs 命名一致）。 */
export function snapshotFile(ts) {
  return `snapshot-${String(ts).replace(/[:.]/g, '-')}.json`;
}

// 从快照计算本轮告警行：市场级红/黄/陷阱（white/missing 不告警）+ DEX 级墓碑。
// history：按时间升序的历史快照数组（不含当前），供墓碑判定，与状态页同窗口。
export function alarmRowsFromSnapshot(snapshot, history = []) {
  const rows = [];
  const tombstoned = tombstoneDexs(history);
  for (const d of snapshot.dexs ?? []) {
    if (d.error) continue;
    if (tombstoned.has(d.dex)) {
      const t = tombstoned.get(d.dex);
      rows.push({
        ts: snapshot.sampledAt,
        dex: d.dex,
        asset: '*',
        grade: 'tombstone',
        devBps: null,
        notionalUsd: null,
        volUsd: null,
        reason: `dormant: every market OI=0 & 24h vol low for ${t.seen} consecutive snapshots (max dev ${(t.maxDevBps / 100).toFixed(2)}%)`,
      });
      continue;
    }
    for (const a of d.assets ?? []) {
      const c = classify(a);
      if (c.grade === 'white' || c.grade === 'missing') continue;
      rows.push({
        ts: snapshot.sampledAt,
        dex: d.dex,
        asset: a.asset,
        grade: c.grade,
        devBps: c.devBps !== null ? Math.round(c.devBps * 10) / 10 : null,
        notionalUsd: c.notionalUsd !== null ? Math.round(c.notionalUsd) : null,
        volUsd: Math.round(parseFloat(a.dayNtlVlm ?? '0') || 0),
        reason: c.reason,
      });
    }
  }
  return rows;
}

// 状态机核心（纯函数）：existing = 已解析的旧台账行，alarmRows = 本轮告警，
// sampledAt = 本轮采样时刻。返回新的完整台账（resolved 原序保留 + open 事件），
// 按 openedAt 排序输出——JSONL 即时间线。
export function updateIncidents(existing, alarmRows, sampledAt) {
  const open = new Map();
  const closed = [];
  for (const line of existing ?? []) {
    if (!line || typeof line !== 'object') continue;
    if (line.status === 'open') open.set(line.key, { ...line });
    else closed.push(line);
  }

  const seen = new Set();
  for (const row of alarmRows ?? []) {
    const key = eventKey(row);
    seen.add(key);
    const inc = open.get(key);
    if (!inc) {
      // 重开 = 新 episode：该 key 的历史 episode 数 + 1（首episode = 1）
      const episode = closed.reduce((m, i) => (i.key === key ? Math.max(m, i.episode ?? 1) : m), 0) + 1;
      open.set(key, {
        id: `${key}#${episode}`,
        key,
        name: key,
        dex: row.dex,
        asset: row.asset,
        episode,
        status: 'open',
        openedAt: sampledAt,
        lastSeenAt: sampledAt,
        misses: 0,
        samples: 1,
        peakGrade: row.grade,
        peakDevBps: row.devBps,
        peakNotionalUsd: row.notionalUsd,
        peakTs: sampledAt,
        peakSnapshot: snapshotFile(sampledAt),
        lastGrade: row.grade,
        lastDevBps: row.devBps,
        lastNotionalUsd: row.notionalUsd,
        lastReason: row.reason,
        lastTs: sampledAt,
      });
      continue;
    }
    inc.lastSeenAt = sampledAt;
    inc.misses = 0;
    inc.samples = (inc.samples ?? 1) + 1;
    const worseGrade = (SEVERITY[row.grade] ?? 0) > (SEVERITY[inc.peakGrade] ?? 0);
    const higherDev = row.grade === inc.peakGrade && row.grade !== 'tombstone'
      && (row.devBps ?? 0) > (inc.peakDevBps ?? 0);
    if (worseGrade || higherDev) {
      inc.peakGrade = row.grade;
      inc.peakDevBps = row.devBps;
      inc.peakNotionalUsd = row.notionalUsd;
      inc.peakTs = sampledAt;
      inc.peakSnapshot = snapshotFile(sampledAt);
    }
    inc.lastGrade = row.grade;
    inc.lastDevBps = row.devBps;
    inc.lastNotionalUsd = row.notionalUsd;
    inc.lastReason = row.reason;
    inc.lastTs = sampledAt;
  }

  // 本轮缺席的 open 事件：misses 累加，达到阈值判 resolved
  for (const inc of open.values()) {
    if (seen.has(inc.key)) continue;
    inc.misses = (inc.misses ?? 0) + 1;
    if (inc.misses >= RESOLVE_SNAPSHOTS) {
      inc.status = 'resolved';
      inc.resolvedAt = sampledAt;
    }
  }

  return [...closed, ...open.values()].sort((a, b) =>
    String(a.openedAt ?? '').localeCompare(String(b.openedAt ?? '')) || (a.episode ?? 1) - (b.episode ?? 1));
}

// —— CLI ——
function usage() {
  console.error('usage: node scripts/incident-ledger.mjs <snapshot.json> --history <snapshotsDir> --ledger <incidents.jsonl> [--out <file>]');
  process.exit(1);
}

export function readLedger(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  // 先抽出 <flag, value> 对，剩余的才是位置参数（与 status-page.mjs 同模式）
  const flagNames = ['--history', '--ledger', '--out'];
  const flags = {};
  for (const name of flagNames) {
    const i = args.indexOf(name);
    if (i >= 0 && args[i + 1] && !flagNames.includes(args[i + 1])) flags[name] = args[i + 1];
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagNames.includes(args[i - 1] ?? ''));
  const snapFile = positional[0];
  const historyDir = flags['--history'];
  const ledgerFile = flags['--ledger'];
  const outFile = flags['--out'];
  if (!snapFile || !ledgerFile) usage();

  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  // 只解析窗口内的快照，与 status-page.mjs 同策略（全量解析随历史线性恶化）
  let history = [];
  if (historyDir && fs.existsSync(historyDir)) {
    const files = fs.readdirSync(historyDir).filter((f) => /^snapshot-.*\.json$/.test(f)).sort().slice(-TOMBSTONE_WINDOW);
    history = files.map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  }

  const existing = readLedger(ledgerFile);
  const before = { open: existing.filter((i) => i?.status === 'open').length, total: existing.length };
  const rows = alarmRowsFromSnapshot(snap, history);
  const updated = updateIncidents(existing, rows, snap.sampledAt);
  const after = { open: updated.filter((i) => i?.status === 'open').length, total: updated.length };

  const lines = updated.map((i) => JSON.stringify(i)).join('\n') + (updated.length ? '\n' : '');
  if (outFile === '-') {
    process.stdout.write(lines);
  } else {
    fs.writeFileSync(outFile ?? ledgerFile, lines);
  }
  console.log(`# incident ledger: ${before.total} -> ${after.total} events (open ${before.open} -> ${after.open}), ${rows.length} alarm rows this round`);
}

// 只在直接执行时跑 CLI（vitest import 时不触发）
if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
