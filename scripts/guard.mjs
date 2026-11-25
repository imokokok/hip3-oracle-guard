#!/usr/bin/env node
// guard.mjs — 守卫库对真实生态的实时体检（零运行时依赖；TS 产物从 dist 导入）。
//
// 对全部 HIP-3 DEX 的每个活跃资产跑 deviation + bounds 守卫，输出分级告警。
// 用法：npm run build && node scripts/guard.mjs
//
// 注：bounds 的参考价以 markPx 近似（协议的真实 band anchor 不可从快照 API 取得）；
//     staleness 需要喂价更新时间戳，快照 API 不提供，留待 WS 差分实现。

import {
  assessDeviation,
  assessBounds,
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
      const maxLeverage = u?.maxLeverage ?? 20;

      const dev = assessDeviation(oracle, mark, {});
      const bounds = assessBounds(mark, mark, undefined, { maxLeverage });

      const worst = dev.severity === 'critical' || bounds.severity === 'critical'
        ? 'critical'
        : dev.severity === 'warn' || bounds.severity === 'warn'
          ? 'warn'
          : 'ok';
      if (worst !== 'ok') {
        alarms.push({
          dex: dex.name,
          asset: u?.name,
          severity: worst,
          oracle,
          mark,
          oi: parseFloat(c.openInterest ?? '0'),
          detail: [dev.severity !== 'ok' ? dev.reason : null, bounds.severity !== 'ok' ? bounds.reason : null]
            .filter(Boolean)
            .join(' | '),
        });
      }
    }
  }

  alarms.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1) || b.oi - a.oi);
  console.log(`# hip3-oracle-guard live check ${new Date().toISOString()}`);
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
