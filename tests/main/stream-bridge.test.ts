import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  attachTerminal, detachTerminal, detachAllTerminals, resizeTerminal, sendRawFor,
  type AttachResult,
} from '../../src/main/ipc.ts';
import { registerSession, clearRegistry } from '../../src/main/sessions.ts';
import { newSession, type TmuxResult } from '../../src/main/tmux.ts';
import { COALESCE_MS } from '../../src/main/stream.ts';

/** Mirrors ipc.ts's own (private) fifoPathFor exactly -- reimplemented
 *  here, not imported, so these tests can check the real path on disk
 *  without exporting an internal solely for that purpose. */
function fifoPathForTest(name: string): string {
  return join(tmpdir(), 'llm-workspace-terminal-pipes', `${name}.fifo`);
}

/** Same shape as tmux.ts's own (private) defaultExec -- reimplemented here,
 *  not imported, so tests can wrap it in a call-counter while still
 *  hitting the real tmux binary underneath. Used only to prove
 *  attachTerminal's idempotency without mocking real tmux calls away
 *  entirely (which would otherwise leave a fifo's read side waiting on a
 *  writer that never arrives -- see the idempotency test below). */
function realTmuxExec(args: string[]): TmuxResult {
  try { return { ok: true, stdout: execFileSync('tmux', args, { timeout: 5000 }).toString() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'tmux failed' }; }
}

function fakeWin(sent: unknown[]) {
  return {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, payload: unknown) => sent.push(payload) },
  } as unknown as Parameters<typeof attachTerminal>[3];
}

// ---------------------------------------------------------------------
// Refusal paths -- pure, no real tmux or filesystem touched: every one of
// these returns before attachTerminal ever gets to resizeWindow/capturePane/
// pipePane, mirroring sendKeysFor's own refusal-path tests in ipc.test.ts.
// ---------------------------------------------------------------------

