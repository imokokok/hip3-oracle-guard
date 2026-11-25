import { describe, it, expect } from 'vitest';
import { assessReviewProximity, preHaltCheck } from '../src/halt.js';

describe('assessReviewProximity', () => {
  it('偏离开盘 10% → ok（审查线的 20%）', () => {
    const r = assessReviewProximity(110, 100);
    expect(r.severity).toBe('ok');
    expect(r.reviewProgress).toBeCloseTo(0.2);
  });

  it('偏离开盘 30% → warn（接近审查线）', () => {
    const r = assessReviewProximity(130, 100);
    expect(r.severity).toBe('warn');
    expect(r.reason).toContain('approaching');
  });

  it('偏离开盘 55% → critical（突破 ±50% 自动审查线）', () => {
    const r = assessReviewProximity(155, 100);
    expect(r.severity).toBe('critical');
    expect(r.reason).toContain('BREACHED');
  });

  it('阈值可配置', () => {
    const r = assessReviewProximity(130, 100, 0.2);
    expect(r.severity).toBe('critical');
  });

  it('dayOpenPx 非法 → critical', () => {
    expect(assessReviewProximity(100, 0).severity).toBe('critical');
  });
});

describe('preHaltCheck', () => {
  const base = { markPx: 100, dayOpenPx: 100, oraclePx: 100.05, maxLeverage: 10 };

  it('全部正常 → monitor', () => {
    const r = preHaltCheck(base);
    expect(r.recommendation).toBe('monitor');
    expect(r.items.every((i) => i.status === 'pass')).toBe(true);
  });

  it('标记价突破审查线 → halt-candidate', () => {
    const r = preHaltCheck({ ...base, markPx: 155, oraclePx: 155 });
    expect(r.recommendation).toBe('halt-candidate');
    expect(r.items.find((i) => i.name === 'validator-review-line')?.status).toBe('fail');
    expect(r.reason).toContain('protective action');
  });

  it('oracle/mark 分歧超阈值 → halt-candidate（喂价坏了是 halt 的经典前兆）', () => {
    const r = preHaltCheck({ ...base, oraclePx: 120 });
    expect(r.recommendation).toBe('halt-candidate');
    expect(r.items.find((i) => i.name === 'oracle-mark-divergence')?.status).toBe('fail');
  });

  it('标记价出 discovery band → halt-candidate', () => {
    // 10x → band ±10%，mark 111 出带（相对 dayOpen 100）
    const r = preHaltCheck({ ...base, markPx: 111, oraclePx: 111 });
    expect(r.items.find((i) => i.name === 'discovery-band')?.status).toBe('fail');
    expect(r.recommendation).toBe('halt-candidate');
  });

  it('偏离 8%（审查线与 band 内）→ monitor', () => {
    const r = preHaltCheck({ ...base, markPx: 108, oraclePx: 108 });
    expect(r.recommendation).toBe('monitor');
    expect(r.items.every((i) => i.status === 'pass')).toBe(true);
  });

  it('偏离 30% 未破审查线但已出 band → halt-candidate', () => {
    const r = preHaltCheck({ ...base, markPx: 130, oraclePx: 130 });
    expect(r.recommendation).toBe('halt-candidate');
    expect(r.items.find((i) => i.name === 'discovery-band')?.status).toBe('fail');
  });
});
