import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { Provider } from '../core/types.ts';
// Validated before any session id or name reaches tmux's shell string.
import { SESSION_ID_SAFE } from '../core/identity.ts';
import { SESSION_NAME_SAFE, SESSION_NAME_MAX, SESSION_NAME_HELP } from '../core/sessionName.ts';
import type { KillResult } from './ipc.ts';
import { newSession, setSessionOption, panePid as tmuxPanePid, type TmuxExec } from './tmux.ts';
import { registerSession } from './sessions.ts';
import {
  codexDaemonSocket, codexRelayName, codexRelaySocket,
  waitForCodexRelaySocket, waitForCodexThreadId,
} from './codexRelayControl.ts';
import { setCodexThreadName, type CodexNameResult } from './codexAppServer.ts';

const execFileAsync = promisify(execFile);

export type LaunchResult =
  | {
    status: 'launched'; pid: number;
    /** The session started, but something asked of the launch could not be
     *  done -- today only "the name could not be set on the Codex thread"
     *  (launchCodexSession below). NOT a failure: the process is running
     *  and the caller must still select it. It exists so that case is
     *  neither reported as a failed launch (untrue -- a session IS there)
     *  nor swallowed (the person asked for a name and did not get one).
     *  Shown verbatim, same as `reason`. */
    warning?: string;
  }
  | { status: 'failed'; reason: string }
  // reattachSession's own failure mode, distinct from an ordinary launch
  // failure: the OLD process is confirmed gone and the NEW one did not
  // start. An ordinary 'failed' here would read as "nothing happened" --
  // untrue, and the opposite of what the user needs to know. sessionId/cwd
  // are what a retry needs: resumeSession (below) can relaunch from them
  // directly, without re-resolving a pid that no longer exists.
  | { status: 'killed_not_relaunched'; reason: string; sessionId: string; cwd: string };

type LaunchDeps = {
  exec?: TmuxExec; panePid?: (name: string) => number | null;
  /** Injectable clock for the launch timestamp registerSession records
   *  below -- defaults to Date.now(). Exists so a test can pin the launch
   *  moment precisely relative to fixture event timestamps, the same
   *  reason FleetOpts.now (src/fleet/state.ts) is injectable. */
  now?: number;
};

/** POSIX single-quote escaping, correct for ANY string including one with
 *  newlines: everything between single quotes is literal to a shell, and
 *  the only character that cannot appear there -- the single quote itself
 *  -- is emitted as `'\''` (close, escaped quote, reopen).
 *
 *  Deliberately independent of SESSION_NAME_SAFE rather than relying on it.
 *  The character set already excludes every metacharacter, so today this is
 *  belt to that braces; it is here so that widening the character set later
 *  cannot silently turn a name back into executable text. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type LaunchCommandResult =
  | { ok: true; command: string }
  | { ok: false; reason: string };

/** Why a user-typed session name is refused, or null when it is fine --
 *  the ONE statement of the rules on the main side, so the two things that
 *  now consume a name (launchCommand below, which puts it on a command
 *  line, and launchCodexSession, which sends it into Codex's own state
 *  over the App Server protocol) cannot drift apart. Neither is allowed to
 *  be the laxer one.
 *
 *  Length is reported separately from shape: "too long" and "has a
 *  character that is not allowed" are different mistakes, and a person who
 *  typed 80 valid characters should not be told to use different ones. */
export function sessionNameRefusal(name: string): string | null {
  if (name.length > SESSION_NAME_MAX) {
    return `That name is too long -- keep it to ${SESSION_NAME_MAX} characters.`;
  }
  return SESSION_NAME_SAFE.test(name) ? null : SESSION_NAME_HELP;
}

/** The command a named launch runs inside the new tmux pane -- the ONE
 *  place a user-typed name is validated and quoted for a SHELL, so neither
 *  step can be reached without the other.
 *
 *  A blank name is the ordinary case, not an error: it launches the bare
 *  provider exactly as launchSession's own default does, and Claude derives
 *  a name for itself.
 *
 *  `codex --name` does not exist: codex-cli 0.157.0's help carries no such
 *  flag (`codex --help | grep -c -- '--name'` is 0, checked 2026-09-28), so
 *  a Codex name goes nowhere near the command line -- the command stays the
 *  bare `codex`, and launchCodexSession sets the name on the thread
 *  afterwards, over the App Server protocol Fleet already relays. The name
 *  is still VALIDATED here, because ipc.ts uses this as its boundary check
 *  for both providers before anything is spawned. */
