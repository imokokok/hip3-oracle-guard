import { describe, it, expect } from 'vitest';
import {
  RESOLVE_SNAPSHOTS, eventKey, snapshotFile,
  alarmRowsFromSnapshot, updateIncidents,
} from '../scripts/incident-ledger.mjs';
import { RED_OI_USD } from '../scripts/radar-core.mjs';

const T0 = '2026-11-28T06:00:00.000Z';
const T1 = '2026-11-28T06:30:00.000Z';
const T2 = '2026-11-28T07:00:00.000Z';
const T3 = '2026-11-28T07:30:00.000Z';

// 构造快照（字段语义与 sample-oracles.mjs 一致）
function asset(over = {}) {
  return {
    asset: 'X',
    oraclePx: '100',
    markPx: '100.1',
    openInterest: '1000',
    dayNtlVlm: '5000000',
    ...over,
  };
}
function snap(over = {}) {
  return {
    sampledAt: T0,
    dexs: [{ dex: 'testdex', deployer: '0x1', oracleUpdater: null, assetCount: 1, liveAssetCount: 1, dayVolumeUsd: 5000000, maxDeviationBps: 10, assets: [asset()] }],
    ...over,
  };
}

describe('eventKey / snapshotFile', () => {
  it('市场事件键 = dex:asset，墓碑 = dex:*', () => {
    expect(eventKey({ dex: 'xyz', asset: 'ICE', grade: 'red' })).toBe('xyz:ICE');
    expect(eventKey({ dex: 'xyz', asset: '*', grade: 'tombstone' })).toBe('xyz:*');
  });
  it('asset 自带 dex 前缀时去冗余（快照真实形态 dex=xyz, asset=xyz:ICE）', () => {
    expect(eventKey({ dex: 'xyz', asset: 'xyz:ICE', grade: 'yellow' })).toBe('xyz:ICE');
    expect(eventKey({ dex: 'para', asset: 'para:BTCD', grade: 'trap' })).toBe('para:BTCD');
  });
  it('snapshotFile 与 sample-oracles.mjs 命名一致（: 和 . 替换为 -）', () => {
    expect(snapshotFile('2026-11-28T06:00:55.323Z')).toBe('snapshot-2026-11-28T06-00-55-323Z.json');
  });
});

