import { describe, it, expect, vi, beforeEach } from 'vitest';
import { launchSession, reattachSession, resumeSession } from '../../src/main/launch.ts';
import { clearRegistry, tmuxNameForPid } from '../../src/main/sessions.ts';

beforeEach(() => clearRegistry());

describe('launchSession', () => {
  it('names the session so it is findable in tmux ls, and registers the pid', () => {
    const calls: string[][] = [];
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 4821,
    });
    expect(r).toEqual({ status: 'launched', pid: 4821 });
    const name = tmuxNameForPid(4821)!;
    expect(name).toMatch(/^llmws-claude-[A-Za-z0-9_-]+$/);
    expect(calls[0]).toContain('new-session');
  });

  it('passes the size at creation, since tmux never learns it otherwise', () => {
    const calls: string[][] = [];
    launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 1,
    });
    expect(calls[0]).toContain('-x'); expect(calls[0]).toContain('120');
    expect(calls[0]).toContain('-y'); expect(calls[0]).toContain('40');
  });

  it('never sends a key after launching -- a blind Enter picks "No, exit"', () => {
    const calls: string[][] = [];
    launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 1,
    });
    expect(calls.some(c => c.includes('send-keys'))).toBe(false);
  });

  it('reports failure rather than registering a session that never started', () => {
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: () => ({ ok: false, error: 'tmux: no server' }),
      panePid: () => null,
    });
    expect(r.status).toBe('failed');
  });

  // Mutation 3, restated concretely per the controller's ruling: "register
  // the pid before checking started.ok" is not well-formed (pid does not
  // exist yet at that point in the original wording) -- the concrete form
  // is skipping the `if (!started.ok) return` guard entirely and
  // registering whatever panePid returns. panePid is mocked independently
  // of exec in this DI shape, so it can return a real-looking pid even
  // though new-session itself failed -- exactly the case that distinguishes
  // "the guard ran" from "the guard was skipped". The test above (status is
  // 'failed') is NOT enough on its own: a mutated version missing the guard
  // could still end up reporting 'failed' for other reasons while having
  // ALREADY registered a phantom entry along the way. Asserting the
  // registry directly is what actually catches that.
  it('never leaves a phantom registry entry when tmux new-session itself failed', () => {
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: () => ({ ok: false, error: 'tmux: no server' }),
      panePid: () => 4821,
    });
    expect(r.status).toBe('failed');
    expect(tmuxNameForPid(4821)).toBeNull();
  });

  it('runs claude --resume <id> as the pane command when reattachSession asks for it, not a bare claude', () => {
    const calls: string[][] = [];
    launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 1,
    }, 'claude --resume abc-123');
    expect(calls[0]).toContain('claude --resume abc-123');
    expect(calls[0]).not.toContain('claude');
  });
});

