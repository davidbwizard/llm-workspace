import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useFleet } from '../../src/renderer/state/useFleet.ts';
import {
  reloadGroups, assignCategory, categoryOfSession, bindPendingCategory,
} from '../../src/renderer/state/groups.ts';

describe('useFleet selection', () => {
  it('starts with nothing selected, so the grid renders full width', () => {
    const { result } = renderHook(() => useFleet());
    expect(result.current.selection).toBeNull();
  });

  it('selects a pid and defaults to the conversation view, not the raw terminal', () => {
    const { result } = renderHook(() => useFleet());
    act(() => result.current.select(4821));
    expect(result.current.selection).toEqual({ pid: 4821, view: 'conversation' });
  });

  it('switches view without losing the selection', () => {
    const { result } = renderHook(() => useFleet());
    act(() => result.current.select(4821));
    act(() => result.current.setView('terminal'));
    expect(result.current.selection).toEqual({ pid: 4821, view: 'terminal' });
  });

  it('clears back to the grid', () => {
    const { result } = renderHook(() => useFleet());
    act(() => result.current.select(4821));
    act(() => result.current.clear());
    expect(result.current.selection).toBeNull();
  });
});

// This subscription used to live inside FleetView's own private useEffect
// (FleetView.tsx:47-68, before this task); these tests moved here with it --
// not deleted, since a real behavioural guarantee (a rejected fleet:list
// call must surface a message, never hang forever) still needs to hold
// somewhere, and this is now where the fetch itself happens.
describe('useFleet payload', () => {
  it('fetches the fleet list on mount', async () => {
    const listFleet = vi.fn().mockResolvedValue({ version: 1, generatedAt: 't', openSessions: [] });
    (globalThis as any).window.fleet = { listFleet, onFleet: vi.fn().mockReturnValue(() => {}) };
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.payload).toEqual({ version: 1, generatedAt: 't', openSessions: [] }));
    delete (globalThis as any).window.fleet;
  });

  it('subscribes to live updates and unsubscribes on unmount', async () => {
    const unsub = vi.fn();
    const onFleet = vi.fn().mockReturnValue(unsub);
    (globalThis as any).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({ version: 1, generatedAt: 't', openSessions: [] }),
      onFleet,
    };
    const { unmount } = renderHook(() => useFleet());
    await waitFor(() => expect(onFleet).toHaveBeenCalled());
    unmount();
    expect(unsub).toHaveBeenCalled();
    delete (globalThis as any).window.fleet;
  });

  it('reports a specific error, not an endless load, when the bridge is missing', () => {
    delete (globalThis as any).window.fleet;
    const { result } = renderHook(() => useFleet());
    expect(result.current.error).toBe('bridge unavailable');
    expect(result.current.payload).toBeNull();
  });

  // The realistic case in this app today for at least one channel at a
  // time (see FleetView.tsx's own former comment on this): main has no
  // handler registered yet, so ipcRenderer.invoke REJECTS rather than
  // hanging. A rejection with no reject handler becomes an unhandled
  // promise rejection, not a state update -- `payload` would stay null
  // forever, indistinguishable on screen from a slow load.
  it('surfaces the rejection message instead of leaving payload null forever', async () => {
    const listFleet = vi.fn().mockRejectedValue(new Error("No handler registered for 'fleet:list'"));
    (globalThis as any).window.fleet = { listFleet, onFleet: vi.fn().mockReturnValue(() => {}) };
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.error).toBe("No handler registered for 'fleet:list'"));
    expect(result.current.payload).toBeNull();
    delete (globalThis as any).window.fleet;
  });
});

