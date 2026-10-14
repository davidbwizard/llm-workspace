import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mocks.handlers.set(name, fn) } }));
import { registerPreviewIpc, openSessionPreview } from '../../src/main/remote/previewIpc.ts';
import { SessionOperations } from '../../src/main/sessionOperations.ts';
beforeEach(() => mocks.handlers.clear());
function setup() {
  let active = true;
  const identity = { pid: 11, sessionId: 'thread', provider: 'codex' as const, started: 'original', tmux: 'owned' };
  const operations = new SessionOperations({ list: () => [{ ...identity, cwd: '/project' }], identity: () => active ? identity : null,
    projects: () => [], conversation: () => null, live: () => null, send: async () => null, answerClaude: () => null, answerCodex: () => null, launch: () => null });
  const open = vi.fn(async (_project: string, _url: unknown, _current?: () => boolean) => ({ ok: true as const, url: 'https://mac.tail.ts.net:8444/' }));
  const frame = {}; const sender = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: sender };
  registerPreviewIpc({ window: () => window as any, operations: () => operations, open });
  return { operations, open, event: { sender, senderFrame: frame }, close: () => { active = false; }, invoke: (...args: any[]) => mocks.handlers.get('remote:preview:open')!(...args) };
}
it('binds a user request to a current session and exposes revocation to setup', async () => {
  const f = setup();
  expect(await f.invoke(f.event, 11, 'thread', 'http://localhost:5199/')).toMatchObject({ ok: true });
  expect(f.open).toHaveBeenCalledWith('/project', 'http://localhost:5199/', expect.any(Function));
  const current = f.open.mock.calls[0]![2]!; expect(current()).toBe(true); f.close(); expect(current()).toBe(false);
});
it('rejects foreign frames, stale sessions and non-loopback URLs before setup', async () => {
  const f = setup();
  expect(await f.invoke({ ...f.event, senderFrame: {} }, 11, 'thread', 'http://localhost:5199/')).toMatchObject({ ok: false });
  expect(await f.invoke(f.event, 11, 'other-thread', 'http://localhost:5199/')).toMatchObject({ ok: false });
  expect(await f.invoke(f.event, 11, 'thread', 'http://example.com:5199/')).toMatchObject({ ok: false });
  f.close();
  expect(await f.invoke(f.event, 11, 'thread', 'http://localhost:5199/')).toMatchObject({ ok: false });
  expect(f.open).not.toHaveBeenCalled();
});
it('rejects an expired mobile session handle before setup', async () => {
  const f = setup(); const handle = f.operations.list()[0]!.handle!; f.close();
  expect(await openSessionPreview(f.operations, f.open, handle, 'http://localhost:5199/')).toMatchObject({ ok: false });
  expect(f.open).not.toHaveBeenCalled();
});
