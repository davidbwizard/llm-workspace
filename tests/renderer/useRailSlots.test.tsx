import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRailSlots, mostUrgentMember } from '../../src/renderer/state/useRailSlots.ts';
import { reloadGroups, rememberKeys, moveRow, toggleStack } from '../../src/renderer/state/groups.ts';
import { reloadSettings, setSettings } from '../../src/renderer/state/settings.ts';

// A minimal OpenSession fixture -- same shape and `as never[]` escape hatch
// SessionRail.test.tsx already uses, since useRailSlots only ever reads the
// handful of fields compareOpenSessions/railSections/groupByFolder need
// (pid, cwd, activity, junk, events), not the full contract.
const s = (pid: number, cwd: string, activity: string | null = null) =>
  ({ pid, cwd, activity, junk: false, project: `p${pid}`, provider: 'claude', events: null });

beforeEach(() => {
  localStorage.clear();
  reloadGroups();
  reloadSettings();
});

// These four are the branch's own mutation-test list for the slot feature:
// dragging changes a slot's occupant, closing slot 1 promotes the next row
// into it, opening a stack renumbers nothing, and every member of a stack
// reports the stack's own number. Each is written so it fails for a
// SPECIFIC wrong implementation, named in its own comment -- "what would I
// break to make this go red".
describe('useRailSlots -- the four mutation targets', () => {
  it('MUTATION 1: dragging a row changes which pid holds a slot number', () => {
    const sessions = [s(1, '/a'), s(2, '/b'), s(3, '/c')] as never[];
    // Simulates the rail's own first-render effect (SessionRail.tsx's
    // rememberKeys) -- moveRow is a no-op on a key the store has never
    // seen, so without this the drag below would silently do nothing and
    // the test would pass for the wrong reason (both sides of the
    // assertion staying at their starting values).
    rememberKeys(['/a', '/b', '/c']);
    const { result } = renderHook(() => useRailSlots(sessions));
    expect(result.current.slotByPid.get(1)).toBe(1);
    expect(result.current.slotByPid.get(3)).toBe(3);

    // The same call SessionRail's own drop handler and its Move up/down
    // menu items make (groups.ts's moveRow) -- drags row '/a' into the slot
    // '/c' currently occupies, shifting '/b' and '/c' up one.
    act(() => { moveRow('/a', '/c'); });

    // Would read {1:1, 2:2, 3:3} unchanged (this test would then fail to
    // fail) under a wrong implementation that ranks by the INPUT array's
    // own index (like the old, removed orderedSessions) rather than by
    // groups.ts's stored order -- proving this is the stored-order path,
    // not a re-derivation of array position.
    expect(result.current.slotByPid.get(2)).toBe(1); // '/b' shifted up
    expect(result.current.slotByPid.get(3)).toBe(2); // '/c' shifted up
    expect(result.current.slotByPid.get(1)).toBe(3); // '/a' (dragged) now last
  });

  it('MUTATION 2: closing the session in slot 1 promotes the next one into slot 1', () => {
    const sessions = [s(1, '/a'), s(2, '/b'), s(3, '/c')] as never[];
    rememberKeys(['/a', '/b', '/c']);
    const { result, rerender } = renderHook(
      ({ list }: { list: never[] }) => useRailSlots(list), { initialProps: { list: sessions } },
    );
    expect(result.current.slotByPid.get(1)).toBe(1);

    // pid 1 "closed" -- simply no longer present in the next push, the same
    // way a dead process drops out of payload.openSessions.
    const afterClose = sessions.filter(session => (session as { pid: number }).pid !== 1) as never[];
    rerender({ list: afterClose });

    // A fixed-per-pid map (the removed behaviour) would instead show pid 2
    // still carrying "2" and leave slot 1 with no occupant at all.
    expect(result.current.slotByPid.get(2)).toBe(1);
    expect(result.current.slotByPid.get(3)).toBe(2);
    expect(result.current.slotByPid.has(1)).toBe(false);
  });

  it('MUTATION 3: opening a stack renumbers nothing, including rows below it', () => {
    // '/repo' holds two sessions (a stack); '/other' is a plain row after it.
    const sessions = [s(1, '/repo'), s(2, '/repo'), s(3, '/other')] as never[];
    rememberKeys(['/repo', '/other']);
    const { result } = renderHook(() => useRailSlots(sessions));
    expect(result.current.slotByPid.get(1)).toBe(1);
    expect(result.current.slotByPid.get(2)).toBe(1);
    expect(result.current.slotByPid.get(3)).toBe(2);

    act(() => { toggleStack('/repo'); }); // open it

    // A wrong implementation that gives an OPEN stack's members their own
    // numbers (rather than treating an open stack as still one slot) would
    // make pid 2 read "2" here and push '/other' to "3" -- exactly what this
    // asserts did NOT happen.
    expect(result.current.slotByPid.get(1)).toBe(1);
    expect(result.current.slotByPid.get(2)).toBe(1);
    expect(result.current.slotByPid.get(3)).toBe(2);
  });

  it('MUTATION 4: every member of a stack reports the stack’s own slot number', () => {
    const sessions = [s(1, '/repo'), s(2, '/repo'), s(3, '/repo'), s(4, '/other')] as never[];
    rememberKeys(['/repo', '/other']);
    const { result } = renderHook(() => useRailSlots(sessions));
    const stackSlot = result.current.slotByPid.get(1);
    expect(stackSlot).toBe(1);
    // A wrong implementation that numbers only the FIRST member (or drops
    // the rest entirely) would fail one of these two.
    expect(result.current.slotByPid.get(2)).toBe(stackSlot);
    expect(result.current.slotByPid.get(3)).toBe(stackSlot);
    expect(result.current.slotByPid.get(4)).toBe(2);
  });
});

