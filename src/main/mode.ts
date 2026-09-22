import type { Provider } from '../core/types.ts';
import { isModeFor, modesFor, type Mode } from '../core/mode.ts';
import { readModeScreen } from './modeScreen.ts';
import {
  capturePane, sendKeyName, paneInMode, cancelCopyMode, type TmuxExec, type TmuxResult,
} from './tmux.ts';
import { tmuxNameForPid, resolveLiveTmux } from './sessions.ts';

/** The mode switcher, main side. Spec: docs/superpowers/specs/
 *  2026-09-21-mode-switcher-design.md §4.
 *
 *  Neither CLI has a "set mode X" command; both move on Shift+Tab. So the
 *  app presses and RE-READS until the pane reports the mode asked for, and
 *  gives up cleanly rather than pressing on in hope.
 *
 *  The renderer names a pid and a mode, nothing else. Main resolves the
 *  provider itself, checks the mode against THAT provider's own list, and
 *  presses no key until every guard below has passed -- the same boundary
 *  session:answer (src/main/answer.ts) keeps. */

export type ModeRefusal =
  | 'invalid_pid' | 'not_tmux' | 'session_gone' | 'invalid_mode'
  | 'prompt_open' | 'unreadable' | 'unconfirmed' | 'exhausted' | 'in_flight';

/** Why the chip cannot be clicked right now, or null when it can. The mode
 *  it already read is reported alongside where there is one: a session with
 *  a prompt card up still shows the mode it is in, it just cannot switch.
 *
 *  Every one of these is shown to the person as a DISABLED chip with the
 *  reason attached, never as a missing one -- a control that vanishes
 *  teaches nothing about why it is not there. */
export type ModeBlock = 'not_tmux' | 'session_gone' | 'prompt_open' | 'unreadable';

export type ModeState = {
  provider: Provider;
  /** null means there is no mode to name: the app did not launch this
   *  session (no pane), the session has ended, or the reader could not
   *  identify what the pane is showing. §5's rule is unchanged -- the chip
   *  never NAMES a mode it does not know -- but it stays on screen,
   *  disabled, carrying `blocked` as its reason. */
  mode: Mode | null;
  blocked: ModeBlock | null;
};

export type ModeSetResult =
  | { status: 'set'; mode: Mode }
  | { status: 'unchanged'; mode: Mode }
  | { status: 'refused'; reason: ModeRefusal };

/** Injected in tests; production passes the closures registerIpc already
 *  builds for sendKeysFor (provider) and promptOpenFor, and takes the real
 *  tmux and timer for the rest. Mirrors AnswerDeps (src/main/answer.ts)
 *  deliberately: the same shapes, so the two cannot drift on what a test
 *  has to fake. */
export type ModeDeps = {
  /** Every outbound tmux call: the BTab presses and leaving copy-mode. */
  send?: TmuxExec;
  /** Every read: capture-pane and the copy-mode query. */
  capture?: (args: string[]) => TmuxResult;
  sleep?: (ms: number) => Promise<void>;
  has?: (name: string) => boolean;
  /** Which provider is at this pid, or null when it cannot be told. The
   *  menu, the mode list and the reader are all per provider, so without
   *  this there is nothing to validate a requested mode against and no
   *  chip is shown at all. */
  provider?: (pid: number) => Provider | null;
  /** Whether a prompt card is up. The ONE thing that blocks a switch:
   *  Shift+Tab into an open question does something else entirely.
   *
   *  There is deliberately no `busy` dep beside it. This module used to
   *  refuse mid-turn as well, from §4.1's original wording -- measured
   *  against a live pane on 2026-09-22 and dropped: with the session
   *  genuinely streaming (capture growing 4047 -> 4508 bytes), Shift+Tab
   *  moved the pane from accept edits to plan while the reply kept
   *  arriving. The block bought nothing and made the chip dead for most of
   *  the time anyone is looking at a working session. See §4 of the design
   *  doc before reinstating it. */
  promptOpen?: (pid: number) => boolean;
};

/** §4.6: one full cycle plus one press, then stop. Claude cycles four
 *  states, Codex toggles two, so the cap differs per provider rather than
 *  being one number that is too loose for one of them. */
export const MODE_PRESS_CAP: Record<Provider, number> = {
  claude: modesFor('claude').length + 1,
  codex: modesFor('codex').length + 1,
};

const SETTLE_POLL_MS = 50;
const SETTLE_TIMEOUT_MS = 1500;