// Cmd+1..9 and the shared hotkey number (OpenSessionCard's cmdIndex, wired
// through App.tsx) both key off this one ranking -- "same numbering
// everywhere... in sidebar order", so this mirrors SessionRail's own
// unread-promotion sort (tests/renderer/SessionRail.test.tsx's "relevance
// ordering" describe block covers that comparator itself in depth; these
// prove useFleet's own copy of it behaves the same way).
describe('useFleet orderedSessions', () => {
  const session = (over: Partial<Record<string, unknown>>) => ({
    pid: 1, project: 'p', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/a',
    junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: null,
    tmux: false, context: null, match: 'unknown', ...over,
  });

  function push(onFleet: ReturnType<typeof vi.fn>, sessions: unknown[]): void {
    const handler = onFleet.mock.calls[0]![0] as (p: unknown) => void;
    act(() => handler({ version: 1, generatedAt: 't', openSessions: sessions }));
  }

  it('is empty before the payload has loaded', () => {
    delete (globalThis as any).window.fleet;
    const { result } = renderHook(() => useFleet());
    expect(result.current.orderedSessions).toEqual([]);
  });

  it('matches payload order when nothing is unread or blocked', async () => {
    const onFleet = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({
        version: 1, generatedAt: 't',
        openSessions: [session({ pid: 1 }), session({ pid: 2 }), session({ pid: 3 })],
      }),
      onFleet,
    };
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.orderedSessions).toHaveLength(3));
    expect(result.current.orderedSessions.map(s => s.pid)).toEqual([1, 2, 3]);
    delete (globalThis as any).window.fleet;
  });

  it('promotes a session whose events grow while it is not selected, same as the sidebar', async () => {
    const onFleet = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({
        version: 1, generatedAt: 't',
        openSessions: [session({ pid: 1 }), session({ pid: 2 }), session({ pid: 3 })],
      }),
      onFleet,
    };
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.orderedSessions).toHaveLength(3));
    push(onFleet, [session({ pid: 1 }), session({ pid: 2, events: 15 }), session({ pid: 3 })]);
    await waitFor(() => expect(result.current.orderedSessions.map(s => s.pid)).toEqual([2, 1, 3]));
    delete (globalThis as any).window.fleet;
  });

  it('never promotes the currently selected session, even as its own events grow', async () => {
    const onFleet = vi.fn().mockReturnValue(() => {});
    (globalThis as any).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({
        version: 1, generatedAt: 't',
        openSessions: [session({ pid: 1 }), session({ pid: 2 })],
      }),
      onFleet,
    };
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.orderedSessions).toHaveLength(2));
    act(() => result.current.select(1));
    push(onFleet, [session({ pid: 1, events: 15 }), session({ pid: 2 })]);
    expect(result.current.orderedSessions.map(s => s.pid)).toEqual([1, 2]);
    delete (globalThis as any).window.fleet;
  });
});

describe('useFleet category bookkeeping', () => {
  const session = (pid: number, sessionId: string | null) => ({
    pid, sessionId, provider: 'claude', host: 'iterm2', cwd: '/a', project: 'a',
    name: null, ageSeconds: 1, rssBytes: 1, match: 'unique', lastProse: null,
    events: null, agents: null, liveAgents: null, activity: 'idle', tmux: false,
    junk: false, context: null,
  });

  function pushFleet(openSessions: unknown[]) {
    const listFleet = vi.fn().mockResolvedValue({ version: 1, generatedAt: 't', openSessions });
    (globalThis as any).window.fleet = { listFleet, onFleet: vi.fn().mockReturnValue(() => {}) };
    return renderHook(() => useFleet());
  }

  beforeEach(() => { localStorage.clear(); reloadGroups(); });
  afterEach(() => { delete (globalThis as any).window.fleet; });

  it('transfers a launch-time binding the first time the push carries a session id', async () => {
    bindPendingCategory(4821, 'Fleet');
    const { result } = pushFleet([session(4821, 's9')]);
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    await waitFor(() => expect(categoryOfSession('s9')).toBe('Fleet'));
  });

  // The whole of "it can be temp": /clear mints an id that was never
  // assigned, and an exited session stops appearing in the push.
  it('prunes an assignment whose session is no longer in the push', async () => {
    assignCategory('gone', 'Fleet');
    assignCategory('s9', 'Fleet');
    const { result } = pushFleet([session(4821, 's9')]);
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    await waitFor(() => expect(categoryOfSession('gone')).toBeNull());
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  it('prunes nothing on an empty push, which is also what "not discovered yet" looks like', async () => {
    assignCategory('s9', 'Fleet');
    const { result } = pushFleet([]);
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    expect(categoryOfSession('s9')).toBe('Fleet');
  });
});
