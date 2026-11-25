import { describe, it, expect } from 'vitest';
import { assessStaleness } from '../src/staleness.js';

describe('assessStaleness', () => {
  const cfg = { expectedIntervalMs: 3000 }; // HIP-3 生产级参照 ~3s

  it('ok: 更新间隔内', () => {
    const r = assessStaleness(0, cfg, 2900);
    expect(r.severity).toBe('ok');
    expect(r.stale).toBe(false);
  });

  it('warn: 超过 warn 倍数（默认 3x）', () => {
    const r = assessStaleness(0, cfg, 10_000);
    expect(r.severity).toBe('warn');
    expect(r.stale).toBe(true);
    expect(r.reason).toContain('lagging');
  });

  it('critical: 超过 critical 倍数（默认 10x）', () => {
    const r = assessStaleness(0, cfg, 40_000);
    expect(r.severity).toBe('critical');
    expect(r.reason).toContain('stalled');
  });

  it('warn/critical 倍数可配置', () => {
    const r = assessStaleness(0, { expectedIntervalMs: 3000, warnMultiplier: 2, criticalMultiplier: 5 }, 16_000);
    expect(r.severity).toBe('critical');
  });

  it('未来时间戳被钳制为 0 延迟', () => {
    const r = assessStaleness(10_000, cfg, 5_000);
    expect(r.ageMs).toBe(0);
    expect(r.severity).toBe('ok');
    expect(r.coldStart).toBe(false);
  });

  it('冷启动窗口内：即使 age 超过 critical 倍数也封顶 warn 并置 coldStart', () => {
    // 观测起点 35_000，现在 40_000 —— 观测时长仅 5s < 3x interval (9s)，
    // 但差分推断的 age 已达 40s（>10x）。不能虚报 critical。
    const r = assessStaleness(0, { expectedIntervalMs: 3000, firstObservedAtMs: 35_000 }, 40_000);
    expect(r.coldStart).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.severity).toBe('warn');
    expect(r.reason).toContain('cold-start');
  });

  it('冷启动窗口出满后恢复 critical', () => {
    // 观测起点 0，现在 40_000 —— 观测时长 40s ≥ 9s，判定可信。
    const r = assessStaleness(0, { expectedIntervalMs: 3000, firstObservedAtMs: 0 }, 40_000);
    expect(r.coldStart).toBe(false);
    expect(r.severity).toBe('critical');
  });

  it('未传 firstObservedAtMs（硬时间戳模式）不受冷启动影响', () => {
    const r = assessStaleness(0, cfg, 40_000);
    expect(r.coldStart).toBe(false);
    expect(r.severity).toBe('critical');
  });
});
