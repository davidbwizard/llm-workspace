import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { spawn as realPtySpawn, type IPty } from 'node-pty';
import {
  attachTerminal, detachTerminal, detachAllTerminals, resizeTerminal, sendRawFor,
} from '../../src/main/ipc.ts';
import { registerSession, clearRegistry } from '../../src/main/sessions.ts';
import { newSession, type TmuxResult } from '../../src/main/tmux.ts';

function fakeWin(sent: unknown[]) {
  return {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, payload: unknown) => sent.push(payload) },
  } as unknown as Parameters<typeof attachTerminal>[3];
}

/** A stand-in IPty for tests that only need to prove THIS module's own
 *  wiring (which argv/env it spawns with, that a resize/write/kill reaches
 *  the pty it created, that onData feeds the coalescer) without a real
 *  tmux process underneath. Deliberately NOT used for the properties the
 *  real-tmux suite below exists to prove (a real resize actually moving
 *  tmux's own pane, a real kill leaving the real session alive) -- mocked
 *  tests alone have missed every serious defect in this project's last
 *  three phases (this project's own history), so anything about tmux's
 *  actual behaviour is asserted only against the real binary. */
function fakePty() {
  const onDataHandlers: Array<(chunk: string) => void> = [];
  const onExitHandlers: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  const resizeCalls: Array<{ cols: number; rows: number }> = [];
  const writeCalls: string[] = [];
  const killCalls: Array<string | undefined> = [];
  const pty = {
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'tmux',
    handleFlowControl: false,
    onData: (cb: (chunk: string) => void) => { onDataHandlers.push(cb); return { dispose() {} }; },
    onExit: (cb: (event: { exitCode: number; signal?: number }) => void) => { onExitHandlers.push(cb); return { dispose() {} }; },
    resize: (cols: number, rows: number) => { resizeCalls.push({ cols, rows }); },
    clear: () => {},
    write: (data: string) => { writeCalls.push(data); },
    kill: (signal?: string) => { killCalls.push(signal); },
    pause: () => {},
    resume: () => {},
  } as unknown as IPty;
  return { pty, onDataHandlers, onExitHandlers, resizeCalls, writeCalls, killCalls };
}

// Every fake-pty attachTerminal call below now reaches setSessionOption
// (BUG 2: mouse-scroll) on its way to spawning. A plain no-op stub keeps
// this suite hermetic -- without it, an uninjected `setOption` falls back
// to tmux.ts's own real defaultExec, a genuine subprocess call against a
// session that (in this suite) was never actually created in real tmux.
function noopOption(): TmuxResult {
  return { ok: true, stdout: '' };
}

function optionSpy() {
  const calls: string[][] = [];
  return { calls, setOption: (args: string[]): TmuxResult => { calls.push(args); return { ok: true, stdout: '' }; } };
}

function fakeSpawn(instance: ReturnType<typeof fakePty>) {
  const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const spawn = ((file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    return instance.pty;
  }) as typeof realPtySpawn;
  return { spawn, calls };
}

// ---------------------------------------------------------------------
// Refusal paths -- pure, no real tmux, no pty spawned: every one of these
// returns before attachTerminal/resizeTerminal/sendRawFor ever gets to
// node-pty's own spawn, mirroring sendKeysFor's own refusal-path tests in
// ipc.test.ts.
// ---------------------------------------------------------------------

