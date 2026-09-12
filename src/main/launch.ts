import { randomUUID } from 'node:crypto';
import type { Provider } from '../core/types.ts';
import type { KillResult } from './ipc.ts';
import { newSession, panePid as tmuxPanePid, type TmuxExec } from './tmux.ts';
import { registerSession } from './sessions.ts';

export type LaunchResult = { status: 'launched'; pid: number } | { status: 'failed'; reason: string };

type LaunchDeps = { exec?: TmuxExec; panePid?: (name: string) => number | null };

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
  deps: LaunchDeps = {}, command: string = provider,
): LaunchResult {
  const name = `llmws-${provider}-${randomUUID().slice(0, 8)}`;
  const started = newSession(name, cwd, command, cols, rows, deps.exec);
  if (!started.ok) return { status: 'failed', reason: started.error };

  const lookup = deps.panePid ?? (n => tmuxPanePid(n));
  const pid = lookup(name);
  if (pid === null) return { status: 'failed', reason: 'session started but no pid could be read' };

  registerSession(pid, name);
  return { status: 'launched', pid };
}

/** Claude's own session id, exactly as it names its transcript file
 *  (src/watch/watcher.ts: `sessionId = basename(sessionDir)`) -- a UUID in
 *  practice, but validated here rather than trusted, because it is about to
 *  be interpolated into the one string tmux's own new-session command takes
 *  (there is no argv-array escape from that -- tmux hands its trailing
 *  shell-command argument to a shell, same as every other launchSession
 *  call). Anchored, restricted to characters no shell gives special
 *  meaning to. */
const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;

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
  return launchSession(
    'claude', resolved.cwd, cols, rows,
    { exec: deps.exec, panePid: deps.panePid },
    `claude --resume ${resolved.sessionId}`,
  );
}