export function launchCommand(provider: Provider, name: string | null | undefined): LaunchCommandResult {
  if (name === null || name === undefined || name === '') return { ok: true, command: provider };
  const refusal = sessionNameRefusal(name);
  if (refusal !== null) return { ok: false, reason: refusal };
  return provider === 'claude'
    ? { ok: true, command: `claude -n ${shellQuote(name)}` }
    : { ok: true, command: provider };
}

/** Nothing spawns on its own: this is only ever reached from an explicit
 *  choice of provider and directory (LaunchBar), or from reattachSession
 *  below (an explicit choice to relaunch one specific existing session).
 *
 *  No key is sent after launching. Claude Code opens on a trust prompt with
 *  "No, exit" selected by default -- during the phase-6 probe a single Enter
 *  chose it and killed the session. The card surfaces the prompt; the
 *  person answers it, over session:raw once the terminal is attached, never
 *  from here.
 *
 *  `command` defaults to the bare provider name, PATH-resolved inside the
 *  new tmux pane's own shell -- the ordinary launch path. reattachSession is
 *  the only caller that overrides it, to run `claude --resume <id>` in the
 *  pane instead of a fresh `claude`. */
export function launchSession(
  provider: Provider, cwd: string, cols: number, rows: number,
  deps: LaunchDeps = {}, command: string = provider, sessionName?: string,
): LaunchResult {
  const name = sessionName ?? `llmws-${provider}-${randomUUID().slice(0, 8)}`;
  const started = newSession(name, cwd, command, cols, rows, deps.exec);
  if (!started.ok) return { status: 'failed', reason: started.error };

  // tmux's mouse support is off by default, so once a real client attaches
  // (session:attach, ipc.ts) the wheel does nothing until this runs. Set
  // here too -- not just at attach time -- so a freshly created session is
  // already scrollable from its very first attach. Session-scoped (never
  // -g): see setSessionOption's own doc comment in tmux.ts.
  setSessionOption(name, 'mouse', 'on', deps.exec);
  // tmux's own status line has no reason to render inside this app -- the
  // app already has its own chrome around the terminal, and the status
  // line just wastes a row and reads as noise (it showed up as a literal
  // "[llmws-claude-...:[tmux]" line at the bottom once a real client
  // attached). Off for THIS session alone, same -t-not-g discipline as the
  // mouse option above -- never global, which would strip the status line
  // from every tmux session on the machine, including ones this app has
  // nothing to do with.
  setSessionOption(name, 'status', 'off', deps.exec);

  const lookup = deps.panePid ?? (n => tmuxPanePid(n));
  const pid = lookup(name);
  if (pid === null) return { status: 'failed', reason: 'session started but no pid could be read' };

  registerSession(pid, name, deps.now ?? Date.now());
  return { status: 'launched', pid };
}

type CodexLaunchDeps = LaunchDeps & {
  startDaemon?: () => Promise<void>;
  startRelay?: (name: string, cwd: string, command: string) => void;
  waitRelay?: (path: string) => Promise<boolean>;
  relayScript?: string;
  executable?: string;
  socketHome?: string;
  /** Resolves the exact thread the freshly launched TUI opened, or null if
   *  it never shows up. Injected for tests; the real one polls the tmux
   *  option the relay writes (waitForCodexThreadId, codexRelayControl.ts). */
  waitThread?: (pid: number) => Promise<string | null>;
  /** Sends thread/name/set for that thread. Injected for tests; the real
   *  one opens its own short-lived connection to the App Server daemon. */
  setName?: (threadId: string, name: string) => Promise<CodexNameResult>;
};

/** Fleet-owned Codex terminals connect through a per-TUI relay. The relay
 * observes the TUI's own App Server thread switches and stores their exact
 * result in tmux; it remains alive when Fleet closes. The running daemon is
 * reused, never restarted. A failed launch leaves no fabricated mapping.
 *
 * `name` names the session at birth. It cannot go on the command line --
 * `codex` has no name flag (see launchCommand above) -- so it is applied
 * afterwards, to the thread the TUI actually opened, over the same App
 * Server protocol this relay already carries. That thread does not exist
 * at spawn time: it appears only once the TUI has connected through the
 * relay and the App Server has answered its thread/start, which is why the
 * naming step waits rather than firing at launch.
 *
 * The name is validated BEFORE anything is spawned, so a refusal never
 * leaves a session nobody asked for; and once a session IS running, no
 * naming failure can turn the result into 'failed' -- it comes back as a
 * `warning` on a launched result instead. */
