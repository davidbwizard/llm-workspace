import { execFileSync } from 'node:child_process';

export type TmuxResult = { ok: true; stdout: string } | { ok: false; error: string };
export type TmuxExec = (args: string[]) => TmuxResult;

/** Only names this app generates. Anchored, and deliberately excludes ':'
 *  and '.', which tmux's own target grammar uses for window.pane. */
export const TMUX_NAME = /^llmws-(claude|codex)-[A-Za-z0-9_-]{1,64}$/;

function defaultExec(args: string[]): TmuxResult {
  try {
    return { ok: true, stdout: execFileSync('tmux', args, { timeout: 5000 }).toString() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'tmux failed' };
  }
}

/** Every target is '=name': tmux matches by prefix otherwise. */
function target(name: string): string {
  return `=${name}`;
}

function guard(name: string): void {
  if (!TMUX_NAME.test(name)) throw new Error('refusing a tmux name this app did not generate');
}

export function hasSession(name: string, exec: TmuxExec = defaultExec): boolean {
  guard(name);
  return exec(['has-session', '-t', target(name)]).ok;
}

export function newSession(
  name: string, cwd: string, command: string, cols: number, rows: number,
  exec: TmuxExec = defaultExec,
): TmuxResult {
  guard(name);
  // -x/-y at creation: there is no attached client, so tmux never learns the
  // size on its own and output would wrap at the default width.
  return exec(['new-session', '-d', '-s', name, '-c', cwd, '-x', String(cols), '-y', String(rows), command]);
}

/** -l is mandatory. Without it tmux reads the text as a KEY NAME: sending
 *  the three characters "C-c" delivers a real Ctrl-C instead. */
export function sendLiteral(name: string, text: string, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['send-keys', '-t', target(name), '-l', text]);
}

/** Only 'Enter' has a caller this phase -- do not pre-populate
 *  Escape/Up/Down/Tab/C-c ahead of a real need. */
export type KeyName = 'Enter';

/** Runtime mirror of the KeyName union. The type alone is not a boundary:
 *  an IPC handler receives `unknown` and widens it back to `string` before
 *  this function ever sees it, so a caller reached through that path could
 *  pass arbitrary text as `key` -- exactly the -l bypass sendLiteral exists
 *  to prevent -- unless this list is also checked at runtime. */
const ALLOWED_KEY_NAMES: readonly string[] = ['Enter'] as const satisfies readonly KeyName[];

/** Deliberate control keys only, chosen by our code, never derived from
 *  user text. Kept in a separate call so text and Enter can never merge. */
export function sendKeyName(name: string, key: KeyName, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  if (!ALLOWED_KEY_NAMES.includes(key)) {
    throw new Error('refusing a key name this app did not allowlist');
  }
  return exec(['send-keys', '-t', target(name), key]);
}

export function capturePane(name: string, lines: number, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['capture-pane', '-p', '-S', `-${lines}`, '-t', target(name)]);
}

export function resizeWindow(name: string, cols: number, rows: number, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['resize-window', '-t', target(name), '-x', String(cols), '-y', String(rows)]);
}

export function panePid(name: string, exec: TmuxExec = defaultExec): number | null {
  guard(name);
  const r = exec(['list-panes', '-t', target(name), '-F', '#{pane_pid}']);
  if (!r.ok) return null;
  const pid = Number.parseInt(r.stdout.trim().split('\n')[0] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
