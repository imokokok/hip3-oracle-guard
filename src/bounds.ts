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
}

export function assessBounds(
  oraclePx: number,
  referencePx: number,
  liquidationPricePx: number | undefined,
  config: BoundsConfig,
): BoundsCheck {
  const threshold = config.reAnchorThreshold ?? 0.9;
  const bandHalfWidth = 1 / config.maxLeverage;
  const lowerEdgePx = referencePx * (1 - bandHalfWidth);
  const upperEdgePx = referencePx * (1 + bandHalfWidth);
  const edgeProgress = referencePx > 0 ? Math.abs(oraclePx - referencePx) / (referencePx * bandHalfWidth) : Number.POSITIVE_INFINITY;
  const reAnchorDue = edgeProgress >= threshold;
  const liquidationPriceOutsideBand =
    liquidationPricePx !== undefined
      ? liquidationPricePx < lowerEdgePx || liquidationPricePx > upperEdgePx
      : undefined;

  let severity: Severity = 'ok';
  let reason = `oracle within band: edge progress ${(edgeProgress * 100).toFixed(1)}% of ±${(bandHalfWidth * 100).toFixed(1)}% band`;
  if (edgeProgress > 1) {
    severity = 'critical';
    reason = `oracle ${oraclePx} outside discovery band [${lowerEdgePx.toFixed(4)}, ${upperEdgePx.toFixed(4)}] — mark price bound should be active, investigate immediately`;
  } else if (reAnchorDue) {
    severity = 'critical';
    reason = `oracle at ${(edgeProgress * 100).toFixed(1)}% of band edge (≥ threshold ${threshold * 100}%) — re-anchor imminent, weekend drift risk (cf. Bounds v2)`;
  } else if (edgeProgress >= 0.5) {
    severity = 'warn';
    reason = `oracle at ${(edgeProgress * 100).toFixed(1)}% of band edge — elevated bound risk`;
  }

  return { bandHalfWidth, lowerEdgePx, upperEdgePx, edgeProgress, reAnchorDue, liquidationPriceOutsideBand, severity, reason };
}
