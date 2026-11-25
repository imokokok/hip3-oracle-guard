// bounds：Discovery Bounds 校验。
// 机制（DataWallet 对 Trade.xyz 公开机制的整理 + HIP-3 文档）：
//   - 休市期间标记价格被限制在参考价 ±(1/maxLeverage) 的带内；
//     10x 市场即 ±10%。清算价落在带外的仓位不会被清算。
//   - Bounds v2：oracle 走到带边缘的 90% 距离时 re-anchor 到新参考，
//     每个方向的重锚次数有限（如 WTIOIL 两次重锚 ≈ 周末最多漂移 ±15.8%）。
// 守卫语义：接近 band 边缘本身就是最高级别风险信号（SK Hynix 事故中标记价被打到 bound）。

import type { Severity, GuardResult } from './types.js';

export interface BoundsConfig {
  /** 市场最大杠杆。band 半宽 = 1/maxLeverage。 */
  maxLeverage: number;
  /** 触达带边缘多大比例时触发 re-anchor 判定，默认 0.9（Bounds v2 参照值）。 */
  reAnchorThreshold?: number;
  /**
   * 参考价是否为近似值（如用 markPx / prevDayPx 替代协议真实 band anchor）。
   * 显式声明近似后，库会保守降级：critical 一律降为 warn 并在 reason 标注，
   * 因为"出带"判定建立在估计的锚上，虚报 critical 比漏报更伤守卫可信度。
   */
  referenceApproximate?: boolean;
}

export interface BoundsCheck extends GuardResult {
  /** band 半宽（相对参考价的比例，1/maxLeverage）。 */
  bandHalfWidth: number;
  /** band 上下沿（绝对价格）。 */
  lowerEdgePx: number;
  upperEdgePx: number;
  /** oracle 相对参考价在带内的位置比例：0=中心，1=恰好触边，>1=已出带。 */
  edgeProgress: number;
  /** 按 Bounds v2 语义，是否应 re-anchor（edgeProgress ≥ reAnchorThreshold）。 */
  reAnchorDue: boolean;
  /** 清算价是否在带外（带外的仓位不会被清算——该状态下标记价是安全的）。 */
  liquidationPriceOutsideBand: boolean | undefined;
  /** 参考价是否为近似值（见 BoundsConfig.referenceApproximate）。 */
  referenceApproximate: boolean;
}

export function assessBounds(
  oraclePx: number,
  referencePx: number,
  liquidationPricePx: number | undefined,
  config: BoundsConfig,
): BoundsCheck {
  const threshold = config.reAnchorThreshold ?? 0.9;
  const approximate = config.referenceApproximate ?? false;
  const bandHalfWidth = 1 / config.maxLeverage;
  const lowerEdgePx = referencePx * (1 - bandHalfWidth);
  const upperEdgePx = referencePx * (1 + bandHalfWidth);
  const edgeProgress = referencePx > 0 ? Math.abs(oraclePx - referencePx) / (referencePx * bandHalfWidth) : Number.POSITIVE_INFINITY;
  const reAnchorDue = edgeProgress >= threshold;
  const liquidationPriceOutsideBand =
    liquidationPricePx !== undefined
      ? liquidationPricePx < lowerEdgePx || liquidationPricePx > upperEdgePx
      : undefined;

  const approxNote = approximate ? ' (approximate reference — verify with true band anchor)' : '';

  let severity: Severity = 'ok';
  let reason = `oracle within band: edge progress ${(edgeProgress * 100).toFixed(1)}% of ±${(bandHalfWidth * 100).toFixed(1)}% band${approxNote}`;
  if (edgeProgress > 1) {
    severity = 'critical';
    reason = `oracle ${oraclePx} outside discovery band [${lowerEdgePx.toFixed(4)}, ${upperEdgePx.toFixed(4)}] — mark price bound should be active, investigate immediately${approxNote}`;
  } else if (reAnchorDue) {
    severity = 'critical';
    reason = `oracle at ${(edgeProgress * 100).toFixed(1)}% of band edge (≥ threshold ${threshold * 100}%) — re-anchor imminent, weekend drift risk (cf. Bounds v2)${approxNote}`;
  } else if (edgeProgress >= 0.5) {
    severity = 'warn';
    reason = `oracle at ${(edgeProgress * 100).toFixed(1)}% of band edge — elevated bound risk${approxNote}`;
  }

  // 近似参考价下保守降级：出带/re-anchor 判定建立在估计的锚上，不虚报 critical。
  if (approximate && severity === 'critical') {
    severity = 'warn';
    reason = `[downgraded from critical: approximate reference] ${reason}`;
  }

  return { bandHalfWidth, lowerEdgePx, upperEdgePx, edgeProgress, reAnchorDue, liquidationPriceOutsideBand, referenceApproximate: approximate, severity, reason };
}
