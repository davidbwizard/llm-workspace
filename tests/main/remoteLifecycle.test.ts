import { expect, it, vi } from 'vitest';
import { RemoteLifecycle } from '../../src/main/remote/lifecycle.ts';
import { DEFAULT_REMOTE } from '../../src/main/remote/config.ts';
it('keeps disabled default, preserves invalid settings, and closes once', async () => {
  const close = vi.fn(async () => {}); const start = vi.fn(async () => ({ close })); const save = vi.fn();
  const lifecycle = new RemoteLifecycle({ read: () => DEFAULT_REMOTE, save, start });
  await lifecycle.initialize(); expect(start).not.toHaveBeenCalled();
  await expect(lifecycle.configure({ ...DEFAULT_REMOTE, enabled: true })).rejects.toThrow(); expect(save).not.toHaveBeenCalled();
  const valid = { ...DEFAULT_REMOTE, enabled: true, origin: 'https://mac.tail.ts.net', login: 'owner' };
  await lifecycle.configure(valid); expect(lifecycle.status().state).toBe('ready');
  await lifecycle.configure(valid); expect(start).toHaveBeenCalledTimes(1);
  await lifecycle.configure({ ...valid, enabled: false }); expect(close).toHaveBeenCalledTimes(1);
  await lifecycle.close(); expect(close).toHaveBeenCalledTimes(1);
});
it('reports a listener failure instead of claiming readiness', async () => {
  const lifecycle = new RemoteLifecycle({ read: () => ({ ...DEFAULT_REMOTE, enabled: true, origin: 'https://mac.tail.ts.net', login: 'owner' }), save() {}, start: async () => { throw new Error('Port in use'); } });
  await lifecycle.initialize(); expect(lifecycle.status()).toMatchObject({ state: 'error', error: 'Port in use' });
});
it('updates preview routes without disconnecting the phone that requested them', async () => {
  const initial = { ...DEFAULT_REMOTE, enabled: true, origin: 'https://mac.tail.ts.net', login: 'owner' };
  const close = vi.fn(async () => {}); const start = vi.fn(async () => ({ close }));
  const lifecycle = new RemoteLifecycle({ read: () => initial, save() {}, start });
  await lifecycle.initialize();
  const next = { ...initial, previews: [{ id: 'site', project: '/tmp', label: 'Site', localPort: 5199, url: 'https://mac.tail.ts.net:8444' }] };
  await lifecycle.configureIfCurrent(next, initial);
  expect(lifecycle.status().config.previews).toEqual(next.previews);
  expect(close).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(1);
});
it('rejects preview setup when settings changed while its external mapping was being created', async () => {
  const initial = { ...DEFAULT_REMOTE, enabled: true, origin: 'https://mac.tail.ts.net', login: 'owner' };
  const save = vi.fn(); const lifecycle = new RemoteLifecycle({ read: () => initial, save, start: async () => ({ close: async () => {} }) });
  await lifecycle.initialize();
  const disabling = lifecycle.configure({ ...initial, enabled: false });
  const stale = lifecycle.configureIfCurrent(initial, initial);
  await disabling;
  await expect(stale).rejects.toThrow('changed');
  expect(lifecycle.status().config.enabled).toBe(false);
  expect(save).toHaveBeenCalledTimes(1);
});

it('reports starting while the previous service is still draining on a same-port restart', async () => {
  const initial = { ...DEFAULT_REMOTE, enabled: true, origin: 'https://mac.tail.ts.net', login: 'owner' };
  let release!: () => void;
  const draining = new Promise<void>(resolve => { release = resolve; });
  const close = vi.fn(() => draining);
  const lifecycle = new RemoteLifecycle({ read: () => initial, save() {}, start: async () => ({ close }) });
  await lifecycle.initialize();
  const restarting = lifecycle.configure({ ...initial, login: 'new-owner' });
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(lifecycle.status().state).toBe('starting');
  release();
  await restarting;
  expect(lifecycle.status().state).toBe('ready');
});
