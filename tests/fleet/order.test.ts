import { describe, it, expect } from 'vitest';
import { rowKey, groupByFolder, applyStableOrder, railSections, pidRowKey, type RailRow } from '../../src/fleet/order.ts';

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

type C = { pid: number; cwd: string | null; sessionId: string | null };
const c = (pid: number, cwd: string | null, sessionId: string | null): C => ({ pid, cwd, sessionId });
// railSections never reads sessionId itself -- the caller's lookup decides
// what a category hangs off, which is what lets Task 8 add the launch-time
// pending fallback without changing this transform at all. These helpers
// stand in for groups.ts's categoryForRow.
const byId = (f: (id: string) => string | null) => (s: C) => (s.sessionId === null ? null : f(s.sessionId));
const noOrder = () => Number.MAX_SAFE_INTEGER;

describe('railSections', () => {
  it('returns one unnamed section when nothing is categorised', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')], () => null, noOrder, true);
    expect(got.map(sec => sec.name)).toEqual([null]);
    expect(got[0]!.rows.map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('returns nothing for no sessions', () => {
    expect(railSections([], () => null, noOrder, true)).toEqual([]);
  });

  // The core ruling: three in one folder, one categorised.
  it('pulls a categorised session out of its folder, leaving a stack of the rest', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/a', 's2'), c(3, '/a', 's3')];
    const got = railSections(sessions, byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
    expect(got[0]!.rows).toHaveLength(1);
    expect(got[0]!.rows[0]!.kind).toBe('session');
    expect(got[0]!.rows[0]!.key).toBe(pidRowKey(2));
    const rest = got[1]!.rows[0]!;
    if (rest.kind !== 'stack') throw new Error('expected a stack');
    expect(rest.members.map(m => m.pid)).toEqual([1, 3]);
  });

  it('leaves a plain card, not a stack of one, when the pull-out empties the folder', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/a', 's2')];
    const got = railSections(sessions, byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got[1]!.rows[0]!.kind).toBe('session');
    expect(got[1]!.rows[0]!.key).toBe('/a');
  });

  it('leaves no uncategorised section at all when the folder empties completely', () => {
    const got = railSections([c(1, '/a', 's1')], () => 'Review', noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review']);
  });

  it('gives each categorised session its own row, never a stack, even in one folder', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')], () => 'Review', noOrder, true);
    expect(got).toHaveLength(1);
    expect(got[0]!.rows.map(r => r.kind)).toEqual(['session', 'session']);
  });

  // The case a shared repo actually produces: both sessions carry their own
  // id (applyExactMatches resolved each pid from its live session file), so
  // they file separately and the folder is left with nothing to stack.
  it('splits two sessions in ONE folder into two different sections', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')],
      byId(id => (id === 's1' ? 'Review' : 'Shipping')), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', 'Shipping']);
    expect(got[0]!.rows.map(r => r.key)).toEqual([pidRowKey(1)]);
    expect(got[1]!.rows.map(r => r.key)).toEqual([pidRowKey(2)]);
  });

  it('puts the uncategorised section LAST, however early its rows appear', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/b', 's2')];
    const got = railSections(sessions, byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
  });

  it('orders named sections by where their first row sits', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/b', 's2')];
    const index = (k: string) => (k === pidRowKey(2) ? 0 : 1);
    const got = railSections(sessions, byId(id => (id === 's1' ? 'One' : 'Two')), index, true);
    expect(got.map(sec => sec.name)).toEqual(['Two', 'One']);
  });

  it('honours the stored order inside a section', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/b', 's2')];
    // Both sessions carry the same category, so both are pulled out and
    // keyed by pid (the pull-out rule) -- the stored-order lookup has to be
    // compared against THAT key, not the folder path neither row keeps once
    // pulled out. Same fix as the "orders named sections" test just above,
    // which already gets this right (deviation from the brief: that draft
    // compared against '/b', a key that can never occur here).
    const index = (k: string) => (k === pidRowKey(2) ? 0 : 1);
    const got = railSections(sessions, () => 'One', index, true);
    expect(got[0]!.rows.map(r => r.key)).toEqual([pidRowKey(2), pidRowKey(1)]);
  });

  // Whether a session can be categorised at all is the LOOKUP's business,
  // not this transform's -- which is what lets Task 8 add the launch-time
  // pending fallback without touching a line here. This only proves the
  // transform respects whatever the lookup says.
  it('leaves a session in its folder whenever the lookup declines it', () => {
    const got = railSections([c(1, '/a', null), c(2, '/a', 's2')],
      byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
    expect(got[1]!.rows[0]!.key).toBe('/a');
  });

  it('treats a blank category name as no category', () => {
    const got = railSections([c(1, '/a', 's1')], () => '', noOrder, true);
    expect(got.map(sec => sec.name)).toEqual([null]);
  });
});

// The setting is folder stacking and nothing else: sections and manual order
// still apply with it off.
describe('railSections with stacking off', () => {
  it('gives each session in a shared folder its own row', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')], () => null, noOrder, false);
    expect(got[0]!.rows.map(r => r.kind)).toEqual(['session', 'session']);
  });

  // They cannot share the folder key -- two rows with one key collide in
  // React's reconciler and in the stored order alike.
  it('keys those rows by pid, since the folder key belongs to neither alone', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')], () => null, noOrder, false);
    expect(got[0]!.rows.map(r => r.key)).toEqual(['pid:1', 'pid:2']);
  });

  it('leaves a folder holding ONE session on its folder key, so its position survives', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')], () => null, noOrder, false);
    expect(got[0]!.rows.map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('still heads a categorised session with its category', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')],
      byId(id => (id === 's1' ? 'Review' : null)), noOrder, false);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
  });

  it('still honours the stored order', () => {
    const index = (k: string) => (k === '/b' ? 0 : 1);
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')], () => null, index, false);
    expect(got[0]!.rows.map(r => r.key)).toEqual(['/b', '/a']);
  });
});
