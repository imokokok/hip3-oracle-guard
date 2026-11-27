#!/usr/bin/env node
// status-page.mjs — 风险雷达状态页生成器 v2（零依赖）。
//
// v1 是"每个市场喂价健康吗"的平铺体检表；v2 换成交易员/质押者视角的
// 四层观察雷达（规格：docs/RISK-RADAR-REDESIGN.md）：
//   1. 指标带：全网 24h 量 / 红 / 黄 / 陷阱 / 墓志铭 DEX 数
//   2. 活市场风险表：红 + 黄，按 OI 加权偏离排序
//   3. 陷阱区：24h 量≈0 但 OI>0（头寸在场、无新鲜成交）
//   4. 墓志铭区：连续 96 快照量≈0 且 OI=0 的 DEX（单点零值不判死）
// 白色市场按 DEX 聚合成一行；缺失数据单列，不进分级。
//
// 指标为观察性指标（OI 加权偏离），非清算风险估算。
//
// 用法：
//   node scripts/status-page.mjs <snapshot.json> [outdir] [--history <snapshotsDir>] [--alarms <file>] [--rss <file>]
// 输出：<outdir>/index.html（+ 可选 alarms.jsonl / feed.xml）

import fs from 'node:fs';
import path from 'node:path';
import {
  RED_DEV_BPS, RED_OI_USD, YELLOW_DEV_BPS, YELLOW_OI_USD, YELLOW_OI_DEV_BPS,
  TRAP_VOL_USD, TOMBSTONE_WINDOW, TOMBSTONE_MIN_SNAPSHOTS,
  classify, notionalUsd, tombstoneDexs, deviationBps,
} from './radar-core.mjs';

const args = process.argv.slice(2);
// 先抽出 <flag, value> 对，剩余的才是位置参数——否则 flag 的值会被误当位置参数
const flagNames = ['--history', '--alarms', '--rss'];
const flags = {};
for (const name of flagNames) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !flagNames.includes(args[i + 1])) flags[name] = args[i + 1];
}
const positional = args.filter((a, i) => !a.startsWith('--') && !flagNames.includes(args[i - 1] ?? ''));
const snapFile = positional[0];
const outDir = positional[1] ?? '.status';
const historyDir = flags['--history'];
const alarmsFile = flags['--alarms'];
const rssFile = flags['--rss'];

