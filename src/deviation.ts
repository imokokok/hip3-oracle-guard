// deviation：oracle / mark / 外部参考的偏离守卫。
// 语义要点（SK Hynix 复盘：单笔薄市成交直接进了 oracle 输入）：
//   外部输入与多源参考的偏离必须分级告警；
//   另外协议层有两条硬线需要单独标记：
//     - 验证者对外部价较开盘 ±50% 触发自动审查（reviewThresholdBps）
//     - discovery bound 本身（见 bounds.ts）

import type { Severity, GuardResult } from './types.js';

export interface DeviationConfig {
  /** oracle vs mark 偏离超过该 bps 视为 warn，默认 100。 */
  warnBps?: number;
  /** oracle vs mark 偏离超过该 bps 视为 critical，默认 500。 */
  criticalBps?: number;
  /** 外部参考价偏离达到该 bps 标记为 reviewThresholdBreached，默认 5000（=50%，验证者自动审查线）。 */
  reviewThresholdBps?: number;
}

export interface DeviationCheck extends GuardResult {
  /** |oracle - mark| / mark，单位 bps。 */
  deviationBps: number;
  /** 外部参考价偏离（提供 externalRefPx 时才有）。 */
  externalDeviationBps?: number;
  /** 外部价偏离是否触及验证者自动审查阈值（±50%）。 */
  reviewThresholdBreached: boolean;
}

function bps(a: number, b: number): number {
  return Math.abs(a - b) / b * 10000;
}

export function assessDeviation(
  oraclePx: number,
  markPx: number,
  config: DeviationConfig = {},
  externalRefPx?: number,
): DeviationCheck {
  const warn = config.warnBps ?? 100;
  const crit = config.criticalBps ?? 500;
  const review = config.reviewThresholdBps ?? 5000;

  if (markPx <= 0) {
    return {
      severity: 'critical',
      reason: `invalid markPx ${markPx}`,
      deviationBps: Number.POSITIVE_INFINITY,
      reviewThresholdBreached: false,
    };
  }

  const deviationBps = bps(oraclePx, markPx);
  const externalDeviationBps =
    externalRefPx !== undefined && externalRefPx > 0 ? bps(externalRefPx, markPx) : undefined;
  const reviewThresholdBreached = (externalDeviationBps ?? 0) > review;

  let severity: Severity = 'ok';
  let reason = `oracle/mark deviation ${deviationBps.toFixed(1)}bps within thresholds`;
  if (deviationBps > crit) {
    severity = 'critical';
    reason = `oracle/mark deviation ${deviationBps.toFixed(1)}bps exceeds critical ${crit}bps`;
  } else if (deviationBps > warn) {
    severity = 'warn';
    reason = `oracle/mark deviation ${deviationBps.toFixed(1)}bps exceeds warn ${warn}bps`;
  }

  if (externalDeviationBps !== undefined && reviewThresholdBreached) {
    severity = 'critical';
    reason += `; external ref deviation ${externalDeviationBps.toFixed(0)}bps breached validator auto-review threshold (${review}bps)`;
  } else if (externalDeviationBps !== undefined && externalDeviationBps > crit && severity === 'ok') {
    severity = 'warn';
    reason += `; external ref deviation ${externalDeviationBps.toFixed(0)}bps exceeds critical ${crit}bps`;
  }

  return { deviationBps, externalDeviationBps, reviewThresholdBreached, severity, reason };
}
