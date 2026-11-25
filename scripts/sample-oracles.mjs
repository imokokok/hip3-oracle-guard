#!/usr/bin/env node
// sample-oracles.mjs — HIP-3 全生态喂价采样器（零依赖、只读、零密钥）。
//
// 用途：对全部 HIP-3 perp DEX 抓取一次喂价快照（oracle/mark/偏离/OI/交易量），
// 输出带时间戳的 JSON 快照，供连续采样与偏离分布分析。
// 这就是 hip3-oracle-guard monitor 模块的最小种子。
//
// 用法：
//   node scripts/sample-oracles.mjs                 # 打印摘要到 stdout
//   node scripts/sample-oracles.mjs --save [dir]    # 追加写入快照文件（默认 research/snapshots）
//
// 定时连续采样示例（crontab，每 5 分钟）：
//   */5 * * * * cd /path/to/hip3-oracle-guard && node scripts/sample-oracles.mjs --save

const INFO_URL = 'https://api.hyperliquid.xyz/info';

async function info(body) {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`info ${JSON.stringify(body)} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const save = process.argv.includes('--save');
  const outDirIdx = process.argv.indexOf('--save');
  const outDir = save && process.argv[outDirIdx + 1] && !process.argv[outDirIdx + 1].startsWith('-')
    ? process.argv[outDirIdx + 1]
    : 'research/snapshots';

  const dexList = (await info({ type: 'perpDexs' })).filter((x) => x);
  const snapshot = { sampledAt: new Date().toISOString(), dexs: [] };

  for (const dex of dexList) {
    const dexName = dex.name;
    let meta, ctxs;
    try {
      [meta, ctxs] = await info({ type: 'metaAndAssetCtxs', dex: dexName });
    } catch (e) {
      snapshot.dexs.push({ dex: dexName, error: e.message });
      continue;
    }
    const universe = meta?.universe ?? [];
    const assets = [];
    for (let i = 0; i < Math.min(ctxs?.length ?? 0, universe.length); i++) {
      const c = ctxs[i];
      const oracle = parseFloat(c.oraclePx);
      const mark = parseFloat(c.markPx);
      const entry = {
        asset: universe[i]?.name,
        oraclePx: c.oraclePx,
        markPx: c.markPx,
        openInterest: c.openInterest,
        dayNtlVlm: c.dayNtlVlm,
        funding: c.funding,
      };
      if (Number.isFinite(oracle) && Number.isFinite(mark) && mark !== 0) {
        entry.deviationBps = Math.abs(oracle - mark) / mark * 10000;
      }
      assets.push(entry);
    }
    const live = assets.filter((a) => parseFloat(a.openInterest ?? '0') > 0);
    snapshot.dexs.push({
      dex: dexName,
      deployer: dex.deployer,
      oracleUpdater: dex.oracleUpdater,
      assetCount: assets.length,
      liveAssetCount: live.length,
      dayVolumeUsd: assets.reduce((s, a) => s + parseFloat(a.dayNtlVlm ?? '0'), 0),
      maxDeviationBps: Math.max(0, ...assets.map((a) => a.deviationBps ?? 0)),
      assets,
    });
  }

  // 摘要
  console.log(`# HIP-3 oracle snapshot ${snapshot.sampledAt}`);
  for (const d of snapshot.dexs) {
    if (d.error) { console.log(`${d.dex}: ERROR ${d.error}`); continue; }
    const vol = (d.dayVolumeUsd / 1e6).toFixed(1);
    console.log(
      `${d.dex}: assets=${d.assetCount} live=${d.liveAssetCount} vol=${vol}M maxDev=${(d.maxDeviationBps / 100).toFixed(2)}% updater=${d.oracleUpdater ?? 'self'}`,
    );
  }

  if (save) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `snapshot-${snapshot.sampledAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    console.log(`# saved: ${file}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
