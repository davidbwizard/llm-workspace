import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionLive } from '../../src/renderer/state/useSessionLive.ts';

// A single fake session:live payload. `pid` is the only field these tests
// vary -- version/sessionId are carried along because a real payload always
// has them, not because any test here reads them. `prompt` defaults to
// null, same as a real payload whenever nothing is open (Task 5:
// SessionLivePayload.prompt).
function payload(overrides: Partial<{ pid: number; activity: 'working' | 'idle' | 'waiting' | null; since: number | null; events: number; prompt: unknown }> = {}) {
  return {
    version: 1,
    pid: 4821,
    sessionId: 's1',
    activity: 'working' as const,
    since: 1_700_000_000_000,
    events: 3,
    prompt: null,
    ...overrides,
  };
}

describe('useSessionLive', () => {
  it('watches on mount and stops on unmount', () => {
    const watchSession = vi.fn().mockResolvedValue(true);
    (globalThis as any).window.fleet = { watchSession, onSessionLive: () => () => {} };
    const { unmount } = renderHook(() => useSessionLive(4821));
    expect(watchSession).toHaveBeenCalledWith(4821);
    unmount();
    expect(watchSession).toHaveBeenLastCalledWith(null);
    delete (globalThis as any).window.fleet;
  });

  it('reports null until a payload for this pid actually arrives', () => {
    const watchSession = vi.fn().mockResolvedValue(true);
    (globalThis as any).window.fleet = { watchSession, onSessionLive: () => () => {} };
    const { result } = renderHook(() => useSessionLive(4821));
    expect(result.current).toBeNull();
    delete (globalThis as any).window.fleet;
  });

  it('applies a payload that matches the watched pid', () => {
    let push: (p: unknown) => void = () => {};
    const watchSession = vi.fn().mockResolvedValue(true);
    const onSessionLive = vi.fn((cb: (p: unknown) => void) => { push = cb; return () => {}; });
    (globalThis as any).window.fleet = { watchSession, onSessionLive };
    const { result } = renderHook(() => useSessionLive(4821));
    act(() => { push(payload({ pid: 4821, activity: 'working', since: 111, events: 3 })); });
    expect(result.current).toEqual({ activity: 'working', since: 111, events: 3, prompt: null });
    delete (globalThis as any).window.fleet;
  });

  // Task 5: the prompt card reads live.prompt straight off this hook, so a
  // non-null PromptView on the payload must come through unchanged, not be
  // dropped the way an unlisted field would be.
  it('passes a non-null prompt through unchanged', () => {
    let push: (p: unknown) => void = () => {};
    const watchSession = vi.fn().mockResolvedValue(true);
    const onSessionLive = vi.fn((cb: (p: unknown) => void) => { push = cb; return () => {}; });
    (globalThis as any).window.fleet = { watchSession, onSessionLive };
    const { result } = renderHook(() => useSessionLive(4821));
    const prompt = { id: 'evt-1', kind: 'permission', answerable: true, reason: null };
    act(() => { push(payload({ pid: 4821, prompt })); });
    expect(result.current?.prompt).toEqual(prompt);
    delete (globalThis as any).window.fleet;
  });

  // The whole point of filtering: a push arriving for a pid this hook
  // instance was never asked to watch (e.g. a stale send racing a pid
  // change) must not be mistaken for this session's own state. A hook that
  // stored any payload it received regardless of pid would pass every
  // other test in this file identically to the real filter, which is why
  // this one exists on its own.
  it('ignores a payload for a different pid', () => {
    let push: (p: unknown) => void = () => {};
    const watchSession = vi.fn().mockResolvedValue(true);
    const onSessionLive = vi.fn((cb: (p: unknown) => void) => { push = cb; return () => {}; });
    (globalThis as any).window.fleet = { watchSession, onSessionLive };
    const { result } = renderHook(() => useSessionLive(4821));
    act(() => { push(payload({ pid: 9999, activity: 'working', since: 222, events: 7 })); });
    expect(result.current).toBeNull();
    delete (globalThis as any).window.fleet;
  });

  // main's own watch (src/main/sessionLive.ts's watchState) is a single
  // module-level slot, not one per pid -- switching sessions must tear the
  // old watch down before starting the new one, never leave both running.
  it('moves the watch to a new pid, unsubscribing the old listener first', () => {
    const watchSession = vi.fn().mockResolvedValue(true);
    const unsub = vi.fn();
    const onSessionLive = vi.fn().mockReturnValue(unsub);
    (globalThis as any).window.fleet = { watchSession, onSessionLive };
    const { rerender } = renderHook(({ pid }) => useSessionLive(pid), { initialProps: { pid: 4821 } });
    rerender({ pid: 5555 });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(watchSession.mock.calls.map(c => c[0])).toEqual([4821, null, 5555]);
    delete (globalThis as any).window.fleet;
  });

  // A stale payload for the PREVIOUS pid, arriving after a pid change but
  // before that change's own re-subscribe filters it out, must not be
  // shown as the new pid's state either.
  it('drops a state reset back to null when pid changes, even with a payload already applied', () => {
    let push: (p: unknown) => void = () => {};
    const watchSession = vi.fn().mockResolvedValue(true);
    const onSessionLive = vi.fn((cb: (p: unknown) => void) => { push = cb; return () => {}; });
    (globalThis as any).window.fleet = { watchSession, onSessionLive };
    const { result, rerender } = renderHook(({ pid }) => useSessionLive(pid), { initialProps: { pid: 4821 } });
    act(() => { push(payload({ pid: 4821, events: 3 })); });
    expect(result.current).toEqual({ activity: 'working', since: 1_700_000_000_000, events: 3, prompt: null });

    rerender({ pid: 5555 });
    expect(result.current).toBeNull();
    delete (globalThis as any).window.fleet;
  });

  // ConversationView.tsx renders this hook on every mount, including in
  // dozens of existing tests whose window.fleet stub only carries
  // `conversation`. A hook that assumed watchSession/onSessionLive always
  // exist alongside window.fleet would throw and take the whole render down
  // with it -- the same defensive guard ConversationView.tsx's own
  // LinkedImage/UserText already apply to window.fleet.image/attachments.
  it('reports null without throwing when the bridge is missing watchSession', () => {
    (globalThis as any).window.fleet = { conversation: vi.fn() };
    const { result } = renderHook(() => useSessionLive(4821));
    expect(result.current).toBeNull();
    delete (globalThis as any).window.fleet;
  });

  it('reports null without throwing when there is no bridge at all', () => {
    delete (globalThis as any).window.fleet;
    const { result } = renderHook(() => useSessionLive(4821));
    expect(result.current).toBeNull();
  });
});
