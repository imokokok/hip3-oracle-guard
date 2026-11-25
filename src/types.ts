// 共享类型。全库设计约束：只读、零写链、零密钥。

/** 告警分级。 */
export type Severity = 'ok' | 'warn' | 'critical';

export interface GuardResult {
  severity: Severity;
  /** 人类可读的判定说明，供日志/告警直接使用。 */
  reason: string;
}

/** 喂价输入源的最小快照。 */
export interface PriceSnapshot {
  /** 部署方 oracle 输入（HIP-3 setOracle 的 oraclePx）。 */
  oraclePx: number;
  /** 当前标记价格。 */
  markPx: number;
  /** 可选：外部参考价（如 CEX 现货），用于跨场所校验。 */
  externalRefPx?: number;
  /** oracle 最后更新时间（epoch ms）。 */
  lastUpdateAtMs: number;
  /** 判定时刻（epoch ms），缺省取 Date.now()。 */
  nowMs?: number;
}
