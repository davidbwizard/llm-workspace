import { hasSession, TMUX_NAME } from './tmux.ts';

/** pid -> tmux session name, populated at launch because main is what ran
 *  `tmux new-session` and therefore already knows the name it chose. Names are
 *  never regenerated, guessed, or accepted from the renderer: the renderer
 *  names a pid, exactly as session:kill already requires (src/main/ipc.ts:485). */
const byPid = new Map<number, string>();

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

export function registerSession(pid: number, name: string): void {
  if (!validPid(pid)) throw new Error('invalid pid');
  if (!TMUX_NAME.test(name)) throw new Error('refusing a tmux name this app did not generate');
  byPid.set(pid, name);
}

export function forgetSession(pid: number): void {
  byPid.delete(pid);
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
}
