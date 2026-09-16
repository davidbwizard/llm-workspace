import { execFileSync } from 'node:child_process';

export type TmuxResult = { ok: true; stdout: string } | { ok: false; error: string };
/** `input`, when given, is written to the command's stdin. Only load-buffer
 *  uses it, and it is the reason the message text never appears in an argv:
 *  argv is world-readable through `ps` for as long as the process lives. */
export type TmuxExec = (args: string[], input?: string) => TmuxResult;

/** Only names this app generates. Anchored, and deliberately excludes ':'
 *  and '.', which tmux's own target grammar uses for window.pane. */
export const TMUX_NAME = /^llmws-(claude|codex)-[A-Za-z0-9_-]{1,64}$/;

/** Buffer names this app may touch. A buffer name reaches tmux's own target
 *  grammar the same way a session name does, so it gets the same treatment:
 *  anchored, and only ever a name this code generated -- never anything
 *  derived from the message text.
 *
 *  The shape is `llmws-p<process pid>-<counter>`: two fixed literal
 *  segments around digits only. Deliberately tighter than a general
 *  alphanumeric class -- with no letters, no ':' or '.' (tmux's own
 *  window.pane target grammar) and no shell metacharacter able to appear at
 *  all, the only strings that pass are ones ipc.ts's own generator
 *  produces. */
export const TMUX_BUFFER = /^llmws-p[0-9]{1,10}-[0-9]{1,10}$/;

