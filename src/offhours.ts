// offhours：非 7x24 资产的会话感知休市守卫。
// 机制参照（DataWallet 对 Trade.xyz 公开机制的整理 + CME 惯例）：
//   - 美股：常规时段 Mon-Fri 09:30-16:00 ET，盘外切换到内部价格发现（discovery bound）
//   - 期货（CME 类）：Sun 18:00 ET - Fri 17:00 ET，每日 17:00-18:00 ET 维护休市
//   - 外汇：Sun 18:00 ET - Fri 17:00 ET，无每日维护段
//   - 加密：24/7
// 守卫语义（SK Hynix 复盘启示 2）：休市期间 oracle 不应跟踪外部薄市成交，
//   应被约束在参考价 ±(1/maxLeverage) 的带内——出带即告警。
//
// 已知限制（诚实声明）：
//   - 节假日日历未内置（NYSE/CME holiday schedule），节假日会被误判为开市
//   - re-anchor 后参考价会漂移，调用方需传入当前 band 的锚（通常为最近收盘/锚定价）

import type { Severity, GuardResult } from './types.js';

export type AssetClass = 'us-equity' | 'futures' | 'fx' | 'crypto-247';

const NY_TZ = 'America/New_York';

interface NyParts {
  weekday: number; // 0=Sunday
  minutes: number; // 当日分钟数
}

function nyParts(date: Date): NyParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const h = parseInt(parts.hour === '24' ? '0' : parts.hour, 10);
  return { weekday: weekdays[parts.weekday], minutes: h * 60 + parseInt(parts.minute, 10) };
}

/** 周内相对周日 00:00 的分钟偏移（ET）。 */
function weekMinutes(p: NyParts): number {
  return p.weekday * 1440 + p.minutes;
}

const SUN_18 = 18 * 60; // 周日 18:00 ET：期货/外汇周开盘锚
const FRI_17 = 5 * 1440 + 17 * 60; // 周五 17:00 ET：周收盘

/** 按资产类别判定给定时刻（UTC）是否处于常规交易时段。 */
export function isMarketOpen(assetClass: AssetClass, date: Date): boolean {
  if (assetClass === 'crypto-247') return true;
  const p = nyParts(date);
  const wm = weekMinutes(p);

  if (assetClass === 'us-equity') {
    if (p.weekday < 1 || p.weekday > 5) return false;
    return p.minutes >= 9 * 60 + 30 && p.minutes < 16 * 60;
  }

  // futures / fx：周日 18:00 → 周五 17:00（ET）
  const inWeek = wm >= SUN_18 && wm < FRI_17;
  if (!inWeek) return false;
  // 期货的每日维护段 17:00-18:00 ET（fx 无）
  if (assetClass === 'futures' && p.minutes >= 17 * 60 && p.minutes < 18 * 60) return false;
  return true;
}

export interface OffHoursConfig {
  assetClass: AssetClass;
  maxLeverage: number;
  /** 当前 band 锚定价（通常为最近收盘/上次 re-anchor 参考价）。 */
  referencePx: number;
  /** 触边多大比例触发 warn，默认 0.5。 */
  warnProgress?: number;
}

export interface OffHoursCheck extends GuardResult {
  open: boolean;
  /** 休市期间 oracle 相对带锚的位置比例（1=恰好触边）。开市时为 undefined。 */
  bandProgress?: number;
}

/**
 * 休市守卫：开市 → 外部价格模式，不做带约束判定；
 * 休市 → oracle 应处于内部发现模式且受 band 约束，出带即 critical。
 */
export function assessOffHours(
  oraclePx: number,
  date: Date,
  config: OffHoursConfig,
): OffHoursCheck {
  const open = isMarketOpen(config.assetClass, date);

  if (open) {
    return {
      open: true,
      severity: 'ok',
      reason: `${config.assetClass} market open (ET) — external price mode, band check not applicable`,
    };
  }

  const bandHalfWidth = 1 / config.maxLeverage;
  const bandProgress =
    config.referencePx > 0
      ? Math.abs(oraclePx - config.referencePx) / (config.referencePx * bandHalfWidth)
      : Number.POSITIVE_INFINITY;

  let severity: Severity = 'ok';
  let reason = `${config.assetClass} market closed (ET) — oracle within band: ${(bandProgress * 100).toFixed(1)}% of ±${(bandHalfWidth * 100).toFixed(1)}%`;

  if (bandProgress > 1) {
    severity = 'critical';
    reason = `${config.assetClass} market closed but oracle ${oraclePx} outside ±${(bandHalfWidth * 100).toFixed(1)}% band around anchor ${config.referencePx} — off-hours pricing violated (SK Hynix pattern: thin-tape print passing into oracle)`;
  } else if (bandProgress >= (config.warnProgress ?? 0.5)) {
    severity = 'warn';
    reason = `${config.assetClass} market closed — oracle at ${(bandProgress * 100).toFixed(1)}% of band edge`;
  }

  return { open: false, bandProgress, severity, reason };
}