export async function launchCodexSession(
  cwd: string, cols: number, rows: number, deps: CodexLaunchDeps = {},
  name?: string | null,
): Promise<LaunchResult> {
  const wanted = name ?? '';
  if (wanted !== '') {
    // The third and last gate (the field, then launchCommand at the IPC
    // boundary, then here). This one is not redundant: it is the one that
    // sits directly in front of the call that crosses into Codex's own
    // state database, so it cannot be skipped by a future caller that
    // reaches launchCodexSession without going through ipc.ts.
    const refusal = sessionNameRefusal(wanted);
    if (refusal !== null) return { status: 'failed', reason: refusal };
  }
  const tuiName = `llmws-codex-relay-${randomUUID().slice(0, 8)}`;
  const relayName = codexRelayName(tuiName);
  const socket = codexRelaySocket(tuiName, deps.socketHome);
  let launched: LaunchResult;
  try {
    await (deps.startDaemon ?? (async () => {
      await execFileAsync('codex', ['app-server', 'daemon', 'start'], { timeout: 15000 });
    }))();
    const relayCommand = `ELECTRON_RUN_AS_NODE=1 ${shellQuote(deps.executable ?? process.execPath)} `
      + `${shellQuote(deps.relayScript ?? join(import.meta.dirname, 'codexRelay.js'))} `
      + `${shellQuote(socket)} ${shellQuote(codexDaemonSocket())} ${shellQuote(tuiName)}`;
    // `session`, not `name` -- this callback's first argument is the relay's
    // tmux session name, and `name` is now this function's own parameter
    // (the session name the person typed).
    (deps.startRelay ?? ((session, dir, command) => {
      execFileSync('tmux', ['new-session', '-d', '-s', session, '-c', dir, command], { timeout: 5000 });
    }))(relayName, cwd, relayCommand);
    if (!await (deps.waitRelay ?? waitForCodexRelaySocket)(socket)) {
      return { status: 'failed', reason: 'Codex relay did not open its local socket' };
    }
    launched = launchSession('codex', cwd, cols, rows, deps,
      `codex -C ${shellQuote(cwd)} --remote ${shellQuote(`unix://${socket}`)}`, tuiName);
  } catch (error) {
    return { status: 'failed', reason: `Could not start Codex relay: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Deliberately OUTSIDE the try above: from here the session is running,
  // and nothing that happens next may be reported as a launch failure.
  if (launched.status !== 'launched' || wanted === '') return launched;
  const warning = await nameCodexThread(launched.pid, wanted, deps);
  return warning === null ? launched : { ...launched, warning };
}

/** Names the thread belonging to a Codex session that has ALREADY started.
 *  Returns null when the name was set, or the sentence to show the person
 *  when it was not -- never throws, and never reports success it did not
 *  get. Every failure here costs the name and nothing else: the session is
 *  running either way, and can still be renamed from inside Codex. */
async function nameCodexThread(pid: number, name: string, deps: CodexLaunchDeps): Promise<string | null> {
  try {
    const threadId = await (deps.waitThread ?? (p => waitForCodexThreadId(p)))(pid);
    if (threadId === null) {
      // Measured cause, not a guess: a TUI that is waiting on one of
      // codex's own prompts (an update notice, say) opens no thread until
      // someone answers it -- see THREAD_ID_TIMEOUT_MS in
      // codexRelayControl.ts. So the sentence points at the terminal.
      return 'Launched, but the session could not be named: Codex had not opened a thread yet. '
        + 'Answer anything it is asking in the terminal, then name it there.';
    }
    const set = await (deps.setName ?? ((id, value) => setCodexThreadName(id, value)))(threadId, name);
    return set.ok ? null
      : `Launched, but the session could not be named: ${set.reason}. Rename it from the session.`;
  } catch (error) {
    return 'Launched, but the session could not be named: '
      + `${error instanceof Error ? error.message : String(error)}. Rename it from the session.`;
  }
}

/** session:resume. Relaunches a Claude conversation from its session id and
 *  cwd alone, with no kill step and no pid to resolve from -- this is what a
 *  retry after `killed_not_relaunched` calls, and the only reason it can
 *  work there is that it never needs the OLD pid at all (which, at retry
 *  time, is already dead and gone from every discovery cache). Also the
 *  primitive reattachSession itself relaunches through, below, so the
 *  session id validation lives in exactly one place. */
export function resumeSession(
  sessionId: string, cwd: string, cols: number, rows: number, deps: LaunchDeps = {},
): LaunchResult {
  if (!SESSION_ID_SAFE.test(sessionId)) {
    return { status: 'failed', reason: 'this session id has an unexpected shape' };
  }
  return launchSession('claude', cwd, cols, rows, deps, `claude --resume ${sessionId}`);
}

export interface ResolvedSession { sessionId: string; provider: Provider; cwd: string }

type ReattachDeps = LaunchDeps & {
  /** Ends the process at this pid. Always the production killSession
   *  (src/main/ipc.ts) in real use -- injected rather than imported,
   *  because ipc.ts is what imports launchSession/reattachSession FROM this
   *  module; importing killSession back here would be circular. No
   *  default: with none given, reattach refuses rather than guessing how
   *  to end the old process. */
  kill?: (pid: number) => Promise<KillResult>;
  /** Resolves which session (id, provider, cwd) a live pid belongs to.
   *  Real use always injects one backed by the app's own discovery/index
   *  data (ipc.ts) -- this module has no database or process-discovery
   *  access of its own. No default: with none given, every pid resolves to
   *  "unidentifiable", the safe direction (refuse) rather than the unsafe
   *  one (guess which session, or assume Claude). */
  resolveSession?: (pid: number) => ResolvedSession | null;
  /** Whether Claude Code has a saved conversation for this session id in
   *  this cwd. `claude --resume` fails ("No conversation found") without
   *  one, and a session has none until its first message. Checked BEFORE
   *  the kill. Optional so existing callers keep today's behaviour; the
   *  app (ipc.ts) always supplies it. */
  hasTranscript?: (sessionId: string, cwd: string) => boolean;
};

/** session:reattach. Ends the existing process at `pid` and relaunches its
 *  conversation inside tmux via `claude --resume <session-id>`, as ONE
 *  main-side call: the renderer makes a single request and gets back a
 *  single LaunchResult. The intermediate state -- old session dead, new one
 *  not yet started -- never crosses back out to the renderer, so it can
 *  never leave a session killed but not relaunched (it can only ever see
 *  "still running" or "done", never "half done").
 *
 *  Every refusal below runs, in order, before the destructive step
 *  (killing the old process): identify the session, gate its provider,
 *  validate its id. Nothing is torn down until every check upstream of the
 *  kill has already passed.
 *
 *  Codex resume is UNPROBED on this machine (spec §3) -- gated to Claude
 *  sessions here, with a `reason` string the UI shows verbatim, rather than
 *  attempting it and failing in some Codex-specific way nobody has
 *  characterised yet. */
export async function reattachSession(
  pid: number, cols: number, rows: number, deps: ReattachDeps = {},
): Promise<LaunchResult> {
  const resolveSession = deps.resolveSession ?? (() => null);
  const resolved = resolveSession(pid);
  if (resolved === null) {
    return { status: 'failed', reason: 'could not identify which session this process belongs to' };
  }
  if (resolved.provider !== 'claude') {
    return {
      status: 'failed',
      reason: 'Codex sessions cannot be reattached yet -- resume is only verified for Claude.',
    };
  }
  if (!SESSION_ID_SAFE.test(resolved.sessionId)) {
    return { status: 'failed', reason: 'this session id has an unexpected shape' };
  }
  if (deps.hasTranscript && !deps.hasTranscript(resolved.sessionId, resolved.cwd)) {
    return { status: 'failed', reason: 'this session has no saved conversation yet -- send it a message first, then reattach' };
  }
  if (!deps.kill) {
    return { status: 'failed', reason: 'no way to end the existing session' };
  }

  const killed = await deps.kill(pid);
  if (killed.status !== 'killed' && killed.status !== 'already_gone') {
    return { status: 'failed', reason: `could not end the existing session (${killed.reason})` };
  }

  // The old process is confirmed gone (or already was) -- only now does the
  // new one start, under the SAME session id, so `claude --resume` picks up
  // exactly the conversation that was just ended, never a stale copy racing
  // against a still-live one.
  //
  // A failure from here on is NOT an ordinary launch failure: the old
  // process is already gone, so "nothing happened" (what 'failed' implies
  // everywhere else) would be false. resolved.sessionId/resolved.cwd are
  // captured now, while they still resolve -- resolveSession above reads
  // the live-process cache, which this pid is about to permanently drop
  // out of, so a caller that tried to re-resolve it after this point would
  // get "cannot identify", not a retry.
  const relaunch = resumeSession(
    resolved.sessionId, resolved.cwd, cols, rows, { exec: deps.exec, panePid: deps.panePid },
  );
  if (relaunch.status === 'failed') {
    return {
      status: 'killed_not_relaunched',
      reason: relaunch.reason,
      sessionId: resolved.sessionId,
      cwd: resolved.cwd,
    };
  }
  return relaunch;
}