function defaultExec(args: string[], input?: string): TmuxResult {
  try {
    return {
      ok: true,
      stdout: execFileSync('tmux', args, {
        timeout: 5000, ...(input === undefined ? {} : { input }),
      }).toString(),
    };
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

function guardBuffer(buffer: string): void {
  if (!TMUX_BUFFER.test(buffer)) throw new Error('refusing a tmux buffer name this app did not generate');
}

export function hasSession(name: string, exec: TmuxExec = defaultExec): boolean {
  guard(name);
  return exec(['has-session', '-t', target(name)]).ok;
}

/** The pane's current size, straight from tmux. No production caller since
 *  the streaming bridge (ipc.ts) started attaching a real pty client --
 *  tmux follows that client's own size instead -- but kept here with its
 *  own direct coverage in tests/main/tmux.test.ts as a general-purpose
 *  primitive. A failed query or unparseable reply (pane gone, tmux
 *  unreachable) reads as null, never a guessed size. */
export function paneSize(name: string, exec: TmuxExec = defaultExec): { cols: number; rows: number } | null {
  guard(name);
  const r = exec(['display-message', '-p', '-t', target(name), '#{pane_width}x#{pane_height}']);
  if (!r.ok) return null;
  const m = /^(\d+)x(\d+)$/.exec(r.stdout.trim());
  if (!m) return null;
  return { cols: Number(m[1]), rows: Number(m[2]) };
}

/** Session-scoped `set-option` -- e.g. turning mouse mode on so a wheel
 *  scroll enters tmux copy-mode (tmux's own mouse support defaults off,
 *  verified against a real server: `tmux show-options -g mouse` -> `mouse
 *  off`). Always `-t <target>`, NEVER `-g`: `-g` sets the option GLOBALLY,
 *  for every tmux session on the machine, including ones this app has
 *  nothing to do with -- that would silently rewrite the user's own tmux
 *  config. `-t` scopes the change to exactly the one session `name`
 *  identifies, via the same target()/guard() every other function here
 *  uses, so this can only ever touch a session this app generates. */
export function setSessionOption(
  name: string, option: string, value: string, exec: TmuxExec = defaultExec,
): TmuxResult {
  guard(name);
  return exec(['set-option', '-t', target(name), option, value]);
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
 *  currently-visible pane instead of walking back through scrollback. A
 *  non-null `lines` is the -S backward count, not the total returned: -S -N
 *  adds N lines of scrollback ON TOP OF the whole visible pane, so e.g. -S
 *  -8 against a 24-line default pane returns 32 lines, not 8 (see
 *  PASTE_SETTLE_CAPTURE_LINES, ipc.ts, for where that number comes from).
 *  Used by sendKeysFor (ipc.ts) both as a freshness check immediately
 *  before sending a reply and, for a multi-line send, as the "before"
 *  snapshot its post-paste settle loop compares against -- 8 lines there,
 *  not 1, since a change confined to line 2 or 3 of a multi-line input box
 *  must still be visible to that comparison. */
export function capturePane(name: string, lines: number | null, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(lines === null
    ? ['capture-pane', '-p', '-t', target(name)]
    : ['capture-pane', '-p', '-S', `-${lines}`, '-t', target(name)]);
}

/** No production caller since the streaming bridge (ipc.ts) started
 *  attaching a real pty client -- tmux resizes the window itself to
 *  follow that client's own size, the same way it would for a real
 *  terminal. Kept here with its own direct coverage in
 *  tests/main/tmux.test.ts as a general-purpose primitive. */
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
 *  second start is safe at the tmux level either way. No production caller
 *  since the streaming bridge (ipc.ts) started attaching a real pty client
 *  instead of copying pane output out by hand -- kept here with its own
 *  direct coverage in tests/main/tmux.test.ts as a general-purpose
 *  primitive. */
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

/** Every currently running tmux session's name -- our own and anyone
 *  else's. Unlike every function above, there is no single name to guard()
 *  against here: this is a whole-server listing, not a target-PANE/
 *  target-SESSION command, so filtering against TMUX_NAME is the CALLER's
 *  job (adoptRunningSessions, src/main/sessions.ts) -- exactly the division
 *  guard() already draws everywhere else in this file (validate the name
 *  BEFORE it becomes a tmux target), just with no target here to validate.
 *  No running server at all (the common case on a machine that has never
 *  opened a terminal) reads as no sessions, not an error -- "nothing to
 *  adopt" needs no special case from the caller. */
export function listSessionNames(exec: TmuxExec = defaultExec): string[] {
  const r = exec(['list-sessions', '-F', '#{session_name}']);
  if (!r.ok) return [];
  return r.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

/** Reads `text` into a private tmux buffer from STDIN, so a multi-line
 *  message never appears in an argv. Paired with pasteBuffer below, which
 *  is what actually delivers it -- loading a buffer on its own sends
 *  nothing anywhere. */
export function loadBuffer(name: string, buffer: string, text: string, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  guardBuffer(buffer);
  return exec(['load-buffer', '-b', buffer, '-'], text);
}

/** Delivers a buffer to the pane as a BRACKETED paste (-p) and deletes the
 *  buffer as it goes (-d).
 *
 *  Bracketed paste is the whole mechanism: the foreground program is told
 *  "this is pasted text", so Claude Code takes the embedded newlines as
 *  part of one message instead of submitting on each of them the way it
 *  would for typed ones (measured 2026-09-15). It is delivery, not
 *  interpretation, which is why it is the one path where the outbound
 *  sanitiser's newline refusal can be relaxed.
 *
 *  That relaxation is safe for a narrower and more fragile reason than
 *  "a paste executes nothing", and it is worth being precise about: the
 *  text between the markers is inert ONLY while the message cannot write
 *  the END marker itself. It cannot, because sanitizeOutbound
 *  (src/main/outbound.ts) strips ESC and 8-bit CSI, the only two bytes that
 *  can begin one. Relax that stripping and a message containing
 *  ESC [ 2 0 1 ~ closes the paste early, and its remainder arrives as live
 *  keystrokes. See the "strips the escape bytes" test in
 *  tests/main/outbound.test.ts. */
export function pasteBuffer(name: string, buffer: string, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  guardBuffer(buffer);
  return exec(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target(name)]);
}

/** Drops a buffer this app loaded. Only needed when a paste FAILED -- a
 *  successful paste already deletes it via -d. Server-scoped, so unlike
 *  every other command here it takes no session target at all; the buffer
 *  name is the only thing reaching tmux's grammar, and it is still
 *  guarded. */
export function deleteBuffer(buffer: string, exec: TmuxExec = defaultExec): TmuxResult {
  guardBuffer(buffer);
  return exec(['delete-buffer', '-b', buffer]);
}
