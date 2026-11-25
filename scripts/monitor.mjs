#!/usr/bin/env node
// monitor.mjs — HIP-3 喂价常驻守护进程（零依赖、只读、零密钥）。
//
// 核心能力：用 oracle 值变化检测推断"最后一次真实更新"——
//   快照 API 不暴露喂价更新时间戳，所以本进程持续轮询，
//   oracle 一变就刷新 lastChangeAt，从而实现真实的 staleness 检测。
//
// 环境变量：
//   MONITOR_POLL_MS   轮询间隔（默认 10000）
//   MONITOR_WARN_MS   无变化超过此时长 → warn（默认 60000）
//   MONITOR_CRIT_MS   无变化超过此时长 → critical（默认 300000）
//   MONITOR_OUT       JSONL 告警输出文件（可选，缺省仅 stdout）
//   MONITOR_LIVE_ONLY 仅对 OI>0 的活跃资产告警（默认 true；弃养市场会淹没告警）
//
// 用法：
//   node scripts/monitor.mjs
//   nohup node scripts/monitor.mjs > monitor.log 2>&1 &

import { assessDeviation } from '../dist/index.js';
import fs from 'node:fs';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const POLL_MS = parseInt(process.env.MONITOR_POLL_MS ?? '10000', 10);
const WARN_MS = parseInt(process.env.MONITOR_WARN_MS ?? '60000', 10);
const CRIT_MS = parseInt(process.env.MONITOR_CRIT_MS ?? '300000', 10);
const LIVE_ONLY = (process.env.MONITOR_LIVE_ONLY ?? 'true') !== 'false';
const OUT_FILE = process.env.MONITOR_OUT;

async function info(body) {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`info HTTP ${res.status}`);
  return res.json();
}

function emit(alarm) {
  const line = JSON.stringify(alarm);
  console.log(line);
  if (OUT_FILE) fs.appendFileSync(OUT_FILE, line + '\n');
}

const state = new Map(); // key "dex:asset" -> { oracle, lastChangeAt, oi }

async function pollCycle(now) {
  const dexList = (await info({ type: 'perpDexs' })).filter((x) => x);
  let live = 0;

  for (const dex of dexList) {
    let meta, ctxs;
    try {
      [meta, ctxs] = await info({ type: 'metaAndAssetCtxs', dex: dex.name });
    } catch (e) {
      emit({ at: new Date(now).toISOString(), type: 'poll-error', dex: dex.name, error: e.message });
      continue;
    }
    const universe = meta?.universe ?? [];
    for (let i = 0; i < Math.min(ctxs?.length ?? 0, universe.length); i++) {
      const asset = universe[i]?.name;
      const c = ctxs[i];
      const oracle = parseFloat(c.oraclePx);
      const mark = parseFloat(c.markPx);
      const oi = parseFloat(c.openInterest ?? '0');
      if (!asset || !Number.isFinite(oracle) || !Number.isFinite(mark)) continue;
      if (oi > 0) live++;

      const key = `${dex.name}:${asset}`;
      const prev = state.get(key);
      if (!prev) {
        state.set(key, { oracle, lastChangeAt: now, oi });
        continue; // 首次观测：从现在起算，诚实但不完整
      }

      if (oracle !== prev.oracle) {
        prev.oracle = oracle;
        prev.lastChangeAt = now;
        prev.oi = oi;
        continue;
      }

      prev.oi = oi;
      const ageMs = now - prev.lastChangeAt;
      const trackStaleness = !LIVE_ONLY || oi > 0;
      if (trackStaleness && ageMs >= WARN_MS) {
        const severity = ageMs >= CRIT_MS ? 'critical' : 'warn';
        emit({
          at: new Date(now).toISOString(),
          type: 'staleness',
          severity,
          dex: dex.name,
          asset,
          oracle,
          mark,
          oi,
          ageMs,
          note: `no oracle change observed for ${Math.round(ageMs / 1000)}s (observed since ${new Date(prev.lastChangeAt).toISOString()})`,
        });
      }

      // 顺带跑偏离守卫（只对活跃资产，弃养市场由 staleness 语义覆盖）
      if (oi > 0) {
        const dev = assessDeviation(oracle, mark, {});
        if (dev.severity !== 'ok') {
          emit({
            at: new Date(now).toISOString(),
            type: 'deviation',
            severity: dev.severity,
            dex: dex.name,
            asset,
            oracle,
            mark,
            oi,
            deviationBps: dev.deviationBps,
            note: dev.reason,
          });
        }
      }
    }
  }
  return live;
}

let cycle = 0;
async function loop() {
  while (true) {
    const now = Date.now();
    try {
      const live = await pollCycle(now);
      cycle++;
      if (cycle % 6 === 0) {
        console.log(`# heartbeat cycle=${cycle} tracking=${state.size} live=${live} poll=${POLL_MS}ms warn=${WARN_MS}ms crit=${CRIT_MS}ms`);
      }
    } catch (e) {
      emit({ at: new Date(now).toISOString(), type: 'cycle-error', error: e.message });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

console.log(`# hip3-oracle-guard monitor starting: poll=${POLL_MS}ms warn=${WARN_MS}ms crit=${CRIT_MS}ms live_only=${LIVE_ONLY}${OUT_FILE ? ` out=${OUT_FILE}` : ''}`);
loop();
