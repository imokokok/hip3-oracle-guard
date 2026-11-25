// halt-guard：罚没审查线接近度 + haltTrading 决策辅助。
// 机制参照（HIP-3 文档 + SK Hynix 复盘）：
//   - 验证者在外部价较当日开盘 ±50% 时自动审查跨保证金资产 → 接近该线本身是风险信号
//   - haltTrading：取消全部订单并按当前标记价结算全部仓位，可用于止损或回收合约槽位
//   - 罚没分档 20%/50%/100%，不区分恶意与无能
// 全模块只读：输入由调用方提供，输出结构化判定。最终 halt 决策权永远在部署方。

import type { Severity, GuardResult } from './types.js';

export interface ReviewProximityCheck extends GuardResult {
  /** |mark - dayOpen| / dayOpen / threshold 的比值：1 = 恰好触及验证者自动审查线。 */
  reviewProgress: number;
}

/** 外部/标记价相对当日开盘向验证者 ±50% 自动审查线逼近的程度。 */
export function assessReviewProximity(
  markPx: number,
  dayOpenPx: number,
  threshold = 0.5,
): ReviewProximityCheck {
  if (dayOpenPx <= 0) {
    return { reviewProgress: Number.POSITIVE_INFINITY, severity: 'critical', reason: `invalid dayOpenPx ${dayOpenPx}` };
  }
  const move = Math.abs(markPx - dayOpenPx) / dayOpenPx;
  const reviewProgress = move / threshold;

  let severity: Severity = 'ok';
  let reason = `mark moved ${(move * 100).toFixed(1)}% from day open — ${(reviewProgress * 100).toFixed(0)}% of validator auto-review threshold (${threshold * 100}%)`;
  if (reviewProgress >= 1) {
    severity = 'critical';
    reason = `mark moved ${(move * 100).toFixed(1)}% from day open — VALIDATOR AUTO-REVIEW THRESHOLD BREACHED (${threshold * 100}%)`;
  } else if (reviewProgress >= 0.5) {
    severity = 'warn';
    reason = `mark moved ${(move * 100).toFixed(1)}% from day open — approaching validator auto-review threshold (${threshold * 100}%)`;
  }

  return { reviewProgress, severity, reason };
}

export interface PreHaltInput {
  /** 当前标记价。 */
  markPx: number;
  /** 当日开盘/参考价。 */
  dayOpenPx: number;
  /** 部署方 oracle 输入价。 */
  oraclePx: number;
  /** 市场最大杠杆（band 半宽 = 1/maxLeverage）。 */
  maxLeverage: number;
  /** oracle/mark 偏离的 critical 阈值 bps，默认 500。 */
  deviationCriticalBps?: number;
}

export type ChecklistStatus = 'pass' | 'fail' | 'unknown';

export interface ChecklistItem {
  name: string;
  status: ChecklistStatus;
  note: string;
}

export interface PreHaltCheck extends GuardResult {
  items: ChecklistItem[];
  /** 'halt-candidate' = 存在触发项，建议部署方人工复核；'monitor' = 继续。 */
  recommendation: 'halt-candidate' | 'monitor';
}

/**
 * halt 前核对清单。任一 fail → halt-candidate（此时 halt 是保护性动作：
 * 取消订单 + 按标记价结算，把损失锁定在已发生部分）。
 */
export function preHaltCheck(input: PreHaltInput): PreHaltCheck {
  const items: ChecklistItem[] = [];

  const review = assessReviewProximity(input.markPx, input.dayOpenPx);
  items.push({
    name: 'validator-review-line',
    status: review.severity === 'critical' ? 'fail' : 'pass',
    note: review.reason,
  });

  const bandHalfWidth = 1 / input.maxLeverage;
  const bandProgress = Math.abs(input.markPx - input.dayOpenPx) / (input.dayOpenPx * bandHalfWidth);
  items.push({
    name: 'discovery-band',
    status: bandProgress > 1 ? 'fail' : 'pass',
    note: `mark at ${(bandProgress * 100).toFixed(1)}% of ±${(bandHalfWidth * 100).toFixed(1)}% band around day open${bandProgress > 1 ? ' — outside band' : ''}`,
  });

  const devBps = Math.abs(input.oraclePx - input.markPx) / input.markPx * 10000;
  const devCrit = input.deviationCriticalBps ?? 500;
  items.push({
    name: 'oracle-mark-divergence',
    status: devBps > devCrit ? 'fail' : 'pass',
    note: `oracle/mark divergence ${devBps.toFixed(0)}bps (critical threshold ${devCrit}bps)`,
  });

  const failed = items.filter((i) => i.status === 'fail').length;
  return {
    items,
    recommendation: failed > 0 ? 'halt-candidate' : 'monitor',
    severity: failed > 0 ? 'critical' : 'ok',
    reason:
      failed > 0
        ? `${failed} check(s) failed — halt is the protective action: cancels all orders and settles at current mark`
        : 'all checks passed — continue monitoring',
  };
}
