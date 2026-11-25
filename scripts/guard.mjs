#!/usr/bin/env node
// guard.mjs — 守卫库对真实生态的实时体检（零运行时依赖；TS 产物从 dist 导入）。
//
// 对全部 HIP-3 DEX 的每个活跃资产跑 deviation 守卫，输出分级告警。
// 用法：npm run build && node scripts/guard.mjs
//
// 注（诚实声明，2026-11-25 修订）：不再运行 bounds 检查——快照 API 不暴露协议
//     真实 band anchor，此前用 markPx 自比导致 edgeProgress 恒为 0（检查空转、
//     恒报 ok），属于虚假覆盖。bounds 守卫留给持有真实锚的调用方（见 offhours.ts）。
//     staleness 需要喂价更新时间戳，快照 API 不提供，由 monitor.mjs 差分实现覆盖。

import {
  assessDeviation,
} from '../dist/index.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

async function info(body) {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`info -> HTTP ${res.status}`);
  return res.json();
}

const LABEL = { ok: 'OK  ', warn: 'WARN', critical: 'CRIT' };
const alarms = [];

async function main() {
  const dexList = (await info({ type: 'perpDexs' })).filter((x) => x);

  for (const dex of dexList) {
    let meta, ctxs;
    try {
      [meta, ctxs] = await info({ type: 'metaAndAssetCtxs', dex: dex.name });
    } catch {
      continue;
    }
    const universe = meta?.universe ?? [];
    for (let i = 0; i < Math.min(ctxs?.length ?? 0, universe.length); i++) {
      const u = universe[i];
      const c = ctxs[i];
      const oracle = parseFloat(c.oraclePx);
      const mark = parseFloat(c.markPx);
      if (!Number.isFinite(oracle) || !Number.isFinite(mark) || mark <= 0) continue;

      const dev = assessDeviation(oracle, mark, {});
      if (dev.severity !== 'ok') {
        alarms.push({
          dex: dex.name,
          asset: u?.name,
          severity: dev.severity,
          oracle,
          mark,
          oi: parseFloat(c.openInterest ?? '0'),
          detail: dev.reason,
        });
      }
    }
  }

  alarms.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1) || b.oi - a.oi);
  console.log(`# hip3-oracle-guard live check ${new Date().toISOString()}`);
  console.log(`# checks: deviation only — bounds skipped (band anchor not exposed by snapshot API), staleness covered by monitor.mjs`);
  const crit = alarms.filter((a) => a.severity === 'critical').length;
  const warn = alarms.filter((a) => a.severity === 'warn').length;
  console.log(`# alarms: ${crit} critical, ${warn} warn\n`);
  for (const a of alarms) {
    console.log(`[${LABEL[a.severity]}] ${a.dex}:${a.asset} oracle=${a.oracle} mark=${a.mark} oi=${a.oi}`);
    console.log(`        ${a.detail}`);
  }
  if (alarms.length === 0) console.log('all clear — no alarms.');
}

main().catch((e) => { console.error(e); process.exit(1); });
