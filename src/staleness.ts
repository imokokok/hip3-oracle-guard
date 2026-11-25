// staleness：喂价滞后检测。
// 语义要点（见 docs/postmortem/2026-07-28-sk-hynix.md 启示 4）：
//   停滞守卫的价值不是"发现旧价格"，而是把"新鲜"与"可信"分开——
//   在可疑新鲜价与最后有效价之间，守卫应偏向后者。本模块只做检测与分级，不做决策。

import type { Severity, GuardResult } from './types.js';

export interface StalenessConfig {
  /** 预期更新间隔（毫秒）。HIP-3 生产级喂价的公开参照是 ~3s。 */
  expectedIntervalMs: number;
  /** 超过该倍数视为 warn，默认 3。 */
  warnMultiplier?: number;
  /** 超过该倍数视为 critical，默认 10。 */
  criticalMultiplier?: number;
}

export interface StalenessCheck extends GuardResult {
  stale: boolean;
  ageMs: number;
}

export function assessStaleness(
  lastUpdateAtMs: number,
  config: StalenessConfig,
  nowMs: number = Date.now(),
): StalenessCheck {
  const warn = config.warnMultiplier ?? 3;
  const crit = config.criticalMultiplier ?? 10;
  const ageMs = Math.max(0, nowMs - lastUpdateAtMs);
  const stale = ageMs > config.expectedIntervalMs * warn;

  let severity: Severity = 'ok';
  let reason = `feed age ${ageMs}ms within expected interval ${config.expectedIntervalMs}ms`;
  if (ageMs > config.expectedIntervalMs * crit) {
    severity = 'critical';
    reason = `feed stalled: age ${ageMs}ms > ${crit}x expected interval (${config.expectedIntervalMs}ms)`;
  } else if (stale) {
    severity = 'warn';
    reason = `feed lagging: age ${ageMs}ms > ${warn}x expected interval (${config.expectedIntervalMs}ms)`;
  }

  return { stale, ageMs, severity, reason };
}
