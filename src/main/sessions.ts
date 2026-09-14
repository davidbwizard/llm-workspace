import { hasSession, TMUX_NAME } from './tmux.ts';

/** pid -> tmux session name, populated at launch because main is what ran
 *  `tmux new-session` and therefore already knows the name it chose. Names are
 *  never regenerated, guessed, or accepted from the renderer: the renderer
 *  names a pid, exactly as session:kill already requires (src/main/ipc.ts:485). */
const byPid = new Map<number, string>();

/** pid -> the moment main launched it, recorded alongside the tmux name for
 *  the same reason: main is what ran `tmux new-session` and knows exactly
 *  when. Lets a caller (src/fleet/state.ts's openSessionsLive) disambiguate
 *  an otherwise-ambiguous cwd match for a pid the app itself started -- the
 *  app's own session is the one whose earliest event lands at or after this
 *  timestamp, since a session that predates the launch cannot be the one
 *  this pid just started. */
const launchedAtByPid = new Map<number, number>();

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

export function registerSession(pid: number, name: string, launchedAt: number = Date.now()): void {
  if (!validPid(pid)) throw new Error('invalid pid');
  if (!TMUX_NAME.test(name)) throw new Error('refusing a tmux name this app did not generate');
  byPid.set(pid, name);
  launchedAtByPid.set(pid, launchedAt);
}

export function forgetSession(pid: number): void {
  byPid.delete(pid);
  launchedAtByPid.delete(pid);
}

/** Null for a pid this app never launched (an ordinary discovered process,
 *  or a malformed/unknown pid) -- the safe default: a caller that finds
 *  null here must fall back to ordinary cwd matching, never invent a
 *  launch time. */
export function launchedAtForPid(pid: unknown): number | null {
  if (!validPid(pid)) return null;
  return launchedAtByPid.get(pid) ?? null;
}

export function tmuxNameForPid(pid: unknown): string | null {
  if (!validPid(pid)) return null;
  return byPid.get(pid) ?? null;
}

/** The equivalent of killSession's fresh-discovery check. A name that merely
 *  LOOKS right, or that was true a minute ago, is not enough: re-verify the
 *  session exists right now, on this call, before anything is typed into it. */
export function resolveLiveTmux(pid: unknown, deps: { has?: (n: string) => boolean } = {}): string | null {
  const name = tmuxNameForPid(pid);
  if (name === null) return null;
  const has = deps.has ?? ((n: string) => hasSession(n));
  return has(name) ? name : null;
}

export function clearRegistry(): void {
  byPid.clear();
  launchedAtByPid.clear();
}
