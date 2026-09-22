import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { readModeFor, setModeFor, clearModeInFlight, MODE_PRESS_CAP, type ModeDeps } from '../../src/main/mode.ts';
import { registerSession, clearRegistry } from '../../src/main/sessions.ts';
import type { TmuxResult } from '../../src/main/tmux.ts';
import type { Mode } from '../../src/core/mode.ts';

/** The guarded switch. Spec: docs/superpowers/specs/
 *  2026-09-21-mode-switcher-design.md §4 and §6.
 *
 *  The pane here is a fake that cycles exactly the way the real ones were
 *  measured to: Claude four ways, Codex two. Every screen it hands back is
 *  a real capture from tests/fixtures/modes/. */

const fixture = (f: string) => readFileSync(`tests/fixtures/modes/${f}`, 'utf8');

const CLAUDE_SCREENS: Record<Mode, string> = {
  auto: fixture('claude-auto.txt'),
  manual: fixture('claude-manual.txt'),
  acceptEdits: fixture('claude-accept-edits.txt'),
  plan: fixture('claude-plan.txt'),
  default: '',
};

const CODEX_SCREENS: Partial<Record<Mode, string>> = {
  default: fixture('codex-default.txt'),
  plan: fixture('codex-plan.txt'),
};

/** The measured cycle order (§3.1): auto -> manual -> accept edits -> plan
 *  -> auto. */
const CLAUDE_CYCLE: Mode[] = ['auto', 'manual', 'acceptEdits', 'plan'];
const CODEX_CYCLE: Mode[] = ['default', 'plan'];

const PID = 7373;
const CLAUDE_NAME = 'llmws-claude-m1';
const CODEX_NAME = 'llmws-codex-m1';

type Call = string[];

/** A fake pane that really cycles. Every BTab advances it one step round
 *  its provider's own cycle; anything else is recorded and ignored. */
function cyclingPane(provider: 'claude' | 'codex', start: Mode, opts: { inMode?: boolean; unreadable?: boolean } = {}) {
  const cycle = provider === 'claude' ? CLAUDE_CYCLE : CODEX_CYCLE;
  const screens = provider === 'claude' ? CLAUDE_SCREENS : CODEX_SCREENS;
  let at = cycle.indexOf(start);
  if (at === -1) throw new Error(`start mode not in the ${provider} cycle: ${start}`);
  const sent: Call[] = [];
  const captures: Call[] = [];
  const send = (args: string[]): TmuxResult => {
    sent.push(args);
    if (args[args.length - 1] === 'BTab') at = (at + 1) % cycle.length;
    return { ok: true, stdout: '' };
  };
  const capture = (args: string[]): TmuxResult => {
    captures.push(args);
    if (args[0] === 'display-message') return { ok: true, stdout: opts.inMode ? '1\n' : '0\n' };
    if (opts.unreadable) return { ok: true, stdout: fixture('plain-shell.txt') };
    return { ok: true, stdout: screens[cycle[at]!] ?? '' };
  };
  const keys = () => sent.filter(a => !a.includes('-X')).map(a => a[a.length - 1]);
  const btabs = () => keys().filter(k => k === 'BTab').length;
  return { sent, captures, send, capture, keys, btabs, now: () => cycle[at]! };
}

function deps(pane: ReturnType<typeof cyclingPane>, extra: Partial<ModeDeps> = {}): ModeDeps {
  return {
    send: pane.send,
    capture: pane.capture,
    sleep: async () => {},
    has: () => true,
    provider: () => 'claude',
    promptOpen: () => false,
    ...extra,
  };
}

let errors: MockInstance;
let logs: MockInstance;

beforeEach(() => {
  clearRegistry();
  clearModeInFlight();
  registerSession(PID, CLAUDE_NAME);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  logs.mockRestore();
  clearRegistry();
  clearModeInFlight();
});