describe('useRailSlots -- other properties', () => {
  it('gives a folder with one session the loose row treatment, not a stack', () => {
    const sessions = [s(1, '/repo')] as never[];
    const { result } = renderHook(() => useRailSlots(sessions));
    expect(result.current.rows).toEqual([{ kind: 'session', key: '/repo', session: sessions[0] }]);
  });

  it('caps numbering at nine rows and leaves the rest unmapped', () => {
    const sessions = Array.from({ length: 11 }, (_, i) => s(i + 1, `/p${i + 1}`)) as never[];
    const { result } = renderHook(() => useRailSlots(sessions));
    expect(result.current.slotByPid.get(9)).toBe(9);
    expect(result.current.slotByPid.has(10)).toBe(false);
    expect(result.current.slotByPid.has(11)).toBe(false);
  });

  it('gives folder-mates their own separate slots once groupSessions is off', () => {
    const sessions = [s(1, '/repo'), s(2, '/repo')] as never[];
    setSettings({ groupSessions: 'off' });
    const { result } = renderHook(() => useRailSlots(sessions));
    // The setting is folder STACKING only (order.ts's own railSections doc
    // comment) -- with it off, two sessions sharing a folder are two rows,
    // not one, so they no longer share a slot either.
    expect(result.current.slotByPid.get(1)).toBe(1);
    expect(result.current.slotByPid.get(2)).toBe(2);
  });
});

// mostUrgentMember is what App.tsx's Cmd+N handler calls to pick a target
// inside a stack. Tested here with a members array where the waiting one is
// DELIBERATELY placed second, not first -- through the real pipeline
// (useRailSlots above, or App.tsx), a stack's own `members` array already
// happens to arrive waiting-first (compareOpenSessions sorts blocked-first,
// BEFORE groupByFolder ever runs), which would make a test built from that
// real pipeline pass identically whether or not this function's own
// `.find()` actually runs -- exactly the "passing for the wrong reason"
// trap this branch has hit before. Calling the function directly, on a
// members array this test controls by hand, is what makes the assertion
// depend on the `.find()`, not on an incidental fact about two OTHER
// modules' sort order.
describe('mostUrgentMember', () => {
  it('picks the waiting member even when it is not first', () => {
    const idle = s(1, '/repo', 'idle');
    const waiting = s(2, '/repo', 'waiting_input');
    expect(mostUrgentMember([idle, waiting] as never[])).toBe(waiting);
  });

  it('falls back to the first member when none are waiting', () => {
    const first = s(1, '/repo', 'idle');
    const second = s(2, '/repo', 'working');
    expect(mostUrgentMember([first, second] as never[])).toBe(first);
  });

  it('treats waiting_permission the same as waiting_input', () => {
    const idle = s(1, '/repo', 'idle');
    const waiting = s(2, '/repo', 'waiting_permission');
    expect(mostUrgentMember([idle, waiting] as never[])).toBe(waiting);
  });
});
