import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionOperations, type SessionIdentity } from '../../src/main/sessionOperations.ts';
function fixture() {
  let identity: SessionIdentity | null = { pid: 10, sessionId: 's1', provider: 'codex', started: 'start1', tmux: 'llmws-codex-a' };
  const send = vi.fn(async () => ({ status: 'sent' }));
  const operations = new SessionOperations({
    list: () => [{ pid: 10, sessionId: 's1', cwd: '/repo', provider: 'codex' }],
    identity: () => identity, projects: () => [],
    conversation: vi.fn(async () => ({ turns: [] })), live: vi.fn(() => null),
    send, answerClaude: vi.fn(), answerCodex: vi.fn(), launch: vi.fn(),
  });
  return { operations, send, change: (next: SessionIdentity | null) => { identity = next; } };
}
it('uses opaque handles and rejects reused PIDs before input', async () => {
  const f = fixture(); const handle = f.operations.list()[0]!.handle!;
  expect(handle).not.toBe('10');
  expect(await f.operations.mutate('phone', 'send', { handle: '10', text: 'hello' })).toMatchObject({ ok: false });
  f.change({ pid: 10, sessionId: 's1', provider: 'codex', started: 'reused', tmux: 'llmws-codex-a' });
  expect(await f.operations.mutate('phone', 'send', { handle, text: 'hello' })).toMatchObject({ ok: false, reason: 'stale' });
  expect(f.send).not.toHaveBeenCalled();
});
it('rejects changed thread or tmux binding and never guesses by cwd', async () => {
  const f = fixture(); const handle = f.operations.list()[0]!.handle!;
  f.change({ pid: 10, sessionId: 's2', provider: 'codex', started: 'start1', tmux: 'llmws-codex-a' });
  expect(f.operations.resolve(handle)).toBeNull();
  const replacement = f.operations.list()[0]!.handle!;
  f.change({ pid: 10, sessionId: 's2', provider: 'codex', started: 'start1', tmux: 'llmws-codex-b' });
  expect(f.operations.resolve(replacement)).toBeNull();
});
it('passes only bounded validated input to the existing operation', async () => {
  const f = fixture(); const handle = f.operations.list()[0]!.handle!;
  expect(await f.operations.mutate('phone', 'send', { handle, text: 'hello' })).toMatchObject({ ok: true });
  expect(f.send).toHaveBeenCalledWith(10, 'hello', 's1', 'phone');
  expect(await f.operations.mutate('phone', 'send', { handle, text: 12 })).toMatchObject({ ok: false, reason: 'invalid' });
});
it('does not permit mutation of a discovered non-tmux session', async () => {
  const f = fixture(); f.change({ pid: 10, sessionId: 's1', provider: 'codex', started: 'start1', tmux: null });
  const handle = f.operations.list()[0]!.handle!;
  expect(await f.operations.mutate('phone', 'send', { handle, text: 'hello' })).toMatchObject({ ok: false, reason: 'unsupported' });
});
it('refuses a project whose symlink target changed after listing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-projects-'));
  try {
    mkdirSync(join(root, 'a')); mkdirSync(join(root, 'b')); symlinkSync(join(root, 'a'), join(root, 'link'));
    const f = fixture(); const launch = vi.fn();
    const o = new SessionOperations({ ...f.operations.dependencies, projects: () => [join(root, 'link')], launch });
    const project = o.projects()[0]!.id;
    rmSync(join(root, 'link')); symlinkSync(join(root, 'b'), join(root, 'link'));
    expect(await o.mutate('phone', 'launch', { project, provider: 'codex' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(launch).not.toHaveBeenCalled();
  } finally { rmSync(root, { recursive: true }); }
});
it('never binds a stale display row to a newly verified conversation', async () => {
  const f = fixture();
  f.change({ pid: 10, sessionId: 's2', provider: 'codex', started: 'start1', tmux: 'llmws-codex-a' });
  const row = f.operations.list()[0]!;
  expect(row.handle).toBeNull(); expect(row.controllable).toBe(false);
  expect(await f.operations.mutate('phone', 'send', { handle: row.handle, text: 'draft for s1' })).toMatchObject({ ok: false });
  expect(f.send).not.toHaveBeenCalled();
});
it('marks known favourites in the project list without exposing launch paths as authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-favorites-'));
  try {
    const f = fixture();
    const operations = new SessionOperations({ ...f.operations.dependencies, projects: () => [root], favorites: () => [root] });
    const project = operations.projects()[0]!;
    expect(project.favorite).toBe(true); expect(project.id).not.toBe(root); expect(operations.projectPath(project.id)).toBe(realpathSync(root));
  } finally { rmSync(root, { recursive: true }); }
});
