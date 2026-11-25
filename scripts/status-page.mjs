#!/usr/bin/env node
// status-page.mjs — 从喂价快照生成 GitHub Pages 静态状态页（零依赖）。
//
// 页面 = 全部 HIP-3 perp DEX 的喂价健康度公开视图：
//   per-DEX 汇总（deployer / updater / 活跃资产数 / 24h 量 / 最大偏离）+
//   per-asset 明细（oracle/mark/偏离/OI/量，按库的 deviation 阈值分级）。
// 分级语义与 src/deviation.ts 一致：warn 100bps，critical 500bps。
//
// 用法：node scripts/status-page.mjs <snapshot.json> [outdir]
// 输出：<outdir>/index.html

import fs from 'node:fs';
import path from 'node:path';

const WARN_BPS = 100;
const CRIT_BPS = 500;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sev(bps, oi) {
  if (!Number.isFinite(bps)) return 'n/a';
  if (bps > CRIT_BPS) return 'critical';
  if (bps > WARN_BPS) return 'warn';
  return 'ok';
}

function fmtUsd(v) {
  if (!Number.isFinite(v) || v === 0) return '—';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPx(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return esc(v);
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(n);
}

const [snapFile, outDir = '.status'] = process.argv.slice(2);
if (!snapFile) {
  console.error('usage: node scripts/status-page.mjs <snapshot.json> [outdir]');
  process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));

const dexs = snap.dexs.filter((d) => !d.error).sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);
const totals = {
  dex: dexs.length,
  assets: dexs.reduce((s, d) => s + d.assetCount, 0),
  live: dexs.reduce((s, d) => s + d.liveAssetCount, 0),
  vol: dexs.reduce((s, d) => s + d.dayVolumeUsd, 0),
  crit: 0, warn: 0, ok: 0,
};
for (const d of dexs) for (const a of d.assets) {
  const bps = parseFloat(a.deviationBps ?? 'NaN');
  const oi = parseFloat(a.openInterest ?? '0');
  const s = oi > 0 ? sev(bps, oi) : null;
  if (s === 'critical') totals.crit++;
  else if (s === 'warn') totals.warn++;
  else if (s === 'ok') totals.ok++;
}

