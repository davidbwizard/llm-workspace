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
