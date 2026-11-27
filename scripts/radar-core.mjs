// radar-core.mjs — 风险雷达分级核心（纯函数、零依赖）。
//
// 指标定性：OI 加权偏离是**观察性指标**，用于注意力排序——
// 它回答"哪里有大敞口正对着喂价异常"，不回答"会清算多少"。
// 页面文案一律观察性语言，禁止清算结论。
//
// 阈值溯源（诚实声明）：本模块的 20/15/10bps 与 $100M/$250M 是状态页
// 自设的观察阈值，为排版和注意力分配服务。它们与 src/deviation.ts 的
// guard 阈值（warn 100 / critical 500bps）无关，与其他系统的执行前
// 阈值（如 100bps 提醒 / 1000bps 阻断）也无关，不得混用。
// 规格与修订记录：docs/RISK-RADAR-REDESIGN.md（r3 起）。

export const RED_DEV_BPS = 20;
export const RED_OI_USD = 100e6;
export const YELLOW_DEV_BPS = 15;
export const YELLOW_OI_USD = 250e6;
export const YELLOW_OI_DEV_BPS = 10;
/** 24h 成交低于该值视为"无新鲜成交"（陷阱判定）。 */
export const TRAP_VOL_USD = 5000;
/** 墓志铭窗口：连续 N 个快照（30 分钟采样 → 96 ≈ 48h）全部低活跃。 */
export const TOMBSTONE_WINDOW = 96;
/** 墓志铭最少需要的历史快照数，不足则不判死（数据不足 ≠ 死了）。 */
export const TOMBSTONE_MIN_SNAPSHOTS = 24;

const REQUIRED_FIELDS = ['oraclePx', 'markPx', 'openInterest', 'dayNtlVlm'];

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function deviationBps(oraclePx, markPx) {
  const o = num(oraclePx);
  const m = num(markPx);
  if (o === null || m === null || m === 0) return null;
  return Math.abs(o - m) / m * 10000;
}

// OI 名义估算：Hyperliquid assetCtxs.openInterest 以基础单位计
// （股票=股、指数=指数单位、商品=合约基础量），qty × markPx 即名义美元。
// 跨 asset 类别的单位校准是本页的主要工时项，见规格文档 §4。
export function notionalUsd(asset) {
  const qty = num(asset?.openInterest);
  const px = num(asset?.markPx);
  if (qty === null || px === null) return null;
  return qty * px;
}

// 单市场分级：missing > red > yellow > trap > white（互斥，先判缺失再判红）。
// 返回 { grade, devBps, notionalUsd, reason }；white 不进正文表，仅参与聚合。
export function classify(asset) {
  const missing = REQUIRED_FIELDS.filter((f) => num(asset?.[f]) === null);
  if (missing.length > 0) {
    return { grade: 'missing', devBps: null, notionalUsd: null, reason: `missing/invalid: ${missing.join(', ')}` };
  }
  const dev = deviationBps(asset.oraclePx, asset.markPx);
  const oi = num(asset.openInterest);
  const vol = num(asset.dayNtlVlm);
  const notional = oi * num(asset.markPx);

  if (dev >= RED_DEV_BPS && notional > RED_OI_USD) {
    return { grade: 'red', devBps: dev, notionalUsd: notional, reason: `OI-weighted deviation anomaly: ${dev.toFixed(1)}bps on $${roundM(notional)} notional — watch closely` };
  }
  // 黄名单是敞口观察：偏离条款要求 OI>0——没有人持仓的偏离不是风险，是噪音
  if (oi > 0 && (dev >= YELLOW_DEV_BPS || (notional > YELLOW_OI_USD && dev >= YELLOW_OI_DEV_BPS))) {
    const cause = dev >= YELLOW_DEV_BPS ? `deviation ${dev.toFixed(1)}bps` : `large notional $${roundM(notional)} with ${dev.toFixed(1)}bps`;
    return { grade: 'yellow', devBps: dev, notionalUsd: notional, reason: `on watchlist: ${cause}` };
  }
  if (vol < TRAP_VOL_USD && oi > 0) {
    return { grade: 'trap', devBps: dev, notionalUsd: notional, reason: `no fresh prints (24h vol $${vol.toFixed(0)}) but open interest remains (${oi.toLocaleString('en-US', { maximumFractionDigits: 2 })} units)` };
  }
  return { grade: 'white', devBps: dev, notionalUsd: notional, reason: '' };
}

// 墓志铭判定：连续窗口内每个快照里该 DEX 的全部市场都满足
// (OI=0 且 24h 量 < TRAP_VOL_USD)。任一快照缺席/出错/有活市场 → 不判死（保守）。
// snapshots：按时间升序（最后一个应为最新）。
export function tombstoneDexs(snapshots) {
  const win = (snapshots ?? []).slice(-TOMBSTONE_WINDOW);
  if (win.length < TOMBSTONE_MIN_SNAPSHOTS) return new Map();
  const names = new Set();
  for (const s of win) for (const d of s.dexs ?? []) if (!d.error) names.add(d.dex);
  const dead = new Map(); // dex -> { seen, maxDevBps }
  for (const name of names) {
    let seen = 0;
    let maxDev = 0;
    let alive = false;
    for (const s of win) {
      const d = (s.dexs ?? []).find((x) => x.dex === name);
      if (!d || d.error) { alive = true; break; }
      seen++;
      for (const a of d.assets ?? []) {
        const oi = num(a?.openInterest) ?? 0;
        const vol = num(a?.dayNtlVlm) ?? 0;
        if (oi > 0 || vol >= TRAP_VOL_USD) { alive = true; break; }
        maxDev = Math.max(maxDev, deviationBps(a?.oraclePx, a?.markPx) ?? 0);
      }
      if (alive) break;
    }
    if (!alive && seen >= TOMBSTONE_MIN_SNAPSHOTS) dead.set(name, { seen, maxDevBps: maxDev });
  }
  return dead;
}

function roundM(v) {
  return v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`;
}