describe('reattachSession', () => {
  function deps(overrides: Partial<{
    exec: (a: string[]) => { ok: true; stdout: string } | { ok: false; error: string };
    panePid: () => number | null;
    kill: ReturnType<typeof vi.fn>;
    resolveSession: (pid: number) => { sessionId: string; provider: 'claude' | 'codex'; cwd: string } | null;
  }> = {}) {
    return {
      exec: overrides.exec ?? ((a: string[]) => ({ ok: true as const, stdout: '' })),
      panePid: overrides.panePid ?? (() => 9001),
      kill: overrides.kill ?? vi.fn(async () => ({ status: 'killed' as const })),
      resolveSession: overrides.resolveSession
        ?? (() => ({ sessionId: 'abc-123', provider: 'claude' as const, cwd: '/a/proj' })),
    };
  }

  it('kills the old process, then launches --resume in its own cwd, as one call', async () => {
    const calls: string[][] = [];
    const d = deps({ exec: (a) => { calls.push(a); return { ok: true, stdout: '' }; } });
    const r = await reattachSession(4821, 120, 40, d);
    expect(d.kill).toHaveBeenCalledWith(4821);
    expect(r).toEqual({ status: 'launched', pid: 9001 });
    expect(calls[0]).toContain('claude --resume abc-123');
    expect(calls[0]).toContain('/a/proj');
  });

  it('treats "already gone" the same as "killed" -- either way, the old process is confirmed not running', async () => {
    const d = deps({ kill: vi.fn(async () => ({ status: 'already_gone' as const })) });
    const r = await reattachSession(4821, 120, 40, d);
    expect(r.status).toBe('launched');
  });

  // The core atomicity guarantee: a refused kill must never be followed by
  // a launch, so the renderer can never observe (or cause) "old session
  // dead, new one never started" -- because the old one is never touched.
  it('refuses and never launches when the kill is refused', async () => {
    const calls: string[][] = [];
    const d = deps({
      exec: (a) => { calls.push(a); return { ok: true, stdout: '' }; },
      kill: vi.fn(async () => ({ status: 'refused' as const, reason: 'not_discovered' as const })),
    });
    const r = await reattachSession(4821, 120, 40, d);
    expect(r.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('refuses a codex session with a reason the UI can show, and never touches the old process at all', async () => {
    const d = deps({ resolveSession: () => ({ sessionId: 'abc-123', provider: 'codex', cwd: '/a' }) });
    const r = await reattachSession(4821, 120, 40, d);
    expect(r).toEqual({ status: 'failed', reason: expect.stringMatching(/codex/i) });
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('refuses when the pid cannot be resolved to any session', async () => {
    const r = await reattachSession(4821, 120, 40, {});
    expect(r.status).toBe('failed');
  });

  it('refuses rather than guessing how to end the session when no kill function is injected', async () => {
    const r = await reattachSession(4821, 120, 40, {
      resolveSession: () => ({ sessionId: 'abc-123', provider: 'claude', cwd: '/a' }),
    });
    expect(r.status).toBe('failed');
  });

  // Defence in depth: sessionId reaches a shell string tmux hands to its
  // own shell (launchSession's `command` argument -- there is no argv
  // escape from tmux's single trailing shell-command argument). A session
  // id containing shell metacharacters must be refused before that string
  // is ever built, and before the old process is touched.
  it('refuses a session id with an unexpected shape rather than building a command from it', async () => {
    const d = deps({ resolveSession: () => ({ sessionId: '$(rm -rf ~)', provider: 'claude', cwd: '/a' }) });
    const r = await reattachSession(4821, 120, 40, d);
    expect(r.status).toBe('failed');
    expect(d.kill).not.toHaveBeenCalled();
  });

  // Fix-wave item 5: the old process is confirmed gone (kill succeeded) but
  // the relaunch itself then fails -- this MUST be distinguishable from an
  // ordinary 'failed' (item 5's problem 1: "your session is gone and
  // nothing replaced it" vs "nothing happened yet" demand opposite
  // reactions), and it MUST carry what a retry needs (problem 2: the pid is
  // already gone from resolveSession's own cache by the time this is
  // reachable, so a retry cannot re-derive sessionId/cwd from it).
  it('reports a distinct killed_not_relaunched state, carrying the session id and cwd, when the kill succeeds but the relaunch fails', async () => {
    const d = deps({ exec: () => ({ ok: false as const, error: 'tmux: server exited mid-relaunch' }) });
    const r = await reattachSession(4821, 120, 40, d);
    expect(r).toEqual({
      status: 'killed_not_relaunched',
      reason: 'tmux: server exited mid-relaunch',
      sessionId: 'abc-123',
      cwd: '/a/proj',
    });
  });

  // The recovery path actually works from the dead pid's own resolved
  // sessionId/cwd -- proven by using ONLY those two values below, with no
  // pid and no resolveSession involved at all, exactly as a retry button
  // would call it after the test above's result.
  it('resumeSession relaunches from a killed_not_relaunched result\'s sessionId/cwd alone, no pid required', () => {
    const calls: string[][] = [];
    const r = resumeSession('abc-123', '/a/proj', 120, 40, {
      exec: (a) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 9001,
    });
    expect(r).toEqual({ status: 'launched', pid: 9001 });
    expect(calls[0]).toContain('claude --resume abc-123');
    expect(calls[0]).toContain('/a/proj');
  });
});

describe('resumeSession', () => {
  it('refuses a malformed session id rather than building a command from it', () => {
    const calls: string[][] = [];
    const r = resumeSession('$(rm -rf ~)', '/a/proj', 120, 40, {
      exec: (a) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 1,
    });
    expect(r.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('reports an ordinary failure, not killed_not_relaunched, when the relaunch itself fails -- there is no old process here to have killed', () => {
    const r = resumeSession('abc-123', '/a/proj', 120, 40, {
      exec: () => ({ ok: false, error: 'tmux: no server' }),
      panePid: () => null,
    });
    expect(r).toEqual({ status: 'failed', reason: 'tmux: no server' });
  });
});