describe('readModeFor', () => {
  it('reports the pane\'s mode and that the chip may switch', () => {
    const pane = cyclingPane('claude', 'plan');
    expect(readModeFor(PID, deps(pane))).toEqual({ provider: 'claude', mode: 'plan', blocked: null });
  });

  it('reports the mode as null, never a guess, when the screen cannot be read', () => {
    const pane = cyclingPane('claude', 'plan', { unreadable: true });
    expect(readModeFor(PID, deps(pane))).toEqual({ provider: 'claude', mode: null, blocked: 'unreadable' });
  });

  // Converted 2026-09-22 from 'still reports the mode while the session is
  // mid-turn, but blocks the switch'. The busy guard is gone: against a
  // live pane streaming a reply (capture 4047 -> 4508 bytes), Shift+Tab
  // moved the mode from accept edits to plan while the response kept
  // arriving, so the block bought nothing and left the chip dead for most
  // of the time anyone is looking at a session. There is no `busy` input to
  // pass any more -- what stands in that test's place is the fact a
  // reinstated guard would have to break, plus the absence of the dep it
  // would need.
  it('leaves a readable pane switchable: nothing about the turn blocks it', () => {
    const pane = cyclingPane('claude', 'manual');
    const d = deps(pane);
    expect('busy' in d).toBe(false);
    expect(readModeFor(PID, d)).toEqual({ provider: 'claude', mode: 'manual', blocked: null });
  });

  it('blocks the switch while a prompt card is up', () => {
    const pane = cyclingPane('claude', 'manual');
    expect(readModeFor(PID, deps(pane, { promptOpen: () => true })))
      .toEqual({ provider: 'claude', mode: 'manual', blocked: 'prompt_open' });
  });

  // Converted 2026-09-22 from 'answers null for a session this app did not
  // launch -- there is no pane to read'. Null blanked the chip, and the
  // session with no pane is the common one: started in iTerm or VS Code.
  // The reading is the same -- nothing is captured, no mode is claimed --
  // but it is now reported, so the chip can say why it cannot be used.
  it('reports not_tmux for a session this app did not launch, and reads no pane', () => {
    clearRegistry();
    const pane = cyclingPane('claude', 'manual');
    expect(readModeFor(PID, deps(pane)))
      .toEqual({ provider: 'claude', mode: null, blocked: 'not_tmux' });
    expect(pane.captures).toHaveLength(0);
  });

  // The one answer that is still null, and the reason it has to be: the
  // provider decides which menu, which mode list and which reader the chip
  // uses, so without it there is no chip to disable -- not even a label to
  // put on one. Everything else that used to blank the chip now reports.
  it('answers null when the provider cannot be told', () => {
    const pane = cyclingPane('claude', 'manual');
    expect(readModeFor(PID, deps(pane, { provider: () => null }))).toBeNull();
  });

  it('reports session_gone, and reads nothing, once the tmux session has died', () => {
    const pane = cyclingPane('claude', 'manual');
    expect(readModeFor(PID, deps(pane, { has: () => false })))
      .toEqual({ provider: 'claude', mode: null, blocked: 'session_gone' });
    expect(pane.captures).toHaveLength(0);
  });
});

describe('setModeFor: Claude cycles four, and up to three presses is always enough', () => {
  it.each([
    ['auto', 'manual', 1],
    ['auto', 'acceptEdits', 2],
    ['auto', 'plan', 3],
    ['manual', 'auto', 3],
    ['plan', 'auto', 1],
    ['acceptEdits', 'manual', 3],
  ] as [Mode, Mode, number][])('from %s to %s in %i press(es)', async (from, to, presses) => {
    const pane = cyclingPane('claude', from);
    await expect(setModeFor(PID, to, deps(pane))).resolves.toEqual({ status: 'set', mode: to });
    expect(pane.btabs()).toBe(presses);
    expect(pane.now()).toBe(to);
  });

  it('never presses more than three times for any pair of Claude modes', async () => {
    for (const from of CLAUDE_CYCLE) {
      for (const to of CLAUDE_CYCLE) {
        if (from === to) continue;
        clearModeInFlight();
        const pane = cyclingPane('claude', from);
        await setModeFor(PID, to, deps(pane));
        expect(pane.btabs()).toBeLessThanOrEqual(3);
      }
    }
  });

  it('presses nothing and says so when the pane is already on the mode asked for', async () => {
    const pane = cyclingPane('claude', 'plan');
    await expect(setModeFor(PID, 'plan', deps(pane))).resolves.toEqual({ status: 'unchanged', mode: 'plan' });
    expect(pane.btabs()).toBe(0);
  });

  it('sends only BTab, never any other key', async () => {
    const pane = cyclingPane('claude', 'auto');
    await setModeFor(PID, 'plan', deps(pane));
    expect(new Set(pane.keys())).toEqual(new Set(['BTab']));
  });

  // Every press is followed by a fresh read before the next one: the loop
  // never counts presses against a remembered position.
  it('re-reads the pane between presses', async () => {
    const pane = cyclingPane('claude', 'auto');
    await setModeFor(PID, 'plan', deps(pane));
    const paneReads = pane.captures.filter(c => c[0] === 'capture-pane').length;
    expect(paneReads).toBeGreaterThanOrEqual(pane.btabs() + 1);
  });
});