/** One switch in flight per pid. Two presses racing each other would each
 *  re-read a pane the other is moving, and neither could account for what
 *  it saw. Same guard, same reason, as answerPrompt's own `inFlight`. */
const inFlight = new Set<number>();

/** Test hook, same role as clearRegistry (src/main/sessions.ts). */
export function clearModeInFlight(): void {
  inFlight.clear();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Refusals carry the pid and the reason and nothing else -- never the
 *  mode asked for, and never tmux's own output, which can echo pane text. */
function refuse(pid: unknown, reason: ModeRefusal): ModeSetResult {
  console.error('session:mode refused', {
    pid: typeof pid === 'number' && Number.isFinite(pid) ? pid : null,
    reason,
  });
  return { status: 'refused', reason };
}

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

function readPane(name: string, provider: Provider, capture: ModeDeps['capture']): Mode | null {
  const cap = capturePane(name, null, capture);
  if (!cap.ok) return null;
  return readModeScreen(cap.stdout, provider).mode;
}

/** The chip's state for one pid, or null when there is nothing to draw a
 *  chip from at all: a pid that is not a live process of a known provider.
 *  The provider decides the menu, the mode list and the reader, so without
 *  it there is not even a disabled chip to show.
 *
 *  Synchronous, and at most ONE capture-pane: this is called from the
 *  session:live push path, which runs on the pane's own change cadence
 *  (coalesced at 250 ms; ~6 ms per capture-pane, measured 2026-09-21).
 *
 *  A session with no pane to read -- one this app did not launch, or one
 *  whose tmux session has died -- captures nothing at all, and says which
 *  of the two it is. A session that is merely BLOCKED from switching (a
 *  prompt card up) is still read: §4.1 disables the chip, it does not blank
 *  it, so the mode has to keep arriving while the agent works. */
export function readModeFor(pid: unknown, deps: ModeDeps = {}): ModeState | null {
  if (!validPid(pid)) return null;
  const provider = deps.provider?.(pid) ?? null;
  if (provider === null) return null;

  // A session the app did not launch has no pane to capture -- the common
  // case, one started in iTerm or VS Code. It gets a disabled chip carrying
  // that reason rather than no chip: the control that is absent teaches
  // nothing, and this is the same treatment missing dependencies already
  // get in the first-run work.
  if (tmuxNameForPid(pid) === null) return { provider, mode: null, blocked: 'not_tmux' };
  const name = resolveLiveTmux(pid, { has: deps.has });
  if (name === null) return { provider, mode: null, blocked: 'session_gone' };

  const mode = readPane(name, provider, deps.capture);
  // Order matters: an unreadable pane is reported as unreadable only when
  // nothing more specific already blocks the chip, so a session with a
  // prompt card up whose screen happens not to carry a footer still says so.
  const blocked: ModeBlock | null =
    deps.promptOpen?.(pid) === true ? 'prompt_open'
      : mode === null ? 'unreadable'
        : null;
  return { provider, mode, blocked };
}

/** Switches the pane to `mode`. Never throws: every outcome is a result.
 *  Every refusal before the loop presses nothing at all. */
export async function setModeFor(pid: unknown, mode: unknown, deps: ModeDeps = {}): Promise<ModeSetResult> {
  if (!validPid(pid)) return refuse(pid, 'invalid_pid');

  // The provider decides which modes exist, so it is resolved before the
  // requested mode is validated -- a Claude mode name for a Codex session
  // has no Shift+Tab sequence that reaches it, and pressing anything for
  // it would be a guess.
  // `not_tmux` for an unresolvable provider: the only way that happens is
  // a pid the discovery cache does not carry, which is the same fact that
  // reason already stands for everywhere else -- this app has no live
  // session at that pid to act on.
  const provider = deps.provider?.(pid) ?? null;
  if (provider === null) return refuse(pid, 'not_tmux');
  if (!isModeFor(provider, mode)) return refuse(pid, 'invalid_mode');
  const target: Mode = mode;

  // Same not_tmux/session_gone split as sendKeysFor and answerPrompt.
  if (tmuxNameForPid(pid) === null) return refuse(pid, 'not_tmux');
  const name = resolveLiveTmux(pid, { has: deps.has });
  if (name === null) return refuse(pid, 'session_gone');

  // §4.1: refuse outright while a prompt card is up. Shift+Tab into a
  // question does something else entirely. Mid-turn is NOT refused -- see
  // ModeDeps.promptOpen for the measurement that removed that guard.
  if (deps.promptOpen?.(pid) === true) return refuse(pid, 'prompt_open');

  if (inFlight.has(pid)) return refuse(pid, 'in_flight');
  try {
    inFlight.add(pid);
    const result = await run(pid, name, provider, target, deps);
    if (result.status !== 'refused') {
      // The pid and the mode reached, nothing about the session itself.
      console.log('session:mode', { pid, status: result.status, mode: result.mode });
    }
    return result;
  } catch (err) {
    // Only this module's own guards throw (a tmux name or key name outside
    // its allowlist), with fixed messages -- never tmux output.
    console.error('session:mode failed:', err instanceof Error ? err.message : 'unknown error');
    return refuse(pid, 'unconfirmed');
  } finally {
    inFlight.delete(pid);
  }
}

async function run(
  pid: number, name: string, provider: Provider, target: Mode, deps: ModeDeps,
): Promise<ModeSetResult> {
  const sleep = deps.sleep ?? defaultSleep;

  // §4.2: leave copy-mode first. A pane in one of tmux's own modes routes
  // send-keys to that mode's key table, so a BTab would be spent there --
  // and, worse for this feature, the pane would still read as its old mode
  // afterwards, so the loop would keep pressing at a pane that never
  // receives a key. tmux FAILS `-X cancel` when the pane is not in a mode,
  // so the mode is read first rather than the cancel sent blind.
  const inCopyMode = paneInMode(name, deps.capture);
  if (inCopyMode.ok && inCopyMode.stdout.trim() === '1') {
    const left = cancelCopyMode(name, deps.send);
    if (!left.ok) {
      console.error('session:mode could not leave copy-mode:', left.error);
      return refuse(pid, 'session_gone');
    }
  }

  // §4.3: read the mode BEFORE pressing anything. A pane whose mode cannot
  // be identified is not a pane to press keys at: there would be nothing to
  // confirm the press against, and §5's rule is that an unidentifiable mode
  // is reported, never guessed.
  let current = readPane(name, provider, deps.capture);
  if (current === null) return refuse(pid, 'unreadable');
  // §4.4: already there.
  if (current === target) return { status: 'unchanged', mode: target };

  // §4.5-4.6: one press, re-read, repeat -- capped, and failing cleanly on
  // exhaustion rather than pressing on in hope. The loop never counts
  // presses against a remembered position: every iteration decides from
  // what the pane says NOW, so a mode changed in the terminal half way
  // through is simply the new starting point rather than a miscount.
  for (let pressed = 0; pressed < MODE_PRESS_CAP[provider]; pressed++) {
    const sent = sendKeyName(name, 'BTab', deps.send);
    if (!sent.ok) {
      // A failed send may still have reached the pane, so this stops here
      // rather than retrying: pressing again could double-step the cycle.
      console.error('session:mode key send failed:', sent.error);
      return refuse(pid, 'session_gone');
    }
    const moved = await settle(name, provider, current, deps, sleep);
    // The pane did not visibly move within the settle budget. Pressing
    // again would be pressing at a pane that is not responding the way the
    // measurement says it should -- stop and say so.
    if (moved === null) return refuse(pid, 'unconfirmed');
    current = moved;
    if (current === target) return { status: 'set', mode: target };
  }
  return refuse(pid, 'exhausted');
}

/** Polls every 50 ms, up to 1.5 s, until the pane reports a mode DIFFERENT
 *  from `before`. Returns that mode, or null on timeout.
 *
 *  A transient unreadable frame (the TUI mid-redraw) just keeps the poll
 *  going: it is not an answer either way. A failed capture ends it at once
 *  -- a pane that cannot be read cannot confirm anything, and retrying a
 *  wedged tmux would only spend the whole budget on it. */
async function settle(
  name: string, provider: Provider, before: Mode, deps: ModeDeps, sleep: (ms: number) => Promise<void>,
): Promise<Mode | null> {
  for (let waited = 0; ; waited += SETTLE_POLL_MS) {
    const cap = capturePane(name, null, deps.capture);
    if (!cap.ok) return null;
    const mode = readModeScreen(cap.stdout, provider).mode;
    if (mode !== null && mode !== before) return mode;
    if (waited >= SETTLE_TIMEOUT_MS) return null;
    await sleep(SETTLE_POLL_MS);
  }
}
