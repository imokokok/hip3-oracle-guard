import { describe, it, expect } from 'vitest';
import { assessDeviation } from '../src/deviation.js';

describe('assessDeviation', () => {
  it('ok: 偏离在阈值内', () => {
    const r = assessDeviation(100.05, 100, {});
    expect(r.severity).toBe('ok');
    expect(r.reviewThresholdBreached).toBe(false);
  });

  it('warn: 超过 100bps', () => {
    const r = assessDeviation(101.1, 100, {});
    expect(r.severity).toBe('warn');
    expect(r.deviationBps).toBeCloseTo(110, 0);
  });

  it('critical: 超过 500bps', () => {
    const r = assessDeviation(106, 100, {});
    expect(r.severity).toBe('critical');
  });

  it('外部参考触及验证者 ±50% 自动审查线 → critical（SK Hynix 教训）', () => {
    // mark 100，外部参考 152 → 偏离 52% > 50%
    const r = assessDeviation(100, 100, {}, 152);
    expect(r.severity).toBe('critical');
    expect(r.reviewThresholdBreached).toBe(true);
    expect(r.reason).toContain('auto-review');
  });

  it('外部参考大幅偏离但未达 50% 线 → 至少 warn', () => {
    const r = assessDeviation(100, 100, {}, 107);
    expect(r.severity).toBe('warn');
    expect(r.reviewThresholdBreached).toBe(false);
  });

  it('外部参考偏离可拉高整体分级', () => {
    // oracle/mark 正常，但外部参考超 500bps
    const r = assessDeviation(100.05, 100, {}, 106);
    expect(r.severity).toBe('warn');
  });

  it('markPx 非法 → critical', () => {
    const r = assessDeviation(100, 0, {});
    expect(r.severity).toBe('critical');
  });

  it('实测复现：flx:BTC oracle 64705 vs mark 91470 → critical', () => {
    const r = assessDeviation(64705, 91470.2, {});
    expect(r.severity).toBe('critical');
    expect(r.deviationBps).toBeGreaterThan(2000);
  });
});