describe('setModeFor: Codex toggles two, and one press is always enough', () => {
  beforeEach(() => {
    clearRegistry();
    registerSession(PID, CODEX_NAME);
  });

  it.each([
    ['default', 'plan'],
    ['plan', 'default'],
  ] as [Mode, Mode][])('from %s to %s in one press', async (from, to) => {
    const pane = cyclingPane('codex', from);
    const d = deps(pane, { provider: () => 'codex' });
    await expect(setModeFor(PID, to, d)).resolves.toEqual({ status: 'set', mode: to });
    expect(pane.btabs()).toBe(1);
  });

  it('refuses a Claude mode name for a Codex session, and presses nothing', async () => {
    const pane = cyclingPane('codex', 'default');
    const d = deps(pane, { provider: () => 'codex' });
    await expect(setModeFor(PID, 'acceptEdits', d)).resolves.toEqual({ status: 'refused', reason: 'invalid_mode' });
    expect(pane.sent).toHaveLength(0);
  });

  it('refuses a Codex mode name for a Claude session, and presses nothing', async () => {
    clearRegistry();
    registerSession(PID, CLAUDE_NAME);
    const pane = cyclingPane('claude', 'manual');
    await expect(setModeFor(PID, 'default', deps(pane))).resolves.toEqual({ status: 'refused', reason: 'invalid_mode' });
    expect(pane.sent).toHaveLength(0);
  });
});

describe('setModeFor: the guards, every one of which presses nothing', () => {
  it.each([
    [0, 'invalid_pid'],
    [-1, 'invalid_pid'],
    [1.5, 'invalid_pid'],
    ['4242', 'invalid_pid'],
    [null, 'invalid_pid'],
  ] as [unknown, string][])('refuses the pid %s as %s', async (pid, reason) => {
    const pane = cyclingPane('claude', 'manual');
    await expect(setModeFor(pid, 'plan', deps(pane))).resolves.toEqual({ status: 'refused', reason });
    expect(pane.sent).toHaveLength(0);
  });

  it('refuses an unknown mode string from the renderer', async () => {
    const pane = cyclingPane('claude', 'manual');
    await expect(setModeFor(PID, 'yolo' as Mode, deps(pane)))
      .resolves.toEqual({ status: 'refused', reason: 'invalid_mode' });
    expect(pane.sent).toHaveLength(0);
  });

  it('refuses a session this app did not launch', async () => {
    clearRegistry();
    const pane = cyclingPane('claude', 'manual');
    await expect(setModeFor(PID, 'plan', deps(pane))).resolves.toEqual({ status: 'refused', reason: 'not_tmux' });
    expect(pane.sent).toHaveLength(0);
  });

  it('refuses once the tmux session has died', async () => {
    const pane = cyclingPane('claude', 'manual');
    await expect(setModeFor(PID, 'plan', deps(pane, { has: () => false })))
      .resolves.toEqual({ status: 'refused', reason: 'session_gone' });
    expect(pane.sent).toHaveLength(0);
  });

  // §4.1, and the half of it that survives: Shift+Tab into a question does
  // something else entirely. The mid-turn half is gone -- see the readModeFor
  // conversion above, and ipc.test.ts for the guard that session:mode:set
  // passes no busy dep.
  it('refuses while a prompt card is up', async () => {
    const pane = cyclingPane('claude', 'manual');
    await expect(setModeFor(PID, 'plan', deps(pane, { promptOpen: () => true })))
      .resolves.toEqual({ status: 'refused', reason: 'prompt_open' });
    expect(pane.sent).toHaveLength(0);
  });

  // §4.3: read the mode before pressing. An unreadable pane is not a pane
  // to press keys at -- the switch would have nothing to confirm against.
  it('refuses, pressing nothing, when it cannot read the mode first', async () => {
    const pane = cyclingPane('claude', 'manual', { unreadable: true });
    await expect(setModeFor(PID, 'plan', deps(pane)))
      .resolves.toEqual({ status: 'refused', reason: 'unreadable' });
    expect(pane.keys()).toHaveLength(0);
  });

  // §4.2: a pane in copy-mode routes send-keys to that mode's key table.
  it('leaves tmux copy-mode before the first press', async () => {
    const pane = cyclingPane('claude', 'auto', { inMode: true });
    await expect(setModeFor(PID, 'manual', deps(pane))).resolves.toEqual({ status: 'set', mode: 'manual' });
    expect(pane.sent[0]).toContain('-X');
    expect(pane.sent[0]).toContain('cancel');
  });

  it('refuses when it cannot leave copy-mode, rather than pressing into it', async () => {
    const pane = cyclingPane('claude', 'auto', { inMode: true });
    const send = (args: string[]): TmuxResult =>
      args.includes('-X') ? { ok: false, error: 'not in a mode' } : pane.send(args);
    await expect(setModeFor(PID, 'manual', deps(pane, { send })))
      .resolves.toEqual({ status: 'refused', reason: 'session_gone' });
    expect(pane.keys()).toHaveLength(0);
  });

  it('refuses a second switch for the same pid while one is still in flight', async () => {
    const pane = cyclingPane('claude', 'auto');
    // Started, deliberately not awaited: the guards and the in-flight claim
    // run synchronously, so by the time the second call is made the first
    // is already holding the pid.
    const first = setModeFor(PID, 'plan', deps(pane));
    await expect(setModeFor(PID, 'manual', deps(pane)))
      .resolves.toEqual({ status: 'refused', reason: 'in_flight' });
    await expect(first).resolves.toEqual({ status: 'set', mode: 'plan' });
    // The refused call pressed nothing: three presses is auto -> plan alone.
    expect(pane.btabs()).toBe(3);
  });
});

