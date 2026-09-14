import { hasSession, TMUX_NAME, panePid, listSessionNames, type TmuxExec } from './tmux.ts';

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

/** The shared validation+write both registerSession (below) and
 *  adoptRunningSessions (further down) need, factored out so the latter
 *  can populate `byPid` without also stamping a launch timestamp that
 *  would be a fabrication for a session this run never launched. */
function setPidName(pid: number, name: string): void {
  if (!validPid(pid)) throw new Error('invalid pid');
  if (!TMUX_NAME.test(name)) throw new Error('refusing a tmux name this app did not generate');
  byPid.set(pid, name);
}

export function registerSession(pid: number, name: string, launchedAt: number = Date.now()): void {
  setPidName(pid, name);
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

/** Rebuilds `byPid` from tmux itself -- the actual source of truth, and the
 *  reason tmux was chosen over a bespoke supervisor in the first place: the
 *  binding's own design is "quit or crash the app and the run continues;
 *  reopen and reattach." `byPid` is otherwise written ONLY by
 *  registerSession, called from launchSession (src/main/launch.ts) at the
 *  moment THIS run launches a pid -- nothing else repopulates it, so it
 *  starts empty on every app restart even though the tmux sessions it
 *  named do not. Without this, every session the app ever launched reports
 *  `tmux: false` forever after a restart, for a run that is still alive.
 *
 *  Called once at startup (src/main/index.ts, before the first discovery
 *  push) and again on every periodic discovery sweep, not launch-time
 *  only -- so a session started by hand under our own naming scheme gets
 *  adopted too, and a session that has since ended drops back out on the
 *  very next sweep instead of lingering as a stale `tmux: true`.
 *
 *  Reconciles rather than only adding: a pid `byPid` still remembers that
 *  tmux's live list no longer backs is forgotten (forgetSession, which
 *  also clears its launchedAtByPid entry -- there is nothing left to
 *  disambiguate once the process is actually gone). A pid genuinely new
 *  this sweep is registered via setPidName, NOT registerSession -- this
 *  run never launched it, so stamping a launch timestamp would fabricate a
 *  launch moment nothing observed (launchedAtForPid's own doc comment: null
 *  is the correct default there, never a guess). A pid already known under
 *  the exact same name is left untouched, so a real launch timestamp
 *  registerSession recorded moments ago survives every later sweep. */
export function adoptRunningSessions(deps: {
  listSessionNames?: (exec?: TmuxExec) => string[];
  panePid?: (name: string, exec?: TmuxExec) => number | null;
} = {}): void {
  const list = deps.listSessionNames ?? listSessionNames;
  const pid = deps.panePid ?? panePid;

  const live = new Map<number, string>();
  for (const name of list()) {
    if (!TMUX_NAME.test(name)) continue; // never adopt a session this app did not create
    const p = pid(name);
    if (p !== null) live.set(p, name); // a pane that's already gone contributes nothing
  }

  for (const knownPid of [...byPid.keys()]) {
    if (!live.has(knownPid)) forgetSession(knownPid);
  }
  for (const [p, name] of live) {
    if (byPid.get(p) !== name) setPidName(p, name);
  }
}

export function clearRegistry(): void {
  byPid.clear();
  launchedAtByPid.clear();
}