describe('attachTerminal refusals', () => {
  beforeEach(() => clearRegistry());
  const sent: unknown[] = [];
  const win = fakeWin(sent);

  it('refuses an invalid pid', async () => {
    expect(await attachTerminal(-1, 80, 24, win)).toEqual({ status: 'refused', reason: 'invalid_pid' });
    expect(await attachTerminal(1.5, 80, 24, win)).toEqual({ status: 'refused', reason: 'invalid_pid' });
  });

  it('refuses a pid with no tmux session -- the iTerm case', async () => {
    expect(await attachTerminal(4821, 80, 24, win)).toEqual({ status: 'refused', reason: 'not_tmux' });
  });

  it('refuses when the session vanished between render and click', async () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(await attachTerminal(4821, 80, 24, win, { has: () => false }))
      .toEqual({ status: 'refused', reason: 'session_gone' });
  });

  it('refuses a non-positive-integer size before ever spawning a pty', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const { spawn, calls } = fakeSpawn(fakePty());
    expect(await attachTerminal(4821, 0, 24, win, { has: () => true, spawn, setOption: noopOption }))
      .toEqual({ status: 'refused', reason: 'invalid_size' });
    expect(await attachTerminal(4821, 80, -1, win, { has: () => true, spawn, setOption: noopOption }))
      .toEqual({ status: 'refused', reason: 'invalid_size' });
    expect(await attachTerminal(4821, 80.5, 24, win, { has: () => true, spawn, setOption: noopOption }))
      .toEqual({ status: 'refused', reason: 'invalid_size' });
    expect(calls).toHaveLength(0);
  });
});

describe('detachTerminal idempotency', () => {
  it('is a no-op success for a pid that was never attached', () => {
    expect(detachTerminal(999999)).toEqual({ status: 'detached' });
  });

  it('is a no-op success for a malformed pid too', () => {
    expect(detachTerminal('nope')).toEqual({ status: 'detached' });
  });
});

describe('resizeTerminal refusals', () => {
  beforeEach(() => clearRegistry());

  it('refuses an invalid pid', () => {
    expect(resizeTerminal(-1, 80, 24)).toEqual({ status: 'refused', reason: 'invalid_pid' });
  });

  it('refuses a non-positive-integer size before resolving the session', () => {
    expect(resizeTerminal(4821, 0, 24)).toEqual({ status: 'refused', reason: 'invalid_size' });
  });

  it('refuses a pid with no tmux session', () => {
    expect(resizeTerminal(4821, 80, 24)).toEqual({ status: 'refused', reason: 'not_tmux' });
  });

  it('refuses when the session vanished', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(resizeTerminal(4821, 80, 24, { has: () => false }))
      .toEqual({ status: 'refused', reason: 'session_gone' });
  });

  // A live, resolvable tmux session is not enough on its own: without a
  // pty this app actually attached, there is nothing to call .resize() on.
  it('refuses a live session with no attachment yet, rather than throwing', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(resizeTerminal(4821, 100, 40, { has: () => true }))
      .toEqual({ status: 'refused', reason: 'session_gone' });
  });
});

describe('sendRawFor (session:raw) refusals', () => {
  beforeEach(() => clearRegistry());

  it('refuses an invalid pid', () => {
    expect(sendRawFor(-1, 'x')).toEqual({ status: 'refused', reason: 'invalid_pid' });
  });

  it('refuses empty data', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(sendRawFor(4821, '', { has: () => true })).toEqual({ status: 'refused', reason: 'invalid_data' });
  });

  it('refuses a pid with no tmux session', () => {
    expect(sendRawFor(4821, 'x')).toEqual({ status: 'refused', reason: 'not_tmux' });
  });

  it('refuses when the session vanished', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(sendRawFor(4821, 'x', { has: () => false })).toEqual({ status: 'refused', reason: 'session_gone' });
  });

  it('refuses a live session with no attachment yet, rather than throwing', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(sendRawFor(4821, 'x', { has: () => true })).toEqual({ status: 'refused', reason: 'session_gone' });
  });
});

// ---------------------------------------------------------------------
// This module's own wiring, proven against a fake IPty -- what argv/env
// attachTerminal spawns with, and that resize/raw/detach reach the pty an
// attach created. Nothing about tmux's own behaviour is asserted here;
// that is the real-tmux suite below.
// ---------------------------------------------------------------------

