import { describe, it, expect, vi, beforeEach } from 'vitest';
import { launchSession, launchCodexSession, reattachSession, resumeSession, launchCommand, shellQuote } from '../../src/main/launch.ts';
import { SESSION_NAME_MAX } from '../../src/core/sessionName.ts';
import { clearRegistry, tmuxNameForPid, registerSession, launchedAtForPid } from '../../src/main/sessions.ts';
import { killSession } from '../../src/main/ipc.ts';
import type { ExecFn } from '../../src/discovery/live.ts';

beforeEach(() => clearRegistry());

describe('launchCodexSession', () => {
  it('starts a persistent relay and a native TUI rooted in the selected directory', async () => {
    const relay = vi.fn();
    const calls: string[][] = [];
    const result = await launchCodexSession('/tmp/pilot', 120, 40, {
      startDaemon: async () => {}, startRelay: relay, waitRelay: async () => true,
      socketHome: '/tmp/home', executable: '/bin/node', relayScript: '/tmp/relay.js',
      exec: args => { calls.push(args); return { ok: true, stdout: '' }; },
      panePid: () => 4821,
    });
    expect(result).toEqual({ status: 'launched', pid: 4821 });
    const tuiName = tmuxNameForPid(4821)!;
    expect(relay.mock.calls[0]![0]).toBe(`fleet-codex-relay-${tuiName.slice('llmws-codex-relay-'.length)}`);
    expect(calls[0]).toContain(tuiName);
    expect(calls[0]!.at(-1)).toContain("codex -C '/tmp/pilot' --remote 'unix:///tmp/home/.llm-workspace/codex-relays/");
  });

  it('does not create a TUI when the local relay cannot start', async () => {
    const exec = vi.fn(() => ({ ok: true as const, stdout: '' }));
    const result = await launchCodexSession('/tmp/pilot', 120, 40, {
      startDaemon: async () => {}, startRelay: () => {}, waitRelay: async () => false,
      exec, socketHome: '/tmp/home',
    });
    expect(result).toEqual({ status: 'failed', reason: 'Codex relay did not open its local socket' });
    expect(exec).not.toHaveBeenCalled();
  });
});

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

  // BUG 2 (terminal scroll): tmux's mouse support is off by default, so a
  // freshly created session must have it turned on for itself alone --
  // '-t', never '-g' (which would edit the user's own tmux config for
  // every session on the machine, not just this one).
  it('turns mouse mode on for the new session alone, never globally', () => {
    const calls: string[][] = [];
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 4821,
    });
    expect(r).toEqual({ status: 'launched', pid: 4821 });
    const name = tmuxNameForPid(4821)!;
    expect(calls).toEqual(expect.arrayContaining([
      ['set-option', '-t', `=${name}:`, 'mouse', 'on'],
    ]));
    expect(calls.flat()).not.toContain('-g');
  });

  // tmux's own status line otherwise renders inside the app's terminal
  // (reported as a literal "[llmws-claude-...:[tmux]" row at the bottom
  // once a real client attaches) -- pure noise inside an app with its own
  // chrome. Same '-t'-alone discipline as the mouse option above.
  it('turns the tmux status bar off for the new session alone, never globally', () => {
    const calls: string[][] = [];
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 4821,
    });
    expect(r).toEqual({ status: 'launched', pid: 4821 });
    const name = tmuxNameForPid(4821)!;
    // Mutation target: a '-t' -> '-g' swap must fail this, since that is
    // the difference between a local setting and editing the user's own
    // tmux config for every session on the machine.
    expect(calls).toEqual(expect.arrayContaining([
      ['set-option', '-t', `=${name}:`, 'status', 'off'],
    ]));
    expect(calls.flat()).not.toContain('-g');
  });

  // The set-option call must never run when creation itself failed -- there
  // is no session left to scope it to.
  it('never sets the mouse option when new-session itself fails', () => {
    const calls: string[][] = [];
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: false, error: 'tmux: no server' }; },
      panePid: () => null,
    });
    expect(r.status).toBe('failed');
    expect(calls.some(c => c.includes('set-option'))).toBe(false);
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

  // Bug 2 (Conversation-identification fix): the registry needs a launch
  // timestamp, not just the pid->name mapping, so src/fleet/state.ts's
  // openSessionsLive can later disambiguate this pid's own session. `now`
  // is injected here (rather than asserting against real Date.now(), which
  // this test can't pin precisely) the same way exec/panePid already are.
  it('records the launch timestamp it was given, so the app can later disambiguate its own session', () => {
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => ({ ok: true, stdout: '' }),
      panePid: () => 4821,
      now: 1_700_000_000_000,
    });
    expect(r).toEqual({ status: 'launched', pid: 4821 });
    expect(launchedAtForPid(4821)).toBe(1_700_000_000_000);
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
    hasTranscript: (sessionId: string, cwd: string) => boolean;
  }> = {}) {
    return {
      exec: overrides.exec ?? ((a: string[]) => ({ ok: true as const, stdout: '' })),
      panePid: overrides.panePid ?? (() => 9001),
      kill: overrides.kill ?? vi.fn(async () => ({ status: 'killed' as const })),
      resolveSession: overrides.resolveSession
        ?? (() => ({ sessionId: 'abc-123', provider: 'claude' as const, cwd: '/a/proj' })),
      hasTranscript: overrides.hasTranscript,
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

  // Fix wave F2: exact identity can now resolve a session that has never
  // been resumed successfully -- right after launch, or right after
  // /clear, before its first message. `claude --resume` refuses ("No
  // conversation found") for such a session (measured 2026-09-15), so this
  // must be checked BEFORE the kill, not learned only after the old
  // process is already gone.
  it('refuses before killing when the session has no saved conversation yet', async () => {
    const d = deps({ hasTranscript: () => false });
    const r = await reattachSession(4821, 120, 40, d);
    expect(r).toEqual({ status: 'failed', reason: expect.stringMatching(/no saved conversation/) });
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('proceeds to kill and launch as normal when a saved conversation exists', async () => {
    const d = deps({ hasTranscript: () => true });
    const r = await reattachSession(4821, 120, 40, d);
    expect(d.kill).toHaveBeenCalledWith(4821);
    expect(r).toEqual({ status: 'launched', pid: 9001 });
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

  // Whole-branch review, item 1: reattachSession's own kill step is always
  // the REAL killSession in production (src/main/ipc.ts wires `kill:
  // killSession`) -- every other test above mocks `kill`, which proves the
  // atomicity contract but can't prove the registry side effect killSession
  // itself now has. This uses the real function (with safe injected
  // discovery/signal fakes, never a real process) to prove the OLD pid's
  // registry entry is actually gone once reattach's kill step runs, not
  // merely that the kill was reported as successful.
  it('clears the old pid from the tmux registry once reattach kills it, through the real killSession', async () => {
    registerSession(4821, 'llmws-claude-old');
    const noAncestors = async () => '';
    const exec: ExecFn = async (bin, args) => (bin === 'ps' && args[0] === '-axo' ? '4821 claude\n' : '');
    const realKill = (pid: number) => killSession(pid, { hop: noAncestors, exec, signal: vi.fn() });

    const r = await reattachSession(4821, 120, 40, {
      kill: realKill,
      resolveSession: () => ({ sessionId: 'abc-123', provider: 'claude', cwd: '/a/proj' }),
      exec: () => ({ ok: true, stdout: '' }),
      panePid: () => 9001,
    });

    expect(r).toEqual({ status: 'launched', pid: 9001 });
    expect(tmuxNameForPid(4821)).toBeNull();
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

// The session name is the one launch input a PERSON types free-hand, and
// newSession (src/main/tmux.ts) hands its command to `tmux new-session` as
// a single string, which tmux runs through a SHELL. So the name is a trust
// boundary, not a label. Both halves of the defence are tested here: the
// character set that rejects, and the quoting that would still hold if the
// character set were ever loosened.
describe('launchCommand', () => {
  it('launches the bare provider when no name is given -- blank is normal', () => {
    expect(launchCommand('claude', null)).toEqual({ ok: true, command: 'claude' });
    expect(launchCommand('claude', '')).toEqual({ ok: true, command: 'claude' });
    expect(launchCommand('codex', null)).toEqual({ ok: true, command: 'codex' });
  });

  it('runs `claude -n` with the name single-quoted', () => {
    expect(launchCommand('claude', 'FLEET STUFF')).toEqual({ ok: true, command: "claude -n 'FLEET STUFF'" });
  });

  it('accepts the shape of a name Claude derives for itself', () => {
    expect(launchCommand('claude', 'llm-workspace-4a')).toEqual({ ok: true, command: "claude -n 'llm-workspace-4a'" });
  });

  it('accepts a name at the length cap and rejects one past it', () => {
    const atCap = 'a'.repeat(SESSION_NAME_MAX);
    expect(launchCommand('claude', atCap).ok).toBe(true);
    const overCap = launchCommand('claude', 'a'.repeat(SESSION_NAME_MAX + 1));
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.reason).toMatch(new RegExp(String(SESSION_NAME_MAX)));
  });

  it('refuses a name for Codex, and says why rather than dropping it silently', () => {
    const r = launchCommand('codex', 'FLEET STUFF');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Codex has no way to set a name when it starts/i);
  });

  // Each case is named for the character that makes it dangerous, so a
  // regression names itself in the test output.
  describe('refuses a name a shell would act on, rather than mangling it', () => {
    const attacks: [label: string, name: string][] = [
      ['a semicolon', 'proj; rm -rf ~'],
      ['a command substitution $()', 'proj$(rm -rf ~)'],
      ['a bare dollar', 'proj $HOME'],
      ['backticks', 'proj`rm -rf ~`'],
      ['a single quote', "proj' ; rm -rf ~ ; '"],
      ['a double quote', 'proj" ; rm -rf ~ ; "'],
      ['a newline', 'proj\nrm -rf ~'],
      ['a carriage return', 'proj\rrm -rf ~'],
      ['a pipe', 'proj | rm -rf ~'],
      ['an ampersand', 'proj && rm -rf ~'],
      ['a redirect', 'proj > /etc/passwd'],
      ['a glob', 'proj/*'],
      ['a backslash', 'proj\\x'],
      ['a NUL byte', 'proj x'],
      ['an escape byte', 'proj[2J'],
    ];
    for (const [label, name] of attacks) {
      it(`rejects ${label}`, () => {
        const r = launchCommand('claude', name);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/letters, numbers/i);
      });
    }
  });

  // A name starting with '-' would be read by `claude` itself as another
  // FLAG, not as the value of -n. Nothing shell-special about it, which is
  // exactly why it needs its own rule.
  it('rejects a name that would read as a flag', () => {
    expect(launchCommand('claude', '--dangerously-skip-permissions').ok).toBe(false);
    expect(launchCommand('claude', '-p').ok).toBe(false);
  });

  it('rejects surrounding whitespace rather than silently trimming it', () => {
    expect(launchCommand('claude', ' proj').ok).toBe(false);
    expect(launchCommand('claude', 'proj ').ok).toBe(false);
    expect(launchCommand('claude', '\tproj').ok).toBe(false);
  });

  // The quoting is the second half of the defence and is tested on its own,
  // not only through the character set above: if SESSION_NAME_SAFE were
  // ever widened, this is what still has to hold.
  it('quotes any string safely, independently of what the character set lets through', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('a;b')).toBe("'a;b'");
    expect(shellQuote('$(x)')).toBe("'$(x)'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('launchSession with a name', () => {
  it('passes `claude -n <quoted name>` to tmux as the new session command', () => {
    const calls: string[][] = [];
    const cmd = launchCommand('claude', 'FLEET STUFF');
    expect(cmd.ok).toBe(true);
    if (!cmd.ok) return;
    launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 4821,
    }, cmd.command);
    expect(calls[0]?.at(-1)).toBe("claude -n 'FLEET STUFF'");
  });
});
