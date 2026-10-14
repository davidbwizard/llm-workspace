import { afterEach, expect, it, vi } from 'vitest';
import * as live from '../../src/main/sessionLive.ts';
import type { WatchDeps, SessionLivePayload } from '../../src/main/sessionLive.ts';
const clients = ['desktop', 'phone', 'tablet'];
afterEach(() => { for (const id of clients) live.releaseSessionClient?.(id); vi.useRealTimers(); });
function fixture(pid: number) {
  let sessionId = `session-${pid}`;
  const close = vi.fn();
  const on = vi.fn();
  const watch = vi.fn(() => ({ close, on }));
  const send = vi.fn();
  const onClose = vi.fn();
  const buildPayload = vi.fn((): SessionLivePayload => ({ version: 1, pid, sessionId, activity: 'idle', since: null, events: 0, prompt: null, context: null, mode: null }));
  const deps: WatchDeps = { processes: () => [{ pid, provider: 'claude', cwd: '/repo', host: 'unknown', tty: null }], buildPayload, send, onClose, watch };
  return { deps, close, watch, send, onClose, buildPayload, change: (id: string) => { sessionId = id; } };
}
it('keeps two selected sessions live independently', () => {
  const a = fixture(10); const b = fixture(11);
  expect(typeof live.subscribeSession).toBe('function');
  live.subscribeSession('desktop', 10, a.deps);
  live.subscribeSession('phone', 11, b.deps);
  live.pushSessionLive();
  expect(a.send).toHaveBeenCalledTimes(2);
  expect(b.send).toHaveBeenCalledTimes(2);
  live.releaseSessionClient('phone');
  live.pushSessionLive();
  expect(a.send).toHaveBeenCalledTimes(3);
  expect(a.close).not.toHaveBeenCalled();
});
it('shares a watcher and releases only the last subscriber', () => {
  const a = fixture(10); const b = fixture(10);
  live.subscribeSession('desktop', 10, a.deps);
  live.subscribeSession('phone', 10, b.deps);
  expect(a.watch).toHaveBeenCalledTimes(1);
  expect(b.watch).not.toHaveBeenCalled();
  live.releaseSessionClient('desktop');
  expect(a.onClose).toHaveBeenCalledOnce();
  expect(a.close).not.toHaveBeenCalled();
  live.pushSessionLive();
  expect(b.send).toHaveBeenCalledTimes(2);
  live.releaseSessionClient('phone');
  expect(a.close).toHaveBeenCalledOnce();
});
it('retains the old subscription on invalid selection and tracks changed identity', () => {
  vi.useFakeTimers();
  const a = fixture(10);
  live.subscribeSession('phone', 10, a.deps);
  expect(live.subscribeSession('phone', 999, a.deps)).toBe(false);
  a.change('cleared'); live.pushSessionLive();
  live.notifySessionChanged(new Set(['cleared']));
  vi.advanceTimersByTime(250);
  expect(a.send).toHaveBeenCalledTimes(3);
  expect(a.close).not.toHaveBeenCalled();
});