describe('attachTerminal refusals', () => {
  beforeEach(() => clearRegistry());
  const sent: unknown[] = [];
  const win = fakeWin(sent);

  it('refuses an invalid pid', () => {
    expect(attachTerminal(-1, 80, 24, win)).toEqual({ status: 'refused', reason: 'invalid_pid' });
    expect(attachTerminal(1.5, 80, 24, win)).toEqual({ status: 'refused', reason: 'invalid_pid' });
  });

  it('refuses a pid with no tmux session -- the iTerm case', () => {
    expect(attachTerminal(4821, 80, 24, win)).toEqual({ status: 'refused', reason: 'not_tmux' });
  });

  it('refuses when the session vanished between render and click', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(attachTerminal(4821, 80, 24, win, { has: () => false }))
      .toEqual({ status: 'refused', reason: 'session_gone' });
  });

  it('refuses a non-positive-integer size before touching tmux or the filesystem', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(attachTerminal(4821, 0, 24, win, { has: () => true }))
      .toEqual({ status: 'refused', reason: 'invalid_size' });
    expect(attachTerminal(4821, 80, -1, win, { has: () => true }))
      .toEqual({ status: 'refused', reason: 'invalid_size' });
    expect(attachTerminal(4821, 80.5, 24, win, { has: () => true }))
      .toEqual({ status: 'refused', reason: 'invalid_size' });
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

describe('resizeTerminal', () => {
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

  it('resizes the resolved live session with the given cols/rows', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = resizeTerminal(4821, 100, 40, {
      has: () => true,
      resize: args => { calls.push(args); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'resized' });
    expect(calls[0]).toEqual(['resize-window', '-t', '=llmws-claude-abc:', '-x', '100', '-y', '40']);
  });
});

describe('sendRawFor (session:raw)', () => {
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

  // The whole reason this channel exists: sanitizeOutbound (session:keys'
  // path) would strip every one of these as a C0 control character, which
  // is exactly wrong here -- Ctrl-C and an arrow key ARE the message.
  it('passes a control byte through untouched -- sanitizeOutbound must never run on this path', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = sendRawFor(4821, '\x03', {
      has: () => true,
      send: args => { calls.push(args); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'sent' });
    expect(calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', '\x03']);
  });

  it('passes a bare escape sequence through untouched (an arrow key)', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    sendRawFor(4821, '\x1b[A', {
      has: () => true,
      send: args => { calls.push(args); return { ok: true, stdout: '' }; },
    });
    expect(calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', '\x1b[A']);
  });
});

// ---------------------------------------------------------------------
// Real tmux, real bytes. Mocked tests alone have missed every serious
// defect in this project's last three phases (per this task's brief) --
// this is the one that actually proves pipe-pane -> fifo -> coalescer ->
// webContents.send works, against a real tmux 3.7c server, not a
// stand-in for one. Skipped with a visible reason if tmux is unavailable,
// never silently passed.
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

function payloadData(p: unknown): string {
  return (p as { data: string }).data;
}

describe.skipIf(!TMUX_AVAILABLE)('stream bridge against a real tmux session', () => {
  afterEach(() => {
    // Runs even when an assertion above threw -- a leaked tmux session or
    // fifo from a failed run must not poison the next one.
    detachAllTerminals();
    clearRegistry();
    killTestSession();
  });

  it('resizes first, returns real scrollback as backlog, and streams real pane bytes through pipe-pane and the coalescer', async () => {
    killTestSession(); // in case a previous run crashed before its own cleanup
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);
    await delay(200); // let bash actually start and print its first prompt

    registerSession(TEST_PID, TEST_SESSION);
    const sent: unknown[] = [];
    const win = fakeWin(sent);

    const result: AttachResult = attachTerminal(TEST_PID, 100, 30, win);
    expect(result.status).toBe('attached');
    if (result.status !== 'attached') throw new Error('unreachable');
    expect(typeof result.backlog).toBe('string');

    // Mutation target 1 (task brief Step 6): resize really happened against
    // the real session, not just a mock call -- a dropped resizeWindow call
    // leaves the pane at its creation width (80), not the requested one.
    const width = execFileSync(
      'tmux', ['display-message', '-p', '-t', `=${TEST_SESSION}:`, '#{pane_width}'],
    ).toString().trim();
    expect(width).toBe('100');

    // Real bytes into the pane -- through the pane's shell, out through
    // pipe-pane, through the fifo, through the coalescer, into
    // webContents.send.
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, '-l', 'echo STREAM_MARKER_1']);
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, 'Enter']);
    await delay(300); // COALESCE_MS is 16ms; this is generous scheduling margin

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map(payloadData).join('')).toContain('STREAM_MARKER_1');

    // Mutation target 2: idempotent re-attach. A non-idempotent
    // implementation that always creates a fresh fifo/coalescer would
    // throw here (mkfifo EEXIST on the same deterministic path) rather
    // than quietly succeeding with a fresh backlog.
    const second = attachTerminal(TEST_PID, 100, 30, win);
    expect(second.status).toBe('attached');

    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, '-l', 'echo STREAM_MARKER_2']);
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, 'Enter']);
    await delay(300);
    expect(sent.map(payloadData).join('')).toContain('STREAM_MARKER_2');

    // Detach stops the stream -- further pane output produces no more
    // pushes, proving there was exactly one live coalescer to stop (an
    // orphaned second one from a non-idempotent attach would still push).
    expect(detachTerminal(TEST_PID)).toEqual({ status: 'detached' });
    const countAfterDetach = sent.length;
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, '-l', 'echo STREAM_MARKER_3']);
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, 'Enter']);
    await delay(300);
    expect(sent.length).toBe(countAfterDetach);

    // Detach is idempotent -- calling it again is a no-op success.
    expect(detachTerminal(TEST_PID)).toEqual({ status: 'detached' });
  });

  // A dedicated, narrower proof for mutation target 2 above. The big test's
  // own idempotent-reattach step is not enough on its own: a broken,
  // non-idempotent attach that always recreates the fifo/stream/coalescer
  // does not actually break end-to-end streaming here, because (a) this
  // process's own attachTerminal always clears a stale fifo at the same
  // deterministic path before calling mkfifo (needed for real, to survive a
  // crashed previous run), so a second mkfifo never throws EEXIST the way a
  // naive read of "idempotent" might expect, and (b) tmux itself only
  // allows one pipe per pane ("any existing pipe is closed before
  // shell-command is executed"), so a second pipe-pane silently replaces
  // the first and output keeps flowing through the replacement -- both
  // reasons the big test's marker-arrives assertions alone cannot tell a
  // correct implementation from a leaky one. Counting real resize/pipe-pane
  // calls through the injected deps -- still hitting the real tmux binary,
  // not mocking it away -- is what actually distinguishes them: the
  // idempotent branch calls neither on a repeat attach.
  it('does not resize or start a second pipe-pane on a repeat attach for an already-attached pid', () => {
    killTestSession();
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);

    registerSession(TEST_PID, TEST_SESSION);
    const win = fakeWin([]);
    const counts = { resize: 0, pipe: 0 };
    const deps = {
      resize: (args: string[]) => { counts.resize++; return realTmuxExec(args); },
      pipe: (args: string[]) => { counts.pipe++; return realTmuxExec(args); },
    };

    expect(attachTerminal(TEST_PID, 80, 24, win, deps).status).toBe('attached');
    expect(attachTerminal(TEST_PID, 80, 24, win, deps).status).toBe('attached');
    expect(attachTerminal(TEST_PID, 80, 24, win, deps).status).toBe('attached');

    expect(counts.resize).toBe(1);
    expect(counts.pipe).toBe(1);
  });

  // Fix round 1, finding 1: the fifo carries raw agent terminal output, so
  // its directory and the fifo itself must not be group/world accessible.
  // Asserted via statSync on the REAL, post-creation path -- not the mode
  // argument passed to mkdirSync/mkfifo, which the reviewer noted is itself
  // umask-masked and therefore not proof of anything on its own.
  it('creates the pipe directory 0o700 and the fifo itself 0o600', () => {
    killTestSession();
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);

    registerSession(TEST_PID, TEST_SESSION);
    const result = attachTerminal(TEST_PID, 80, 24, fakeWin([]));
    expect(result.status).toBe('attached');

    const fifoPath = fifoPathForTest(TEST_SESSION);
    const dirMode = statSync(dirname(fifoPath)).mode & 0o777;
    const fifoMode = statSync(fifoPath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fifoMode).toBe(0o600);
  });

  // Fix round 1, finding 2: detachTerminal's own explicit flushNow() call
  // (below, not the coalescer's internal auto-flush) can throw if the
  // window is already half-destroyed -- webContents.send is what emit
  // calls. Without a try/finally around it, none of the cleanup after it
  // (pipe-pane stop, stream destroy, fifo unlink) would ever run, leaking
  // all three every time a detach races a window closing.
  //
  // Flake, found in the whole-branch review: this used to rely on a 5ms
  // sleep landing before the coalescer's own internal 16ms auto-flush
  // (stream.ts's COALESCE_MS) fired -- a real race against a real timer,
  // not a fixed ordering. On a contended run the auto-flush sometimes won,
  // drained the buffer itself, and left nothing for detachTerminal's own
  // flushNow to flush -- so it returned early without ever calling
  // webContents.send, and the "throws" assertion failed. Reproduced 1 run
  // in 6 on an otherwise idle machine; a bigger sleep would only have
  // improved the odds, not removed the race, and this is specifically an
  // error-path test, where a flake does the most damage. Fixed by removing
  // the competing timer rather than outrunning it: `schedule: () => {}`
  // makes the coalescer's own auto-flush arm and then never actually fire,
  // so detachTerminal's explicit flushNow is the ONLY thing that can ever
  // flush the buffer -- deterministic, not merely more likely.
  it('still stops the pipe, destroys the stream, and unlinks the fifo when flushNow throws', async () => {
    killTestSession();
    const created = newSession(TEST_SESSION, process.cwd(), 'bash', 80, 24);
    expect(created.ok).toBe(true);
    await delay(200);

    registerSession(TEST_PID, TEST_SESSION);
    const poisonedWin = {
      isDestroyed: () => false,
      webContents: { send: () => { throw new Error('window already destroyed'); } },
    } as unknown as Parameters<typeof attachTerminal>[3];

    // Never actually schedules the coalescer's auto-flush -- see the test's
    // own doc comment above. arm() still runs (buffer.length stays > 0
    // until something flushes it), it just never gets a chance to fire.
    const result = attachTerminal(TEST_PID, 80, 24, poisonedWin, { schedule: () => {} });
    expect(result.status).toBe('attached');

    const fifoPath = fifoPathForTest(TEST_SESSION);
    expect(existsSync(fifoPath)).toBe(true);

    // Real bytes, then a wait DELIBERATELY LONGER than the coalescer's own
    // COALESCE_MS -- the opposite of the old 5ms sleep, which only worked
    // by usually finishing before COALESCE_MS did. Waiting past it instead
    // makes this test PROVE the auto-flush cannot fire, rather than merely
    // hoping it hasn't yet: if `schedule` above were ever ignored (the
    // mutation this margin exists to catch), the real setTimeout(16ms)
    // would fire well within this wait, drain the buffer itself, and this
    // test would fail every single time -- not occasionally.
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, '-l', 'echo PENDING']);
    execFileSync('tmux', ['send-keys', '-t', `=${TEST_SESSION}:`, 'Enter']);
    await delay(COALESCE_MS * 3);

    // The throw propagates -- this fix is about cleanup running regardless,
    // not about swallowing the error.
    expect(() => detachTerminal(TEST_PID)).toThrow('window already destroyed');

    // Cleanup ran anyway: the fifo is gone, and a second detach (the
    // attachment was already removed from the map before flushNow ran) is
    // a clean no-op, not a repeat of the same throw.
    expect(existsSync(fifoPath)).toBe(false);
    expect(detachTerminal(TEST_PID)).toEqual({ status: 'detached' });
  });
});
