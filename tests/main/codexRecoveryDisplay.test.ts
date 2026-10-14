import { homedir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CodexRecoveryDisplay } from '../../src/main/codexRecoveryRuntime.ts';
import { CodexRecovery, type RecoveryDeps } from '../../src/main/codexRecovery.ts';
const NAME = 'llmws-codex-relay-aaaaaaaa';
const ID = '01a0da03-b7a1-7542-a9b9-e325e92c221f';
const binding = JSON.stringify({ v: 1, state: 'ready', threadId: ID, updatedAt: 1000 });
function fixture() {
  const deps: RecoveryDeps = {
    resolve: () => null, resolveName: () => null, read: () => null, write: () => false,
    repair: async () => {}, launch: async () => ({ status: 'failed', reason: 'unused' }), exhausted: () => false,
  };
  const processLine = `11 codex codex --remote unix://${homedir()}/.llm-workspace/codex-relays/${NAME}.sock`;
  const read = vi.fn(async (command: string) => command === 'tmux'
    ? `${NAME}\t11\t/repo\t${binding}\t\t\t\t\nfleet-codex-relay-aaaaaaaa\t12\t/repo\t\t\t\t\t`
    : processLine);
  const recovery = new CodexRecovery(deps);
  const display = new CodexRecoveryDisplay(recovery, { read, nameForPid: () => NAME });
  return { deps, read, recovery, display, processLine };
}
it('coalesces asynchronous inventory and keeps repeated display pushes free of subprocess reads', async () => {
  const f = fixture();
  const first = f.display.refresh(), second = f.display.refresh();
  expect(second).toBe(first);
  await first;
  expect(f.read).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 100; i++) {
    expect(f.display.connection(11)).toMatchObject({ state: 'ready' });
    expect(f.display.thread(11)).toBe(ID);
    expect(f.display.needsAdvance(11)).toBe(false);
    expect(f.display.replacements()).toEqual([]);
  }
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.recovery.inputRefusal(11, ID)).toBe('codex_not_ready');
});
it('clears previously ready display metadata if an inventory read fails', async () => {
  const f = fixture(); await f.display.refresh();
  f.read.mockRejectedValueOnce(new Error('tmux unavailable'));
  await expect(f.display.refresh()).rejects.toThrow('tmux unavailable');
  expect(f.display.connection(11)).toMatchObject({ state: 'unknown', recoverable: false });
  expect(f.display.thread(11)).toBe(false);
});
it('preserves conversation identity when Finder supplies no UTF-8 locale', async () => {
  const f = fixture();
  const rows = `${NAME}\t11\t/repo\t${binding}\t\t\t\t\nfleet-codex-relay-aaaaaaaa\t12\t/repo\t\t\t\t\t`;
  // Captured from tmux 3.7c with LANG/LC_ALL unset: without -u, tabs
  // become underscores, including the trailing empty inventory fields.
  const read = async (command: string, args: string[]) => command === 'tmux'
    ? args.includes('-u') ? rows : rows.replaceAll('\t', '_')
    : f.processLine;
  const display = new CodexRecoveryDisplay(f.recovery, { read, nameForPid: () => NAME });
  await display.refresh();
  expect(display.thread(11)).toBe(ID);
  expect(display.connection(11)).toMatchObject({ state: 'ready', recoverable: true });
});
it('uses the first pane of a session, matching fresh ownership resolution', async () => {
  const f = fixture();
  f.read.mockResolvedValueOnce(`${NAME}\t11\t/repo\t${binding}\t\t\t\t\n${NAME}\t99\t/repo\t\t\t\t\t\nfleet-codex-relay-aaaaaaaa\t12\t/repo\t\t\t\t\t`);
  await f.display.refresh();
  expect(f.display.connection(11)?.state).toBe('ready');
  expect(f.display.thread(11)).toBe(ID);
});
it('takes a new inventory after a mutation even when an older sweep is still reading', async () => {
  const f = fixture();
  let release!: (value: string) => void;
  f.read.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const prior = f.display.refresh();
  const afterMutation = f.display.refresh(true);
  release(`${NAME}\t11\t/repo\t${binding}\t\t\t\tpending\nfleet-codex-relay-aaaaaaaa\t12\t/repo\t\t\t\t\t`);
  await prior;
  expect(f.display.connection(11)?.inputPending).toBe(true);
  await afterMutation;
  expect(f.display.connection(11)?.inputPending).toBeUndefined();
  expect(f.read).toHaveBeenCalledTimes(4);
});
it('quarantines orphan candidates even when their parent process cannot resolve', async () => {
  const f = fixture();
  const parent = 'llmws-codex-relay-bbbbbbbb';
  const m = JSON.stringify({ v: 1, candidate: NAME, candidateSince: 1000, expectedThreadId: ID });
  f.read.mockImplementation(async command => command === 'tmux'
    ? `${NAME}\t11\t/repo\t${binding}\t\t\t\t\n${parent}\t22\t/repo\t\t\t\t${m}\tpending\nfleet-codex-relay-aaaaaaaa\t12\t/repo\t\t\t\t\t`
    : f.processLine);
  await f.display.refresh();
  expect(f.display.connection(11)?.state).not.toBe('ready');
  expect(f.display.needsAdvance(11)).toBe(true);
});
it('does not repeatedly advance a preserved predecessor while its confirmed successor is ready', async () => {
  const f = fixture();
  const old = 'llmws-codex-relay-bbbbbbbb';
  const own = JSON.stringify({ v: 1, predecessor: old, expectedThreadId: ID, confirmed: true });
  const previous = JSON.stringify({ v: 1, successor: NAME, expectedThreadId: ID });
  const disconnected = JSON.stringify({ v: 1, state: 'disconnected', threadId: ID, updatedAt: 1000 });
  f.read.mockImplementation(async command => command === 'tmux'
    ? `${NAME}\t11\t/repo\t${binding}\t\t\t${own}\t\n${old}\t22\t/repo\t${disconnected}\t\t\t${previous}\t\nfleet-codex-relay-aaaaaaaa\t12\t/repo\t\t\t\t\t`
    : `${f.processLine}\n22 codex codex --remote unix://${homedir()}/.llm-workspace/codex-relays/${old}.sock`);
  await f.display.refresh();
  expect(f.display.connection(11)).toMatchObject({ state: 'ready', previousTerminalPid: 22 });
  expect(f.display.needsAdvance(22)).toBe(false);
  expect(f.display.replacements()).toEqual([{ previousPid: 22, pid: 11, sessionId: ID }]);
});
it('cannot remove an action coordinator failure result while inspecting an unresolved display snapshot', async () => {
  const f = fixture();
  const tui = { pid: 11, name: NAME, cwd: '/repo', binding: { name: NAME, threadId: ID, ready: false, relayAlive: false, binding: null } };
  f.deps.resolve = () => tui; f.deps.resolveName = () => tui;
  f.deps.read = () => 'invalid metadata';
  await f.recovery.recover(11);
  f.recovery.inspect([], { resolve: () => null, resolveName: () => null, read: () => null, names: () => [] });
  expect(f.recovery.connection(11)?.state).toBe('failed');
});
