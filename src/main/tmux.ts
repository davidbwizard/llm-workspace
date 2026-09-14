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

/** Every target is '=name:': the leading '=' makes tmux match this name
 *  exactly rather than by prefix. The trailing ':' is NOT decorative --
 *  verified against a real tmux 3.7c server, not just this file's own
 *  mocked tests (which never invoke a real binary and so could not have
 *  caught this): target-PANE commands (send-keys, capture-pane, pipe-pane)
 *  fail with "can't find pane" on a bare '=name' once a session has no
 *  window/pane suffix, even though target-SESSION (has-session) and the
 *  more lenient target-WINDOW/target commands (resize-window, list-panes)
 *  accept it fine either way. An empty suffix after ':' means "this
 *  session's current window, current pane" -- always window 0 pane 0 for a
 *  session this app created via newSession and never split -- and the
 *  exact-match property still holds with it (confirmed: '=name:' does not
 *  match a different real session whose name merely starts with 'name'). */
function target(name: string): string {
  return `=${name}:`;
}

function guard(name: string): void {
  if (!TMUX_NAME.test(name)) throw new Error('refusing a tmux name this app did not generate');
}

export function hasSession(name: string, exec: TmuxExec = defaultExec): boolean {
  guard(name);
  return exec(['has-session', '-t', target(name)]).ok;
}

/** True when the pane is showing its alternate screen -- i.e. a full-screen
 *  TUI (Claude Code, vim, etc.) that owns the whole pane and repaints it on
 *  every resize, rather than an ordinary shell whose scrollback is a
 *  meaningful line-by-line history. tmux's own `#{alternate_on}` format
 *  variable is exactly this distinction (1 while the alternate screen is
 *  active, 0 for the normal screen), so this defers to tmux rather than
 *  guessing from a process name or command string. A failed query (pane
 *  gone, tmux unreachable) reads as false -- the caller's existing
 *  full-scrollback behaviour is the safe default when this can't be
 *  determined, not a guess that it's an alt-screen app. */
export function paneIsAlternate(name: string, exec: TmuxExec = defaultExec): boolean {
  guard(name);
  const r = exec(['display-message', '-p', '-t', target(name), '#{alternate_on}']);
  return r.ok && r.stdout.trim() === '1';
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

/** `lines: null` omits -S entirely, which makes tmux capture only the
 *  currently-visible pane instead of walking back through scrollback --
 *  the right call for a full-screen TUI on the alternate screen (see
 *  paneIsAlternate above), where "scrollback" is a stack of that app's own
 *  historical repaints, not a history worth flattening into the backlog. */
export function capturePane(name: string, lines: number | null, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(lines === null
    ? ['capture-pane', '-p', '-t', target(name)]
    : ['capture-pane', '-p', '-S', `-${lines}`, '-t', target(name)]);
}

export function resizeWindow(name: string, cols: number, rows: number, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['resize-window', '-t', target(name), '-x', String(cols), '-y', String(rows)]);
}

/** pipe-pane's own semantics double as the start/stop toggle: called WITH a
 *  command, it starts copying the pane's output into that command's stdin
 *  (-O); called with none, it closes whatever pipe currently exists (tmux
 *  manual: "if no shell-command is given, the current pipe ... is closed").
 *  One function mirroring that toggle, rather than two, keeps the =name
 *  guard and argv construction in one place, matching this file's other
 *  functions. tmux also refuses to run two pipes on the same pane at once
 *  ("any existing pipe is closed before shell-command is executed"), so a
 *  second start is safe at the tmux level -- ipc.ts's attachTerminal still
 *  tracks its own state so a repeat call doesn't leak a second fifo/reader
 *  on top of it. */
export function pipePane(name: string, command: string | undefined, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return command === undefined
    ? exec(['pipe-pane', '-t', target(name)])
    : exec(['pipe-pane', '-O', '-t', target(name), command]);
}

export function panePid(name: string, exec: TmuxExec = defaultExec): number | null {
  guard(name);
  const r = exec(['list-panes', '-t', target(name), '-F', '#{pane_pid}']);
  if (!r.ok) return null;
  const pid = Number.parseInt(r.stdout.trim().split('\n')[0] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
