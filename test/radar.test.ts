import { describe, it, expect } from 'vitest';
import {
  classify, notionalUsd, deviationBps, tombstoneDexs,
  RED_DEV_BPS, RED_OI_USD, YELLOW_DEV_BPS, TRAP_VOL_USD, TOMBSTONE_MIN_SNAPSHOTS,
} from '../scripts/radar-core.mjs';

// 构造一个市场行（字段语义与 sample-oracles.mjs 的快照一致）
function asset(over = {}) {
  return {
    asset: 'test:X',
    oraclePx: '100',
    markPx: '100.1',
    openInterest: '1000',
    dayNtlVlm: '5000000',
    ...over,
  };
}

describe('deviationBps / notionalUsd', () => {
  it('偏离 = |oracle-mark|/mark × 10000', () => {
    expect(deviationBps('101', '100')).toBeCloseTo(100, 5);
    expect(deviationBps('99', '100')).toBeCloseTo(100, 5);
  });
  it('mark 为 0 或字段缺失返回 null', () => {
    expect(deviationBps('1', '0')).toBeNull();
    expect(deviationBps(null, '100')).toBeNull();
  });
  it('名义 OI = qty × markPx', () => {
    expect(notionalUsd(asset({ openInterest: '2000000', markPx: '83.932' }))).toBeCloseTo(167864000, 0);
    expect(notionalUsd(asset({ openInterest: null }))).toBeNull();
  });
});

describe('classify — 单市场四级互斥分级', () => {
  it('red：偏离≥20bps 且名义 OI>$100M（红优先于黄）', () => {
    // 24.7bps × $161.8M ≈ 真实快照里的 xyz:MU
    const r = classify(asset({ oraclePx: '606.09', markPx: '607.59', openInterest: '266311.91', dayNtlVlm: '94700000' }));
    expect(r.grade).toBe('red');
  });
  it('red 不被黄的大名义条件截走：同市场同时满足红与黄时判红', () => {
    const r = classify(asset({ oraclePx: '101', markPx: '100', openInterest: '2000000', dayNtlVlm: '90000000' }));
    expect(r.grade).toBe('red');
    expect(r.notionalUsd).toBeGreaterThan(RED_OI_USD);
  });
  it('yellow：偏离≥15bps 但名义 OI 不够红', () => {
    const r = classify(asset({ oraclePx: '101', markPx: '100', openInterest: '100000', dayNtlVlm: '5000000' }));
    expect(r.grade).toBe('yellow');
    expect(r.notionalUsd).toBeLessThan(RED_OI_USD);
  });
  it('yellow：名义 OI>$250M 且偏离≥10bps', () => {
    const r = classify(asset({ oraclePx: '100.12', markPx: '100', openInterest: '5000000', dayNtlVlm: '400000000' }));
    expect(r.grade).toBe('yellow');
    expect(r.devBps).toBeCloseTo(12, 5);
    expect(r.devBps).toBeLessThan(RED_DEV_BPS);
    expect(r.notionalUsd).toBeGreaterThan(250e6);
  });
  it('trap：24h 量≈0 但 OI>0（卡仓），即使偏离很低', () => {
    const r = classify(asset({ oraclePx: '100.001', markPx: '100', openInterest: '5000', dayNtlVlm: '300' }));
    expect(r.grade).toBe('trap');
  });
  it('trap 不吞掉红/黄：量≈0 但偏离触红仍判红', () => {
    const r = classify(asset({ oraclePx: '101', markPx: '100', openInterest: '2000000', dayNtlVlm: '0' }));
    expect(r.grade).toBe('red');
  });
  it('white：各项都在阈值下', () => {
    const r = classify(asset({ oraclePx: '100.001', markPx: '100', openInterest: '1000', dayNtlVlm: '5000000' }));
    expect(r.grade).toBe('white');
  });
  it('missing：任一关键字段缺失不进分级', () => {
    for (const f of ['oraclePx', 'markPx', 'openInterest', 'dayNtlVlm']) {
      const r = classify(asset({ [f]: null }));
      expect(r.grade).toBe('missing');
      expect(r.reason).toContain(f);
    }
    const bad = classify(asset({ openInterest: 'NaN' }));
    expect(bad.grade).toBe('missing');
  });
  it('OI=0 的死市场是 white（聚合展示），不是 trap', () => {
    const r = classify(asset({ openInterest: '0', dayNtlVlm: '0' }));
    expect(r.grade).toBe('white');
  });
});

describe('tombstoneDexs — 96 快照窗口的 DEX 级墓志铭', () => {
  function snapList(entries) {
    // entries: 长度为 N 的数组，每项是该快照的 DEX 状态列表 [{ name, live }]
    return entries.map((states, i) => ({
      sampledAt: `2026-11-26T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
      dexs: states.map((st) => ({
        dex: st.name,
        assets: st.live ? [asset({})] : [asset({ openInterest: '0', dayNtlVlm: '0' })],
      })),
    }));
  }
  const quiet = [{ name: 'quiet', live: false }, { name: 'busy', live: true }];
  const N = TOMBSTONE_MIN_SNAPSHOTS + 4;
  it('连续窗口全低活跃 → 判死', () => {
    const dead = tombstoneDexs(snapList(Array.from({ length: N }, () => quiet)));
    expect(dead.has('quiet')).toBe(true);
    expect(dead.has('busy')).toBe(false);
  });
  it('窗口内任一快照有活市场 → 不判死（保守）', () => {
    const flipped = (i) => (i === 2 ? [{ name: 'quiet', live: true }, { name: 'busy', live: true }] : quiet);
    const dead = tombstoneDexs(snapList(Array.from({ length: N }, (_, i) => flipped(i))));
    expect(dead.has('quiet')).toBe(false);
  });
  it('历史不足最小快照数 → 不判死（数据不足≠死了）', () => {
    const short = snapList(Array.from({ length: TOMBSTONE_MIN_SNAPSHOTS - 1 }, () => quiet));
    expect(tombstoneDexs(short).size).toBe(0);
  });
  it('DEX 在窗口内缺席/出错 → 不判死', () => {
    const snaps = snapList(Array.from({ length: N }, () => quiet));
    const broken = snaps.map((s, i) => {
      if (i !== 3) return s;
      return { sampledAt: s.sampledAt, dexs: s.dexs.map((d) => (d.dex === 'quiet' ? { dex: 'quiet', error: 'HTTP 500' } : d)) };
    });
    expect(tombstoneDexs(broken).has('quiet')).toBe(false);
  });
  it('市场有成交但 OI=0 → 该 DEX 不判死', () => {
    const snaps = snapList(Array.from({ length: N }, () => quiet));
    for (const s of snaps) {
      const d = s.dexs.find((x) => x.dex === 'quiet');
      d.assets[0] = asset({ openInterest: '0', dayNtlVlm: String(TRAP_VOL_USD + 1) });
    }
    expect(tombstoneDexs(snaps).has('quiet')).toBe(false);
  });
});