describe('attachTerminal spawns a real tmux client (fake pty)', () => {
  beforeEach(() => clearRegistry());
  // attachments (ipc.ts) is module-level state, keyed by pid, that outlives
  // any one test -- without this, a pid attached in one test is still
  // "already attached" in the next, and attachTerminal's own idempotency
  // (correctly) skips spawning a second pty, silently wiring every
  // assertion below to a fake pty instance a PREVIOUS test created.
  afterEach(() => detachAllTerminals());

  it('spawns `tmux attach -t =name:` sized to the requested cols/rows', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const { spawn, calls } = fakeSpawn(instance);
    const result = await attachTerminal(4821, 100, 30, fakeWin([]), { has: () => true, spawn, setOption: noopOption });
    expect(result).toEqual({ status: 'attached' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('tmux');
    expect(calls[0]!.args).toEqual(['attach', '-t', '=llmws-claude-abc:']);
    expect(calls[0]!.opts).toMatchObject({ cols: 100, rows: 30 });
  });

  // BUG 2 (terminal scroll): tmux's own mouse support is off by default,
  // so attaching a real client must turn it on for THIS session before
  // spawning the client -- and only for this session ('-t', never '-g',
  // which would silently flip the setting for every tmux session on the
  // machine, including ones this app has nothing to do with). This also
  // covers an ADOPTED session (one this app did not create): attachTerminal
  // is the only tmux-mouse call site such a session ever reaches, since it
  // skipped launchSession's own setSessionOption call entirely.
  it('turns mouse mode on for this session alone before attaching, never globally', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const { spawn } = fakeSpawn(fakePty());
    const opt = optionSpy();
    const result = await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn, setOption: opt.setOption });
    expect(result).toEqual({ status: 'attached' });
    expect(opt.calls).toEqual([
      ['set-option', '-t', '=llmws-claude-abc:', 'mouse', 'on'],
      ['set-option', '-t', '=llmws-claude-abc:', 'status', 'off'],
    ]);
    expect(opt.calls.flat()).not.toContain('-g');
  });

  // Same adopted-session reasoning as the mouse test above: attaching is
  // the only tmux-status call site an adopted session ever reaches, since
  // it skipped launchSession's own setSessionOption call entirely. tmux's
  // status line otherwise renders inside the terminal once a real client
  // attaches (reported as a literal "[llmws-claude-...:[tmux]" row at the
  // bottom) -- pure noise inside an app that already has its own chrome.
  it('turns the tmux status bar off for this session alone before attaching, never globally', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const { spawn } = fakeSpawn(fakePty());
    const opt = optionSpy();
    const result = await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn, setOption: opt.setOption });
    expect(result).toEqual({ status: 'attached' });
    // Mutation target: a '-t' -> '-g' swap on the status call must fail
    // this, since that is exactly the difference between a per-session
    // setting and rewriting the user's own tmux config for every session
    // on the machine.
    expect(opt.calls).toContainEqual(['set-option', '-t', '=llmws-claude-abc:', 'status', 'off']);
    expect(opt.calls.flat()).not.toContain('-g');
  });

  // Mutation target: TERM in the pty's own env. Without it, neither tmux
  // nor a full-screen program inside it (Claude Code) renders colour --
  // pinned on the exact value reaching spawn's own options, not on any
  // rendered output this fake pty cannot produce.
  it('sets TERM=xterm-256color in the pty env, even when the ambient env has none', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const { spawn, calls } = fakeSpawn(instance);
    await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn, setOption: noopOption });
    const opts = calls[0]!.opts as { env?: Record<string, string | undefined> };
    expect(opts.env?.TERM).toBe('xterm-256color');
  });

  it('is idempotent -- a second attach for the same pid does not spawn a second pty', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const { spawn, calls } = fakeSpawn(instance);
    const win = fakeWin([]);
    expect(await attachTerminal(4821, 80, 24, win, { has: () => true, spawn, setOption: noopOption })).toEqual({ status: 'attached' });
    expect(await attachTerminal(4821, 80, 24, win, { has: () => true, spawn, setOption: noopOption })).toEqual({ status: 'attached' });
    expect(await attachTerminal(4821, 100, 40, win, { has: () => true, spawn, setOption: noopOption })).toEqual({ status: 'attached' });
    expect(calls).toHaveLength(1);
  });

  it('replaces an exited tmux client even if the view misses the exit event', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const first = fakePty();
    const second = fakePty();
    let spawned = 0;
    const spawn = (() => [first, second][spawned++]!.pty) as typeof realPtySpawn;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    } as unknown as Parameters<typeof attachTerminal>[3];
    await attachTerminal(4821, 80, 24, win, { has: () => true, spawn, setOption: noopOption });

    first.onExitHandlers[0]!({ exitCode: 1 });

    expect(spawned).toBe(2);
    expect(sent).toContainEqual({ channel: 'terminal:exit', payload: { pid: 4821, exhausted: false } });
    expect(sendRawFor(4821, 'x', { has: () => true })).toEqual({ status: 'sent' });
    expect(second.writeCalls).toEqual(['x']);
    expect(await attachTerminal(4821, 80, 24, win, { has: () => true, spawn, setOption: noopOption }))
      .toEqual({ status: 'attached' });
    expect(spawned).toBe(2);
  });

  it('stops after three replacement clients also exit', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const clients = Array.from({ length: 4 }, () => fakePty());
    let spawned = 0;
    const spawn = (() => clients[spawned++]!.pty) as typeof realPtySpawn;
    await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn, setOption: noopOption });

    for (const client of clients) client.onExitHandlers[0]!({ exitCode: 1 });

    expect(spawned).toBe(4); // initial client plus three attempts
    expect(sendRawFor(4821, 'x', { has: () => true })).toEqual({ status: 'refused', reason: 'session_gone' });
  });

  it('does not ask the view to reconnect after an intentional detach', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    } as unknown as Parameters<typeof attachTerminal>[3];
    await attachTerminal(4821, 80, 24, win, {
      has: () => true, spawn: fakeSpawn(instance).spawn, setOption: noopOption,
    });

    detachTerminal(4821);
    instance.onExitHandlers[0]!({ exitCode: 0 });

    expect(sent.some(message => message.channel === 'terminal:exit')).toBe(false);
  });

  it("feeds the pty's own onData straight to the coalescer, which pushes terminal:data", async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const { spawn } = fakeSpawn(instance);
    const sent: unknown[] = [];
    await attachTerminal(4821, 80, 24, fakeWin(sent), {
      has: () => true, spawn, schedule: fn => fn(), setOption: noopOption,
    });
    instance.onDataHandlers[0]!('hello from tmux');
    expect(sent).toEqual([{ version: 1, pid: 4821, seq: 0, data: 'hello from tmux' }]);
  });

  it('resizes the attached pty, not a tmux CLI call, on session:resize', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const { spawn } = fakeSpawn(instance);
    await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn, setOption: noopOption });
    expect(resizeTerminal(4821, 120, 40, { has: () => true })).toEqual({ status: 'resized' });
    expect(instance.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
  });

  // The whole reason session:raw exists: sanitizeOutbound (session:keys'
  // path) would strip every one of these as a C0 control character, which
  // is exactly wrong here -- Ctrl-C and an arrow key ARE the message, and
  // they reach the pty exactly as typed, not through a tmux send-keys call.
  it('writes raw bytes straight to the attached pty, control bytes untouched', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const { spawn } = fakeSpawn(instance);
    await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn, setOption: noopOption });
    expect(sendRawFor(4821, '\x03', { has: () => true })).toEqual({ status: 'sent' });
    expect(sendRawFor(4821, '\x1b[A', { has: () => true })).toEqual({ status: 'sent' });
    expect(instance.writeCalls).toEqual(['\x03', '\x1b[A']);
  });

  it('detach kills the pty, never the tmux session, and is idempotent', async () => {
    registerSession(4821, 'llmws-claude-abc');
    const instance = fakePty();
    const { spawn } = fakeSpawn(instance);
    await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn, setOption: noopOption });

    expect(detachTerminal(4821)).toEqual({ status: 'detached' });
    expect(instance.killCalls).toHaveLength(1);

    // Idempotent: a second detach for the same pid does not call kill again.
    expect(detachTerminal(4821)).toEqual({ status: 'detached' });
    expect(instance.killCalls).toHaveLength(1);
  });

  it('detachAllTerminals kills every live attachment', async () => {
    registerSession(4821, 'llmws-claude-abc');
    registerSession(4822, 'llmws-claude-def');
    const a = fakePty();
    const b = fakePty();
    await attachTerminal(4821, 80, 24, fakeWin([]), { has: () => true, spawn: fakeSpawn(a).spawn, setOption: noopOption });
    await attachTerminal(4822, 80, 24, fakeWin([]), { has: () => true, spawn: fakeSpawn(b).spawn, setOption: noopOption });

    detachAllTerminals();
    expect(a.killCalls).toHaveLength(1);
    expect(b.killCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Real tmux, real node-pty. This is the suite that actually matters: it
// proves attach makes this app a genuine tmux CLIENT rather than the old
// headless pipe-pane/fifo stand-in -- tmux itself resizing to follow the
// pty (not a resize-window call this app makes by hand), and a killed pty
// detaching without ending the session, the same way closing a real
// terminal window would. Skipped with a visible reason if tmux is
// unavailable, never silently passed.
// ---------------------------------------------------------------------

function hasTmuxBinary(): boolean {
  try { execFileSync('tmux', ['-V']); return true; } catch { return false; }
}
const TMUX_AVAILABLE = hasTmuxBinary();
if (!TMUX_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn('SKIPPING tests/main/stream-bridge.test.ts real-tmux suite: tmux binary not found on PATH');
}

const TEST_SESSION = 'llmws-claude-streambridgetest';
const TEST_PID = 999001; // no real process needed -- registerSession only ever binds pid -> name

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killTestSession(): void {
  try { execFileSync('tmux', ['kill-session', '-t', `=${TEST_SESSION}`]); } catch { /* already gone -- fine */ }
}

function paneWidth(): string {
  return execFileSync(
    'tmux', ['display-message', '-p', '-t', `=${TEST_SESSION}:`, '#{pane_width}'],
  ).toString().trim();
}

function payloadData(p: unknown): string {
  return (p as { data: string }).data;
}

describe.skipIf(!TMUX_AVAILABLE)('stream bridge against a real tmux session', () => {
  afterEach(() => {
    // Runs even when an assertion above threw -- a leaked tmux session or
    // pty from a failed run must not poison the next one.
    detachAllTerminals();
    clearRegistry();
    killTestSession();
  });

  it('attaches as a real client and streams real pane bytes through the coalescer', async () => {
    killTestSession(); // in case a previous run crashed before its own cleanup
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);
    await delay(200); // let bash actually start and print its first prompt

    registerSession(TEST_PID, TEST_SESSION);
    const sent: unknown[] = [];
    const win = fakeWin(sent);

    expect(await attachTerminal(TEST_PID, 80, 24, win)).toEqual({ status: 'attached' });
    await delay(200); // let the real `tmux attach` client actually connect

    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, '-l', 'echo STREAM_MARKER_1']);
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, 'Enter']);
    await delay(300); // COALESCE_MS is 16ms; this is generous scheduling margin

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map(payloadData).join('')).toContain('STREAM_MARKER_1');

    // Idempotent re-attach: a non-idempotent implementation would spawn a
    // second real `tmux attach` client here, which tmux would happily
    // accept -- so this alone would not fail. The pty-count assertion in
    // the dedicated idempotency test below is what actually distinguishes
    // that from the correct behaviour; this just proves attach itself
    // keeps working on a repeat call.
    expect(await attachTerminal(TEST_PID, 80, 24, win)).toEqual({ status: 'attached' });

    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, '-l', 'echo STREAM_MARKER_2']);
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, 'Enter']);
    await delay(300);
    expect(sent.map(payloadData).join('')).toContain('STREAM_MARKER_2');
  });

  // The property this whole change buys: node-pty gives tmux a real
  // terminal, so resizing the PTY makes tmux resize the window ITSELF --
  // no resize-window call, no size race. Mutation target: swap
  // resizeTerminal's `existing.pty.resize(cols, rows)` for a no-op (or for
  // the old resize-window call, which no longer has a pty to read a size
  // from) and this fails, because nothing would ever tell the real tmux
  // server the new size.
  it("resizing the pty makes tmux's own window follow, not the other way around", async () => {
    killTestSession();
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);
    await delay(200);
    expect(paneWidth()).toBe('80');

    registerSession(TEST_PID, TEST_SESSION);
    expect(await attachTerminal(TEST_PID, 80, 24, fakeWin([]))).toEqual({ status: 'attached' });
    await delay(200);

    expect(resizeTerminal(TEST_PID, 120, 40)).toEqual({ status: 'resized' });
    await delay(200); // let tmux process the pty's own SIGWINCH-driven resize

    expect(paneWidth()).toBe('120');
  });

  // The tmux SESSION must outlive the app: killing the pty detaches this
  // one client, exactly like closing a real terminal window, and must
  // never take the session (or the shell/agent running inside it) down
  // with it. Mutation target: swap detachTerminal's `existing.pty.kill()`
  // for a real `tmux kill-session` call and this fails.
  it('killing the pty detaches the client but leaves the tmux session alive', async () => {
    killTestSession();
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);
    await delay(200);

    registerSession(TEST_PID, TEST_SESSION);
    expect(await attachTerminal(TEST_PID, 80, 24, fakeWin([]))).toEqual({ status: 'attached' });
    await delay(200);

    expect(detachTerminal(TEST_PID)).toEqual({ status: 'detached' });
    await delay(200);

    // has-session throws (non-zero exit) the moment the session is gone --
    // this is the assertion the whole test exists for.
    expect(() => execFileSync('tmux', ['has-session', '-t', `=${TEST_SESSION}`])).not.toThrow();

    // Detach is idempotent -- calling it again is a no-op success, not a
    // repeat kill of an already-dead client.
    expect(detachTerminal(TEST_PID)).toEqual({ status: 'detached' });
  });

  // A dedicated, narrower proof that attach does not leak a second real
  // tmux client on a repeat call -- counting real spawn invocations while
  // still hitting the real tmux binary underneath, same precedent as this
  // suite's own resize/pipe-pane call-counting before this change.
  it('does not spawn a second real tmux client on a repeat attach for an already-attached pid', async () => {
    killTestSession();
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);
    await delay(200);

    registerSession(TEST_PID, TEST_SESSION);
    let spawnCount = 0;
    const countingSpawn = ((file: string, args: string[], opts: unknown) => {
      spawnCount++;
      return realPtySpawn(file, args as string[], opts as never);
    }) as typeof realPtySpawn;

    const win = fakeWin([]);
    expect(await attachTerminal(TEST_PID, 80, 24, win, { spawn: countingSpawn })).toEqual({ status: 'attached' });
    expect(await attachTerminal(TEST_PID, 80, 24, win, { spawn: countingSpawn })).toEqual({ status: 'attached' });
    expect(await attachTerminal(TEST_PID, 80, 24, win, { spawn: countingSpawn })).toEqual({ status: 'attached' });

    expect(spawnCount).toBe(1);
  });
});
