import { expect, it, vi } from 'vitest';
import { SessionActions } from '../../src/main/sessionActions.ts';
import type { OperationResult } from '../../src/core/remote.ts';
it('deduplicates an in-flight request and rejects changing its body', async () => {
  const actions = new SessionActions(); let calls = 0;
  const effect = async (): Promise<OperationResult> => ({ ok: true, value: ++calls });
  const results = await Promise.all([actions.run('s', 'r', 'body', effect), actions.run('s', 'r', 'body', effect)]);
  expect(calls).toBe(1); expect(results[0]).toEqual(results[1]);
  expect(await actions.run('s', 'r', 'other', effect)).toMatchObject({ ok: false, reason: 'invalid' });
  actions.close();
});
it('serializes devices on one session while allowing another session through', async () => {
  const actions = new SessionActions(); const order: number[] = [];
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  const first = actions.run('s', 'a', 'a', async () => { order.push(1); await gate; return { ok: true, value: 1 }; });
  const second = actions.run('s', 'b', 'b', async () => { order.push(2); return { ok: true, value: 2 }; });
  await actions.run('other', 'c', 'c', async () => ({ ok: true, value: 3 }));
  expect(order).toEqual([1]); unblock(); await Promise.all([first, second]); expect(order).toEqual([1, 2]); actions.close();
});
it('claims a prompt once and bounds receipts without evicting accepted requests', async () => {
  const actions = new SessionActions({ capacity: 1 });
  expect(actions.claimPrompt('s', 'p')).toBe(true); expect(actions.claimPrompt('s', 'p')).toBe(false);
  await actions.run('s', 'a', 'a', async () => ({ ok: true, value: 1 }));
  expect(await actions.run('s', 'b', 'b', async () => ({ ok: true, value: 2 }))).toMatchObject({ ok: false, reason: 'busy' });
  actions.close();
});
it('does not leave the next operation blocked by a thrown effect', async () => {
  const actions = new SessionActions();
  expect(await actions.run('s', 'a', 'a', async () => { throw new Error('connection dropped'); })).toMatchObject({ ok: false, reason: 'uncertain' });
  expect(await actions.run('s', 'b', 'b', async () => ({ ok: true, value: 2 }))).toMatchObject({ ok: true }); actions.close();
});
it('expires queued work without replaying it after the active action finishes', async () => {
  vi.useFakeTimers();
  const actions = new SessionActions({ queueTimeoutMs: 20 }); let unblock!: () => void;
  const first = actions.run('s', 'a', 'a', async () => { await new Promise<void>(r => { unblock = r; }); return { ok: true, value: 1 }; });
  await Promise.resolve();
  const effect = vi.fn(async (): Promise<OperationResult> => ({ ok: true, value: 2 }));
  const second = actions.run('s', 'b', 'b', effect); await vi.advanceTimersByTimeAsync(21);
  expect(await second).toMatchObject({ ok: false, reason: 'busy' }); unblock(); await first;
  expect(effect).not.toHaveBeenCalled(); actions.close(); vi.useRealTimers();
});
