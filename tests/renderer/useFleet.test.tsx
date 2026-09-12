import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useFleet } from '../../src/renderer/state/useFleet.ts';

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