if (!snapFile) {
  console.error('usage: node scripts/status-page.mjs <snapshot.json> [outdir] [--history <snapshotsDir>] [--alarms <file>] [--rss <file>]');
  process.exit(1);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtUsd(v) {
  if (!Number.isFinite(v) || v === 0) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPx(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return esc(v);
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(n);
}

const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
const dexs = snap.dexs.filter((d) => !d.error).sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);
const totalVol = dexs.reduce((s, d) => s + d.dayVolumeUsd, 0);
const totalAssets = dexs.reduce((s, d) => s + d.assetCount, 0);
const liveAssets = dexs.reduce((s, d) => s + d.liveAssetCount, 0);

// 逐市场分级（墓志铭 DEX 的市场跳过——归考古区，不进活市场分级）
let tombstoned = new Map();
let historyNote = 'no history provided — tombstone classification disabled';
if (historyDir && fs.existsSync(historyDir)) {
  // 只解析窗口内的快照：30 天保留 ≈1440 个文件（~240MB），逐次全量解析会随历史线性恶化
  const files = fs.readdirSync(historyDir).filter((f) => /^snapshot-.*\.json$/.test(f)).sort().slice(-TOMBSTONE_WINDOW);
  const snaps = files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
  tombstoned = tombstoneDexs(snaps);
  historyNote = `${snaps.length} snapshots in window (~${(snaps.length / 2).toFixed(0)}h)`;
}
const tombNames = [...tombstoned.keys()].sort();

const reds = [], yellows = [], traps = [], missingRows = [];
const whiteByDex = new Map(); // dex -> { count, maxAsset, maxDev }
for (const d of dexs) {
  if (tombstoned.has(d.dex)) continue;
  for (const a of d.assets) {
    const c = classify(a);
    const row = { dex: d.dex, asset: a.asset, ...c, volUsd: parseFloat(a.dayNtlVlm ?? '0') || 0, oraclePx: a.oraclePx, markPx: a.markPx };
    if (c.grade === 'red') reds.push(row);
    else if (c.grade === 'yellow') yellows.push(row);
    else if (c.grade === 'trap') traps.push(row);
    else if (c.grade === 'missing') missingRows.push(row);
    else {
      const w = whiteByDex.get(d.dex) ?? { count: 0, maxAsset: null, maxDev: 0 };
      w.count++;
      if (c.devBps !== null && c.devBps > w.maxDev) { w.maxDev = c.devBps; w.maxAsset = a.asset; }
      whiteByDex.set(d.dex, w);
    }
  }
}
const byWeight = (x, y) => (x.notionalUsd * x.devBps ?? 0) - (y.notionalUsd * y.devBps ?? 0);
reds.sort((a, b) => byWeight(b, a));
yellows.sort((a, b) => byWeight(b, a));
traps.sort((a, b) => (b.notionalUsd ?? 0) - (a.notionalUsd ?? 0));

// —— 表格行构造 ——
function riskRow(r, cls) {
  return `<tr class="${cls}"><td>${esc(r.asset)}</td><td class="num">${r.devBps !== null ? r.devBps.toFixed(1) : '—'}</td><td class="num">${fmtUsd(r.notionalUsd)}</td><td class="num">${fmtUsd(r.volUsd)}</td><td>${esc(r.reason)}</td></tr>`;
}

const riskRows = [...reds.map((r) => riskRow(r, 'crit')), ...yellows.map((r) => riskRow(r, 'warn'))].join('\n');
const riskTable = riskRows
  ? `<table><thead><tr><th>market</th><th>oracle↔mark</th><th>est. OI notional</th><th>24h vol</th><th>observation</th></tr></thead><tbody>${riskRows}</tbody></table>`
  : '<p class="empty">No live market crosses the observation thresholds right now.</p>';

const trapRows = traps.map((r) => `<tr class="warn"><td>${esc(r.asset)}</td><td class="num">${r.devBps !== null ? r.devBps.toFixed(1) : '—'}</td><td class="num">${fmtUsd(r.notionalUsd)}</td><td class="num">${fmtUsd(r.volUsd)}</td><td>${esc(r.reason)}</td></tr>`).join('\n');
const trapBlock = traps.length
  ? `<section class="zone"><h2>Trapped <span class="meta">24h vol &lt; ${fmtUsd(TRAP_VOL_USD)} but open interest &gt; 0 — positions in place, no fresh prints. Not abandonment; the pre-incident shape.</span></h2>
  <table><thead><tr><th>market</th><th>oracle↔mark</th><th>est. OI notional</th><th>24h vol</th><th>observation</th></tr></thead><tbody>${trapRows}</tbody></table></section>`
  : '';

const tombRows = tombNames.map((name) => {
  const t = tombstoned.get(name);
  return `<div class="tomb"><strong>${esc(name)}</strong> max dev ${(t.maxDevBps / 100).toFixed(2)}% <span class="meta">(${t.seen} consecutive snapshots)</span></div>`;
}).join('');
const tombBlock = tombNames.length
  ? `<section class="zone tombzone"><h2>Archaeology <span class="meta">every market across ${esc(historyNote)}: no open interest, 24h vol &lt; ${fmtUsd(TRAP_VOL_USD)} — single-snapshot zero does NOT imply abandoned</span></h2>
  <div class="tombgrid">${tombRows}</div>
  <p class="zonefoot">These are not alarms — they are the page's own thesis visualized: ${tombNames.length}/${dexs.length} deployers stopped operating. Max dev shown is archaeological, not actionable.</p></section>`
  : `<section class="zone tombzone"><h2>Archaeology</h2><p class="empty">${esc(historyNote)} — need ≥ ${TOMBSTONE_MIN_SNAPSHOTS} consecutive low-activity snapshots to classify a DEX as dormant.</p></section>`;

const missingBlock = missingRows.length
  ? `<section class="zone"><h2>Data missing <span class="meta">excluded from all grading — bad data must not become a false alarm or a false tombstone</span></h2>
  <table><thead><tr><th>market</th><th>problem</th></tr></thead><tbody>${missingRows.map((r) => `<tr class="dead"><td>${esc(r.dex)}:${esc(r.asset)}</td><td>${esc(r.reason)}</td></tr>`).join('')}</tbody></table></section>`
  : '';

const whiteRows = dexs
  .filter((d) => whiteByDex.has(d.dex))
  .map((d) => {
    const w = whiteByDex.get(d.dex);
    return `<tr><td>${esc(d.dex)}</td><td class="num">${w.count}</td><td class="num">${w.maxAsset ? `${esc(w.maxAsset)} (${w.maxDev.toFixed(1)}bps)` : '—'}</td></tr>`;
  }).join('\n');
const whiteBlock = whiteRows
  ? `<details class="whitedetails"><summary>Below-threshold markets by DEX (${whiteByDex.size} DEXs, aggregated)</summary>
  <table><thead><tr><th>DEX</th><th>markets below threshold</th><th>largest deviation among them</th></tr></thead><tbody>${whiteRows}</tbody></table>
  <p class="zonefoot">Full per-asset detail: expand the per-DEX sections below.</p></details>`
  : '';

// —— 每 DEX 全量明细（折叠，供核对全量） ——
const dexBlocks = dexs.map((d) => {
  const rows = d.assets
    .map((a) => ({ a, dev: deviationBps(a.oraclePx, a.markPx) ?? 0 }))
    .sort((x, y) => y.dev - x.dev);
  const updater = d.oracleUpdater ? esc(d.oracleUpdater.slice(0, 8) + '…') : '<em>self</em>';
  const body = rows.map(({ a }) => {
    // 偏离统一由 radar-core 重算（与分级同源），不读快照存储字段，避免双源漂移
    const bps = deviationBps(a.oraclePx, a.markPx);
    const oi = parseFloat(a.openInterest ?? '0');
    const c = classify(a);
    const cls = { red: 'crit', yellow: 'warn', trap: 'warn', missing: 'dead', white: oi > 0 ? 'ok' : 'dead' }[c.grade];
    return `<tr class="${cls}"><td>${esc(a.asset)}</td><td class="num">${fmtPx(a.oraclePx)}</td><td class="num">${fmtPx(a.markPx)}</td><td class="num">${bps !== null ? (bps / 100).toFixed(2) + '%' : '—'}</td><td class="num">${oi > 0 ? oi.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0'}</td><td class="num">${fmtUsd(parseFloat(a.dayNtlVlm ?? '0'))}</td></tr>`;
  }).join('\n');
  return `<details class="dexdetails"><summary>${esc(d.dex)} <span class="meta">deployer ${esc((d.deployer ?? '').slice(0, 8) + '…')} · updater ${updater} · live ${d.liveAssetCount}/${d.assetCount} · 24h ${fmtUsd(d.dayVolumeUsd)} · max dev ${(d.maxDeviationBps / 100).toFixed(2)}%</span></summary>
  <table><thead><tr><th>asset</th><th>oracle</th><th>mark</th><th>dev</th><th>OI</th><th>24h vol</th></tr></thead><tbody>${body}</tbody></table></details>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HIP-3 Oracle Risk Radar — live</title>
<style>
:root { color-scheme: light; }
body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a2e; background: #fafafa; margin: 0; padding: 2rem; max-width: 72rem; margin-inline: auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
.sub { color: #555; margin-bottom: 1rem; }
.summary { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0 2rem; }
.card { background: #fff; border: 1px solid #e3e3ec; border-radius: 8px; padding: .75rem 1.1rem; min-width: 7rem; }
.card .v { font-size: 1.3rem; font-weight: 600; }
.card .k { font-size: .75rem; color: #666; text-transform: uppercase; letter-spacing: .04em; }
section.zone { background: #fff; border: 1px solid #e3e3ec; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
section.tombzone { background: #f4f3ef; }
h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
h2 .meta { font-size: .78rem; font-weight: 400; color: #666; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #f0f0f5; }
th { font-size: .72rem; text-transform: uppercase; color: #888; letter-spacing: .04em; }
td.num { text-align: right; }
tr.crit td { background: #fdf0ef; }
tr.warn td { background: #fdf8ec; }
.badge { font-size: .7rem; font-weight: 700; padding: .1rem .45rem; border-radius: 999px; letter-spacing: .03em; }
.badge.crit { background: #f8d7d5; color: #b03028; }
.badge.warn { background: #fbeec9; color: #91660a; }
.empty { color: #777; font-size: .9rem; margin: .4rem 0; }
.tombgrid { display: flex; gap: .75rem; flex-wrap: wrap; }
.tomb { background: #fff; border: 1px solid #e3e3ec; border-radius: 6px; padding: .4rem .7rem; font-size: .85rem; }
.tomb .meta { color: #888; font-size: .72rem; }
.zonefoot { font-size: .78rem; color: #666; margin: .8rem 0 0; line-height: 1.6; }
details.dexdetails, details.whitedetails { background: #fff; border: 1px solid #e3e3ec; border-radius: 8px; padding: .7rem 1.1rem; margin-bottom: .7rem; }
details summary { cursor: pointer; font-weight: 600; }
details summary .meta { font-weight: 400; font-size: .78rem; color: #666; }
.note { font-size: .8rem; color: #666; margin-top: 2rem; line-height: 1.6; }
a { color: #4a3fbf; }
</style></head><body>
<h1>HIP-3 Oracle Risk Radar</h1>
<div class="sub">Observational view of every HIP-3 perp DEX oracle vs mark price on Hyperliquid · one question: where does real open interest sit against a misbehaving feed? · generated <strong>${esc(snap.sampledAt)}</strong> (UTC) · refreshed every 30 min via workflow_dispatch (external cron scheduler)</div>
<div class="summary">
  <div class="card"><div class="v">${fmtUsd(totalVol)}</div><div class="k">24h volume</div></div>
  <div class="card"><div class="v" style="color:#b03028">${reds.length}</div><div class="k">red markets</div></div>
  <div class="card"><div class="v" style="color:#91660a">${yellows.length}</div><div class="k">on watchlist</div></div>
  <div class="card"><div class="v" style="color:#91660a">${traps.length}</div><div class="k">trapped</div></div>
  <div class="card"><div class="v" style="color:#888">${tombNames.length}/${dexs.length}</div><div class="k">dormant dexs</div></div>
</div>

<section class="zone">
<h2>Live markets · OI-weighted deviation anomalies <span class="meta">red first, then watchlist · sorted by notional × deviation</span></h2>
${riskTable}
</section>
${trapBlock}
${tombBlock}
${missingBlock}
${whiteBlock}
<h2 style="margin-top:2rem">Full per-DEX detail</h2>
${dexBlocks}
<div class="note">
<p><strong>This page is observational.</strong> "OI-weighted deviation" ranks attention — where large open interest sits against a deviating feed. It is <em>not</em> a liquidation-loss estimate; no conclusion about harm can be drawn from this data alone.</p>
<p><strong>Method</strong> — deviation = |oracle − mark| / mark (Hyperliquid public API). Estimated OI notional = open interest (base units: shares for equities, index units for indices) × mark. Grading: <strong>red</strong> = dev ≥ ${RED_DEV_BPS}bps and notional &gt; ${fmtUsd(RED_OI_USD)}; <strong>watchlist</strong> = dev ≥ ${YELLOW_DEV_BPS}bps, or notional &gt; ${fmtUsd(YELLOW_OI_USD)} with dev ≥ ${YELLOW_OI_DEV_BPS}bps (red takes precedence; watchlist excludes red); <strong>trapped</strong> = 24h vol &lt; ${fmtUsd(TRAP_VOL_USD)} with OI &gt; 0; <strong>dormant (DEX-level)</strong> = every market across the last ${TOMBSTONE_WINDOW} snapshots (~48h) with OI = 0 and vol &lt; ${fmtUsd(TRAP_VOL_USD)} (min ${TOMBSTONE_MIN_SNAPSHOTS} snapshots; a single zero snapshot implies nothing). Markets with missing/invalid fields are excluded from all grading and listed separately. These are page-specific observation thresholds — not execution guard thresholds; see the library's <code>deviation</code> module (warn 100 / critical 500 bps) for guard semantics.</p>
<p><strong>What this page cannot show</strong> — staleness (the snapshot API does not expose feed update timestamps; the <a href="https://github.com/imokokok/hip3-oracle-guard">library</a> detects it via oracle-change differential in <code>monitor.mjs</code>) and discovery-band position (the protocol's band anchor is not exposed; see the library's <code>bounds</code> module). Deviation vs mark is the honest subset of the full guard set. Machine-readable alarms: <a href="./alarms.jsonl">alarms.jsonl</a> · <a href="./feed.xml">RSS</a>.</p>
<p>Generated by <a href="https://github.com/imokokok/hip3-oracle-guard">hip3-oracle-guard</a> · read-only · zero keys · MIT.</p>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'index.html');
fs.writeFileSync(out, html);

// 机器可读告警（红/黄/陷阱），供 RSS 与后续订阅消费
const alarmRows = [...reds, ...yellows, ...traps].map((r) => ({
  ts: snap.sampledAt,
  dex: r.dex,
  asset: r.asset,
  grade: r.grade,
  devBps: r.devBps !== null ? Math.round(r.devBps * 10) / 10 : null,
  notionalUsd: r.notionalUsd !== null ? Math.round(r.notionalUsd) : null,
  volUsd: Math.round(r.volUsd),
  reason: r.reason,
}));
if (alarmsFile) {
  fs.writeFileSync(alarmsFile, alarmRows.map((r) => JSON.stringify(r)).join('\n') + (alarmRows.length ? '\n' : ''));
}
if (rssFile) {
  const items = alarmRows.slice(0, 50).map((r) => `  <item><title>${esc(`[${r.grade.toUpperCase()}] ${r.asset}`)}</title><description>${esc(r.reason)}</description><guid>${esc(`${r.asset}-${r.ts}`)}</guid><pubDate>${new Date(r.ts).toUTCString()}</pubDate></item>`).join('\n');
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>HIP-3 Oracle Risk Radar</title>
  <link>https://imokokok.github.io/hip3-oracle-guard/</link>
  <description>Observational alarms: OI-weighted deviation anomalies on HIP-3 perp oracle feeds (not liquidation-loss estimates)</description>
  <lastBuildDate>${new Date(snap.sampledAt).toUTCString()}</lastBuildDate>
${items}
</channel></rss>`;
  fs.writeFileSync(rssFile, rss);
}

console.log(`# radar page written: ${out} (${totalAssets} assets: ${reds.length} red / ${yellows.length} yellow / ${traps.length} trap / ${missingRows.length} missing / ${tombNames.length}/${dexs.length} dormant dexs)`);
