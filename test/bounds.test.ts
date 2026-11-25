import { describe, it, expect } from 'vitest';
import { assessBounds } from '../src/bounds.js';

describe('assessBounds', () => {
  // 参照 SK Hynix 事故：SKHYNIX 10x 杠杆 → band ±10%
  const cfg = { maxLeverage: 10 };

  it('band 半宽 = 1/maxLeverage', () => {
    const r = assessBounds(100, 100, undefined, cfg);
    expect(r.bandHalfWidth).toBeCloseTo(0.1);
    expect(r.lowerEdgePx).toBeCloseTo(90);
    expect(r.upperEdgePx).toBeCloseTo(110);
    expect(r.severity).toBe('ok');
  });

  it('带中心 → ok', () => {
    const r = assessBounds(101, 100, undefined, cfg);
    expect(r.severity).toBe('ok');
    expect(r.reAnchorDue).toBe(false);
  });

  it('oracle 走到带边缘 50% → warn', () => {
    const r = assessBounds(105.5, 100, undefined, cfg); // 偏离 5.5% / 10% = 55%
    expect(r.severity).toBe('warn');
    expect(r.reAnchorDue).toBe(false);
  });

  it('oracle 到达 90%（Bounds v2 re-anchor 参照）→ critical + reAnchorDue', () => {
    const r = assessBounds(109.5, 100, undefined, cfg); // 95% > 90%
    expect(r.severity).toBe('critical');
    expect(r.reAnchorDue).toBe(true);
    expect(r.reason).toContain('re-anchor');
  });

  it('oracle 出带 → critical（SK Hynix：标记价被打到 bound）', () => {
    const r = assessBounds(111, 100, undefined, cfg);
    expect(r.severity).toBe('critical');
    expect(r.edgeProgress).toBeGreaterThan(1);
    expect(r.reason).toContain('outside discovery band');
  });

  it('清算价在带外 → 该仓位不会被清算（协议安全性质）', () => {
    const r = assessBounds(100, 100, 85, cfg); // 清算价 85 < 下沿 90
    expect(r.liquidationPriceOutsideBand).toBe(true);
  });

  it('清算价在带内 → 不构成带外豁免', () => {
    const r = assessBounds(100, 100, 95, cfg);
    expect(r.liquidationPriceOutsideBand).toBe(false);
  });

  it('未提供清算价 → undefined', () => {
    const r = assessBounds(100, 100, undefined, cfg);
    expect(r.liquidationPriceOutsideBand).toBeUndefined();
  });
});