describe('alarmRowsFromSnapshot — 与状态页同源分级', () => {
  it('white / missing 不产生告警行', () => {
    const rows = alarmRowsFromSnapshot(snap());
    expect(rows).toHaveLength(0);
    const missing = alarmRowsFromSnapshot(snap({ dexs: [{ dex: 'testdex', assets: [asset({ oraclePx: null })] }] }));
    expect(missing).toHaveLength(0);
  });
  it('red 行：devBps/notionalUsd 四舍五入到 0.1bps / 整数美元', () => {
    // 偏离 20bps+，名义 OI > $100M
    const s = snap({ dexs: [{ dex: 'xyz', assets: [asset({ asset: 'MU', oraclePx: '606.09', markPx: '607.59', openInterest: '266311.91', dayNtlVlm: '94700000' })] }] });
    const rows = alarmRowsFromSnapshot(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].grade).toBe('red');
    expect(rows[0].dex).toBe('xyz');
    expect(rows[0].devBps).toBeCloseTo(24.7, 1);
    expect(Number.isInteger(rows[0].notionalUsd)).toBe(true);
  });
  it('trap 行（量≈0 但 OI>0）', () => {
    const s = snap({ dexs: [{ dex: 'para', assets: [asset({ asset: 'BTCD', dayNtlVlm: '4606' })] }] });
    const rows = alarmRowsFromSnapshot(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].grade).toBe('trap');
  });
  it('error DEX 跳过；墓碑 DEX 出 dex:* 行且不逐市场分级', () => {
    const history = Array.from({ length: 30 }, (_, i) => snap({ sampledAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`, dexs: [{ dex: 'dead', assets: [asset({ openInterest: '0', dayNtlVlm: '0' })] }] }));
    const s = snap({ dexs: [
      { dex: 'err', error: 'HTTP 503' },
      { dex: 'dead', assets: [asset({ oraclePx: '606.09', markPx: '607.59', openInterest: '0', dayNtlVlm: '0' })] },
    ] });
    const rows = alarmRowsFromSnapshot(s, history);
    expect(rows).toHaveLength(1);
    expect(rows[0].grade).toBe('tombstone');
    expect(rows[0].asset).toBe('*');
  });
});

describe('updateIncidents — open → resolved 状态机', () => {
  const alarm = (over = {}) => ({ ts: T0, dex: 'xyz', asset: 'ICE', grade: 'yellow', devBps: 16.1, notionalUsd: 21357, volUsd: 18859, reason: 'on watchlist', ...over });

  it('首次告警开新事件，id = key#1', () => {
    const out = updateIncidents([], [alarm()], T0);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('xyz:ICE#1');
    expect(out[0].status).toBe('open');
    expect(out[0].openedAt).toBe(T0);
    expect(out[0].samples).toBe(1);
    expect(out[0].peakSnapshot).toBe(snapshotFile(T0));
  });
  it('连续告警去重：不新增事件，lastSeen/samples 更新', () => {
    const first = updateIncidents([], [alarm()], T0);
    const second = updateIncidents(first, [alarm({ ts: T1 })], T1);
    expect(second).toHaveLength(1);
    expect(second[0].samples).toBe(2);
    expect(second[0].lastSeenAt).toBe(T1);
    expect(second[0].openedAt).toBe(T0);
  });
  it('升级记峰值：yellow → red 后 peakGrade/peakDevBps/peakTs 取红', () => {
    const first = updateIncidents([], [alarm()], T0);
    const second = updateIncidents(first, [alarm({ ts: T1, grade: 'red', devBps: 24.7 })], T1);
    expect(second[0].peakGrade).toBe('red');
    expect(second[0].peakDevBps).toBe(24.7);
    expect(second[0].peakTs).toBe(T1);
    expect(second[0].openedAt).toBe(T0);
  });
  it('同级偏离更高也更新峰值；更低不动', () => {
    const first = updateIncidents([], [alarm({ devBps: 16.1 })], T0);
    const higher = updateIncidents(first, [alarm({ ts: T1, devBps: 18.3 })], T1);
    expect(higher[0].peakDevBps).toBe(18.3);
    const lower = updateIncidents(higher, [alarm({ ts: T2, devBps: 15.2 })], T2);
    expect(lower[0].peakDevBps).toBe(18.3);
  });
  it(`缺席 ${RESOLVE_SNAPSHOTS - 1} 次仍 open（防抖动）`, () => {
    let ledger = updateIncidents([], [alarm()], T0);
    ledger = updateIncidents(ledger, [], T1);
    ledger = updateIncidents(ledger, [], T2);
    expect(ledger[0].status).toBe('open');
    expect(ledger[0].misses).toBe(2);
  });
  it(`连续缺席 ${RESOLVE_SNAPSHOTS} 次 → resolved，resolvedAt = 当前采样时刻`, () => {
    let ledger = updateIncidents([], [alarm()], T0);
    ledger = updateIncidents(ledger, [], T1);
    ledger = updateIncidents(ledger, [], T2);
    ledger = updateIncidents(ledger, [], T3);
    expect(ledger[0].status).toBe('resolved');
    expect(ledger[0].resolvedAt).toBe(T3);
  });
  it('缺席期间复现 → misses 归零，事件不中断', () => {
    let ledger = updateIncidents([], [alarm()], T0);
    ledger = updateIncidents(ledger, [], T1);
    ledger = updateIncidents(ledger, [alarm({ ts: T2 })], T2);
    expect(ledger[0].status).toBe('open');
    expect(ledger[0].misses).toBe(0);
    expect(ledger[0].id).toBe('xyz:ICE#1');
  });
  it('resolved 后再次告警 → 新 episode，老事件是历史不复活', () => {
    let ledger = updateIncidents([], [alarm()], T0);
    for (const t of [T1, T2, T3]) ledger = updateIncidents(ledger, [], t);
    expect(ledger[0].status).toBe('resolved');
    const again = updateIncidents(ledger, [alarm({ ts: T3 })], T3);
    expect(again).toHaveLength(2);
    expect(again.map((i) => i.id).sort()).toEqual(['xyz:ICE#1', 'xyz:ICE#2']);
    expect(again.find((i) => i.id === 'xyz:ICE#1').status).toBe('resolved');
    expect(again.find((i) => i.id === 'xyz:ICE#2').status).toBe('open');
  });
  it('episode 计数跨多轮重开递增（#1 → #2 → #3）', () => {
    let ledger = updateIncidents([], [alarm()], T0);
    const close = (l, ts) => { for (let k = 0; k < RESOLVE_SNAPSHOTS; k++) l = updateIncidents(l, [], ts); return l; };
    ledger = close(ledger, T1);
    ledger = updateIncidents(ledger, [alarm()], T1);
    ledger = close(ledger, T2);
    ledger = updateIncidents(ledger, [alarm()], T2);
    const eps = ledger.filter((i) => i.key === 'xyz:ICE').map((i) => i.episode);
    expect(eps).toEqual([1, 2, 3]);
  });
  it('墓碑事件键为 dex:*，resolved 后 DEX 复活再死开新 episode', () => {
    const tomb = { ts: T0, dex: 'dead', asset: '*', grade: 'tombstone', devBps: null, notionalUsd: null, volUsd: null, reason: 'dormant' };
    let ledger = updateIncidents([], [tomb], T0);
    expect(ledger[0].id).toBe('dead:*#1');
    for (let k = 0; k < RESOLVE_SNAPSHOTS; k++) ledger = updateIncidents(ledger, [], T1);
    ledger = updateIncidents(ledger, [tomb], T2);
    expect(ledger.filter((i) => i.key === 'dead:*')).toHaveLength(2);
  });
  it('输出按 openedAt 排序，resolved 历史保留', () => {
    let ledger = updateIncidents([], [alarm()], T0);
    for (let k = 0; k < RESOLVE_SNAPSHOTS; k++) ledger = updateIncidents(ledger, [], T1);
    ledger = updateIncidents(ledger, [alarm({ dex: 'para', asset: 'BTCD', ts: T2 })], T2);
    expect(ledger.map((i) => i.openedAt)).toEqual([T0, T2]);
    expect(ledger[0].status).toBe('resolved');
  });
  it('res 红优先于黄的同轮合并：一轮里只出现一行（分级互斥由 classify 保证）', () => {
    // 事件重开（episode+1）时 peakGrade 不继承旧 episode
    let ledger = updateIncidents([], [alarm({ grade: 'red', devBps: 24.7 })], T0);
    for (let k = 0; k < RESOLVE_SNAPSHOTS; k++) ledger = updateIncidents(ledger, [], T1);
    ledger = updateIncidents(ledger, [alarm({ ts: T2, grade: 'yellow', devBps: 15 })], T2);
    const reopened = ledger.find((i) => i.status === 'open');
    expect(reopened.peakGrade).toBe('yellow');
    expect(reopened.episode).toBe(2);
  });
});