const dexBlocks = dexs.map((d) => {
  const assets = [...d.assets].sort((a, b) => (parseFloat(b.deviationBps ?? '0')) - (parseFloat(a.deviationBps ?? '0')));
  const rows = assets.map((a) => {
    const bps = parseFloat(a.deviationBps ?? 'NaN');
    const oi = parseFloat(a.openInterest ?? '0');
    const s = oi > 0 ? sev(bps, oi) : 'dead';
    const cls = { ok: 'ok', warn: 'warn', critical: 'crit', dead: 'dead', 'n/a': 'dead' }[s];
    const label = { ok: 'OK', warn: 'WARN', critical: 'CRITICAL', dead: 'NO OI', 'n/a': 'N/A' }[s];
    return `<tr class="${cls}"><td>${esc(a.asset)}</td><td class="num">${fmtPx(a.oraclePx)}</td><td class="num">${fmtPx(a.markPx)}</td><td class="num">${Number.isFinite(bps) ? (bps / 100).toFixed(2) + '%' : '—'}</td><td class="num">${oi > 0 ? oi.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0'}</td><td class="num">${fmtUsd(parseFloat(a.dayNtlVlm ?? '0'))}</td><td><span class="badge ${cls}">${label}</span></td></tr>`;
  }).join('\n');
  const updater = d.oracleUpdater ? esc(d.oracleUpdater.slice(0, 8) + '…') : '<em>self</em>';
  return `<section class="dex">
  <h2>${esc(d.dex)} <span class="meta">deployer ${esc((d.deployer ?? '').slice(0, 8) + '…')} · updater ${updater} · live ${d.liveAssetCount}/${d.assetCount} · 24h ${fmtUsd(d.dayVolumeUsd)} · max dev ${(d.maxDeviationBps / 100).toFixed(2)}%</span></h2>
  <table><thead><tr><th>asset</th><th>oracle</th><th>mark</th><th>dev</th><th>OI</th><th>24h vol</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table></section>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HIP-3 Oracle Feed Health — live</title>
<style>
:root { color-scheme: light; }
body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a2e; background: #fafafa; margin: 0; padding: 2rem; max-width: 72rem; margin-inline: auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
.sub { color: #555; margin-bottom: 1rem; }
.summary { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0 2rem; }
.card { background: #fff; border: 1px solid #e3e3ec; border-radius: 8px; padding: .75rem 1.1rem; min-width: 7rem; }
.card .v { font-size: 1.3rem; font-weight: 600; }
.card .k { font-size: .75rem; color: #666; text-transform: uppercase; letter-spacing: .04em; }
section.dex { background: #fff; border: 1px solid #e3e3ec; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
h2 { font-size: 1.05rem; margin: 0 0 .6rem; }
h2 .meta { font-size: .78rem; font-weight: 400; color: #666; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #f0f0f5; }
th { font-size: .72rem; text-transform: uppercase; color: #888; letter-spacing: .04em; }
td.num { text-align: right; }
tr.crit td { background: #fdf0ef; }
tr.warn td { background: #fdf8ec; }
.badge { font-size: .7rem; font-weight: 700; padding: .1rem .45rem; border-radius: 999px; letter-spacing: .03em; }
.badge.ok { background: #e7f5ec; color: #1a7f4b; }
.badge.warn { background: #fbeeC9; color: #91660a; }
.badge.crit { background: #f8d7d5; color: #b03028; }
.badge.dead { background: #eee; color: #888; }
.note { font-size: .8rem; color: #666; margin-top: 2rem; line-height: 1.6; }
a { color: #4a3fbf; }
</style></head><body>
<h1>HIP-3 Oracle Feed Health</h1>
<div class="sub">Live snapshot of every HIP-3 perp DEX oracle vs mark price on Hyperliquid · generated <strong>${esc(snap.sampledAt)}</strong> (UTC) · refreshed every 30 min</div>
<div class="summary">
  <div class="card"><div class="v">${totals.dex}</div><div class="k">DEXs</div></div>
  <div class="card"><div class="v">${totals.live}<span style="color:#999;font-size:.8rem">/${totals.assets}</span></div><div class="k">live assets</div></div>
  <div class="card"><div class="v" style="color:#b03028">${totals.crit}</div><div class="k">critical dev</div></div>
  <div class="card"><div class="v" style="color:#91660a">${totals.warn}</div><div class="k">warn dev</div></div>
  <div class="card"><div class="v">${fmtUsd(totals.vol)}</div><div class="k">24h volume</div></div>
</div>
${dexBlocks}
<div class="note">
<p><strong>Semantics</strong> — deviation = |oracle − mark| / mark. Thresholds mirror <code>hip3-oracle-guard</code>'s <code>deviation</code> module: warn &gt; 100 bps, critical &gt; 500 bps, applied only to assets with open interest &gt; 0 (NO OI = market with no open positions; many of these are abandoned — see the <a href="https://github.com/imokokok/hip3-oracle-guard/blob/main/research/VALIDATION-REPORT.md">validation report</a>: 7/10 HIP-3 DEXs stalled, deviations up to 48%).</p>
<p><strong>What this page cannot show</strong> — staleness (the snapshot API does not expose feed update timestamps; the <a href="https://github.com/imokokok/hip3-oracle-guard">library</a> detects it via oracle-change differential in <code>monitor.mjs</code>) and discovery-band position (the protocol's band anchor is not exposed; see the library's <code>bounds</code> module for the guard semantics). Deviation vs mark is the honest subset of the full guard set.</p>
<p>Generated by <a href="https://github.com/imokokok/hip3-oracle-guard">hip3-oracle-guard</a> · read-only · zero keys · MIT.</p>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'index.html');
fs.writeFileSync(out, html);
console.log(`# status page written: ${out} (${totals.dex} dexs, ${totals.crit} crit / ${totals.warn} warn on live assets)`);
