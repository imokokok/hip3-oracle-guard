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
  /**
   * 观测起点（epoch ms，如 monitor 进程启动时刻）。
   * 差分推断模式下（观测者不知道 feed 在启动前的更新历史），冷启动窗口内
   * 无法区分"feed 停了"和"我们刚启动还没见过更新"——此窗口内的告警
   * severity 封顶为 warn 并置 coldStart=true，把"不知道"与"没出事"分开。
   * 提供硬时间戳（快照含 lastUpdateAtMs）时可不传，判定不受影响。
   */
  firstObservedAtMs?: number;
}

export interface StalenessCheck extends GuardResult {
  stale: boolean;
  ageMs: number;
  /** true = 判定处于冷启动窗口内，"没见过更新"不等于"feed 已停"。 */
  coldStart: boolean;
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
  // 冷启动窗口：观测时长还不足以证明"该见到的更新确实没来"。
  const coldStart =
    config.firstObservedAtMs !== undefined &&
    nowMs - config.firstObservedAtMs < config.expectedIntervalMs * warn;

  let severity: Severity = 'ok';
  let reason = `feed age ${ageMs}ms within expected interval ${config.expectedIntervalMs}ms`;
  if (ageMs > config.expectedIntervalMs * crit) {
    severity = 'critical';
    reason = `feed stalled: age ${ageMs}ms > ${crit}x expected interval (${config.expectedIntervalMs}ms)`;
  } else if (stale) {
    severity = 'warn';
    reason = `feed lagging: age ${ageMs}ms > ${warn}x expected interval (${config.expectedIntervalMs}ms)`;
  }

  // 冷启动窗口内保守降级：差分模式下 age 从观测起点起算，critical 可能只是
  // "观测者刚启动"。封顶 warn，把升级决策留给调用方（等窗口出满再升）。
  if (coldStart && severity === 'critical') {
    severity = 'warn';
    reason = `[cold-start window: cannot distinguish stalled feed from observer startup] ${reason}`;
  }

  return { stale, ageMs, coldStart, severity, reason };
}