describe('setModeFor: the cap', () => {
  // §4.6: one full cycle plus one, then stop -- never press on in hope.
  it('is one full cycle plus one press', () => {
    expect(MODE_PRESS_CAP.claude).toBe(5);
    expect(MODE_PRESS_CAP.codex).toBe(3);
  });

  it('stops at the cap and fails, rather than looping, when the pane never moves', async () => {
    // A pane stuck on auto: BTab is accepted by tmux and changes nothing.
    const stuck = {
      sent: [] as Call[],
      send: (args: Call): TmuxResult => { stuck.sent.push(args); return { ok: true, stdout: '' }; },
      capture: (args: Call): TmuxResult => args[0] === 'display-message'
        ? { ok: true, stdout: '0\n' }
        : { ok: true, stdout: CLAUDE_SCREENS.auto },
    };
    const d: ModeDeps = {
      send: stuck.send, capture: stuck.capture, sleep: async () => {}, has: () => true,
      provider: () => 'claude', promptOpen: () => false,
    };
    const result = await setModeFor(PID, 'plan', d);
    expect(result).toEqual({ status: 'refused', reason: 'unconfirmed' });
    const btabs = stuck.sent.filter(a => a[a.length - 1] === 'BTab').length;
    expect(btabs).toBeGreaterThan(0);
    expect(btabs).toBeLessThanOrEqual(MODE_PRESS_CAP.claude);
  });

  it('stops at the cap when the pane moves but never reaches the mode asked for', async () => {
    // A pane that ping-pongs between two modes, so plan is unreachable.
    let flip = false;
    const sent: Call[] = [];
    const d: ModeDeps = {
      send: (args: Call): TmuxResult => {
        sent.push(args);
        if (args[args.length - 1] === 'BTab') flip = !flip;
        return { ok: true, stdout: '' };
      },
      capture: (args: Call): TmuxResult => args[0] === 'display-message'
        ? { ok: true, stdout: '0\n' }
        : { ok: true, stdout: flip ? CLAUDE_SCREENS.manual : CLAUDE_SCREENS.auto },
      sleep: async () => {}, has: () => true,
      provider: () => 'claude', promptOpen: () => false,
    };
    const result = await setModeFor(PID, 'plan', d);
    expect(result).toEqual({ status: 'refused', reason: 'exhausted' });
    expect(sent.filter(a => a[a.length - 1] === 'BTab')).toHaveLength(MODE_PRESS_CAP.claude);
  });

  it('stops when a key send fails, rather than pressing again', async () => {
    const sent: Call[] = [];
    const d: ModeDeps = {
      send: (args: Call): TmuxResult => {
        sent.push(args);
        return args[args.length - 1] === 'BTab' ? { ok: false, error: 'no server' } : { ok: true, stdout: '' };
      },
      capture: (args: Call): TmuxResult => args[0] === 'display-message'
        ? { ok: true, stdout: '0\n' }
        : { ok: true, stdout: CLAUDE_SCREENS.auto },
      sleep: async () => {}, has: () => true,
      provider: () => 'claude', promptOpen: () => false,
    };
    await expect(setModeFor(PID, 'plan', d)).resolves.toEqual({ status: 'refused', reason: 'session_gone' });
    expect(sent.filter(a => a[a.length - 1] === 'BTab')).toHaveLength(1);
  });

  it('never logs the mode of a session it refused, only the pid and the reason', async () => {
    const pane = cyclingPane('claude', 'manual');
    await setModeFor(PID, 'plan', deps(pane, { promptOpen: () => true }));
    expect(errors).toHaveBeenCalledWith('session:mode refused', { pid: PID, reason: 'prompt_open' });
  });
});
