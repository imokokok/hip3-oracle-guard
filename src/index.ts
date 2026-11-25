// hip3-oracle-guard — 模块桩。每个守卫模块的接口在此定形后单独实现。

// ---- staleness：喂价滞后检测 ----
export interface StalenessConfig {
  /** 预期更新间隔（毫秒）。HIP-3 生产级喂价的公开参照是 ~3s。 */
  expectedIntervalMs: number;
  /** 超过该倍数视为停滞并告警。 */
  staleMultiplier?: number;
}

export interface StalenessCheck {
  stale: boolean;
  ageMs: number;
  severity: 'ok' | 'warn' | 'critical';
}

// ---- deviation：oracle/mark/外部参考偏离守卫 ----
export interface DeviationCheck {
  deviationBps: number;
  severity: 'ok' | 'warn' | 'critical';
  /** 是否达到协议罚没审查关联的异常量级（外部价较开盘 ±50% 为验证者自动审查阈值）。 */
  reviewThresholdBreached: boolean;
}

// ---- bounds：Discovery Bounds v2 校验 ----
export interface BoundsConfig {
  maxLeverage: number;
  /** band 触达边缘 90% 时的 re-anchor 参照。 */
  reAnchorThreshold?: 0.9;
}

// 待实现：各守卫函数接收只读数据（info API / WS 采样），返回上述结构。
// 设计约束：全库零写链操作、零密钥依赖——只读、只告警、只校验。
