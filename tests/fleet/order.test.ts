import { describe, it, expect } from 'vitest';
import { rowKey, groupByFolder, applyStableOrder, type RailRow } from '../../src/fleet/order.ts';

type S = { pid: number; cwd: string | null };
const s = (pid: number, cwd: string | null): S => ({ pid, cwd });

describe('rowKey', () => {
  it('is the cwd when there is one', () => {
    expect(rowKey(s(1, '/repo'))).toBe('/repo');
  });

  it('falls back to the pid when cwd is null or empty', () => {
    expect(rowKey(s(7, null))).toBe('pid:7');
    expect(rowKey(s(7, ''))).toBe('pid:7');
  });
});

describe('groupByFolder', () => {
  it('leaves a folder with one session as a plain session row', () => {
    const rows = groupByFolder([s(1, '/a')]);
    expect(rows).toEqual([{ kind: 'session', key: '/a', session: s(1, '/a') }]);
  });

  it('collapses two sessions sharing a folder into one stack row', () => {
    const rows = groupByFolder([s(1, '/a'), s(2, '/a')]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe('stack');
    if (!row || row.kind !== 'stack') throw new Error('expected a stack');
    expect(row.cwd).toBe('/a');
    expect(row.members.map((m: S) => m.pid)).toEqual([1, 2]);
  });

  it('never groups sessions with no cwd, even with each other', () => {
    const rows = groupByFolder([s(1, null), s(2, null)]);
    expect(rows.map(r => r.kind)).toEqual(['session', 'session']);
    expect(rows.map(r => r.key)).toEqual(['pid:1', 'pid:2']);
  });

  it('keeps members in the order they arrived, so the caller comparator still governs', () => {
    const rows = groupByFolder([s(3, '/a'), s(1, '/a'), s(2, '/a')]);
    const row = rows[0];
    if (!row || row.kind !== 'stack') throw new Error('expected a stack');
    expect(row.members.map((m: S) => m.pid)).toEqual([3, 1, 2]);
  });

  it('places each row where its FIRST member sat in the input', () => {
    const rows = groupByFolder([s(1, '/a'), s(2, '/b'), s(3, '/a')]);
    expect(rows.map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('returns an empty array for no sessions', () => {
    expect(groupByFolder([])).toEqual([]);
  });
});

describe('applyStableOrder', () => {
  const rows: RailRow<S>[] = [
    { kind: 'session', key: '/b', session: s(2, '/b') },
    { kind: 'session', key: '/a', session: s(1, '/a') },
  ];

  it('sorts rows by their stored index', () => {
    const indexOf = (k: string) => (k === '/a' ? 0 : 1);
    expect(applyStableOrder(rows, indexOf).map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('sends unknown keys to the end, keeping their relative input order', () => {
    const indexOf = (k: string) => (k === '/b' ? 0 : Number.MAX_SAFE_INTEGER);
    const more: RailRow<S>[] = [...rows, { kind: 'session', key: '/c', session: s(3, '/c') }];
    expect(applyStableOrder(more, indexOf).map(r => r.key)).toEqual(['/b', '/a', '/c']);
  });

  it('does not mutate the array it is given', () => {
    const before = rows.map(r => r.key);
    applyStableOrder(rows, () => 0);
    expect(rows.map(r => r.key)).toEqual(before);
  });
});
