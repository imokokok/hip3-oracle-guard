import { describe, it, expect } from 'vitest';
import { isMarketOpen, assessOffHours } from '../src/offhours.js';

describe('isMarketOpen', () => {
  it('美股：ET 周二 10:00 开市', () => {
    // 2026-11-24 是周二；15:00Z = 10:00 EST（11 月为冬令时 UTC-5）
    expect(isMarketOpen('us-equity', new Date('2026-11-24T15:00:00Z'))).toBe(true);
  });

  it('美股：ET 周二 17:00 已收盘', () => {
    expect(isMarketOpen('us-equity', new Date('2026-11-24T22:00:00Z'))).toBe(false);
  });

  it('美股：周末休市', () => {
    // 2026-11-29 是周日；20:00Z = 15:00 EST
    expect(isMarketOpen('us-equity', new Date('2026-11-29T20:00:00Z'))).toBe(false);
  });

  it('期货：周日 18:00 ET 周开盘锚生效', () => {
    // 周日 23:00Z = 18:00 EST
    expect(isMarketOpen('futures', new Date('2026-11-29T23:00:00Z'))).toBe(true);
  });

  it('期货：周三 17:30 ET 处于每日维护段 → 休市', () => {
    // 2026-11-25 周三；22:30Z = 17:30 EST
    expect(isMarketOpen('futures', new Date('2026-11-25T22:30:00Z'))).toBe(false);
  });

  it('期货：周三 16:30 ET 维护段前 → 开市', () => {
    expect(isMarketOpen('futures', new Date('2026-11-25T21:30:00Z'))).toBe(true);
  });

  it('外汇：周三 17:30 ET 无维护段 → 开市', () => {
    expect(isMarketOpen('fx', new Date('2026-11-25T22:30:00Z'))).toBe(true);
  });

  it('期货：周五 17:30 ET 周收盘后 → 休市', () => {
    // 2026-11-27 周五；22:30Z = 17:30 EST
    expect(isMarketOpen('futures', new Date('2026-11-27T22:30:00Z'))).toBe(false);
  });

  it('加密：永远开市', () => {
    expect(isMarketOpen('crypto-247', new Date('2026-11-29T05:00:00Z'))).toBe(true);
  });
});

describe('assessOffHours', () => {
  const cfg = { assetClass: 'us-equity' as const, maxLeverage: 10, referencePx: 100 };

  it('开市 → external 模式，不做带判定', () => {
    const r = assessOffHours(109, new Date('2026-11-24T15:00:00Z'), cfg);
    expect(r.open).toBe(true);
    expect(r.bandProgress).toBeUndefined();
    expect(r.severity).toBe('ok');
  });

  it('休市 + 带内 40% → ok', () => {
    const r = assessOffHours(104, new Date('2026-11-24T22:00:00Z'), cfg); // 4% / 10% = 40%
    expect(r.open).toBe(false);
    expect(r.severity).toBe('ok');
  });

  it('休市 + 带边缘 55% → warn', () => {
    const r = assessOffHours(105.5, new Date('2026-11-24T22:00:00Z'), cfg); // 55%
    expect(r.severity).toBe('warn');
  });

  it('休市 + 出带 → critical（SK Hynix 模式：薄市成交进 oracle）', () => {
    const r = assessOffHours(112, new Date('2026-11-24T22:00:00Z'), cfg);
    expect(r.severity).toBe('critical');
    expect(r.reason).toContain('off-hours pricing violated');
  });

  it('夏令时切换：7 月（EDT UTC-4）14:00 ET 为开市', () => {
    // 2026-07-28 周二；18:00Z = 14:00 EDT → 开市
    expect(isMarketOpen('us-equity', new Date('2026-07-28T18:00:00Z'))).toBe(true);
    // 20:00Z = 16:00 EDT 收盘；20:30Z = 16:30 EDT 盘后 → 休市
    expect(isMarketOpen('us-equity', new Date('2026-07-28T20:00:00Z'))).toBe(false);
    expect(isMarketOpen('us-equity', new Date('2026-07-28T20:30:00Z'))).toBe(false);
  });
});
