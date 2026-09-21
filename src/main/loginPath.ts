// A GUI process on macOS inherits a minimal PATH -- roughly
// /usr/bin:/bin:/usr/sbin:/sbin -- not the one a shell builds from the
// user's profile. Everything this app shells out to by bare name that is
// NOT part of the base system (tmux, and the claude/codex CLIs discovery
// greps for) lives somewhere that PATH never mentions: /opt/homebrew/bin,
// an nvm version directory, ~/.local/bin. The app has only ever worked
// because it is always started from a terminal with `npm run dev`; opened
// from Finder, discovery still works (ps/lsof/pgrep ARE in the minimal
// PATH) and every Launch fails, which is a worse first impression than an
// app that says outright that tmux is missing.
//
// So: ask the login shell once, at startup, what PATH it builds, and make
// that the process's own PATH before anything spawns. Design:
// docs/superpowers/specs/2026-09-21-first-run-checks-design.md §2.
import { userInfo } from 'node:os';
import { execFileSoft } from '../discovery/live.ts';

/** The shell's output is framed between these two markers so a profile
 *  that prints its own banner to stdout (a greeting, a version notice, a
 *  prompt framework's chatter) cannot end up glued to the front of the
 *  first PATH entry. The design's §2 command is a bare
 *  `printf %s "$PATH"`; this is the same single printf of the same single
 *  variable, just delimited, and it is still the shell printing -- nothing
 *  here evaluates a word of what comes back. */
const BEGIN = '__LLMWS_PATH_BEGIN__';
const END = '__LLMWS_PATH_END__';

/** Printed, never eval'd: `$PATH` is expanded by the shell as printf's
 *  argument, so its contents reach us as data on stdout and are never
 *  parsed as shell words. */
const PROBE = `printf '\\n${BEGIN}%s${END}\\n' "$PATH"`;

/** A single entry longer than this is not a directory anyone has; it is a
 *  profile that went wrong. Dropped rather than passed on to execvp. */
const MAX_ENTRY_LENGTH = 1024;

/** PATH is searched linearly on every bare-name spawn, so an unbounded
 *  list is a real cost, not just a tidiness concern. A sane profile is
 *  under 30 entries. */
const MAX_ENTRIES = 256;

/** Which shell to ask. `$SHELL` first, because a user who overrode it
 *  meant it -- but a Finder-launched app is not guaranteed to have it:
 *  measured 2026-09-21, `launchctl getenv SHELL` is empty on this machine,
 *  and a process started with a deliberately minimal environment has no
 *  SHELL at all. `userInfo().shell` comes from the password database
 *  (getpwuid) with no subprocess of its own, so it answers in exactly the
 *  case $SHELL cannot. Both are checked for being an absolute path before
 *  they are used as an executable: $SHELL is inherited environment, which
 *  is not a trusted source.
 *
 *  `/bin/sh` last. It will not read a zsh profile, so it will usually
 *  resolve nothing useful -- but "ask a shell that exists" fails softer
 *  than spawning a path that does not. */
export function loginShell(
  env: NodeJS.ProcessEnv = process.env, info: () => { shell?: string | null } = userInfo,
): string {
  const fromEnv = env.SHELL;
  if (typeof fromEnv === 'string' && fromEnv.startsWith('/')) return fromEnv;
  let fromPasswd: string | null | undefined;
  // userInfo() throws on a uid with no passwd entry. That is not a reason
  // to fail startup; it is a reason to fall through to /bin/sh.
  try { fromPasswd = info().shell; } catch { fromPasswd = null; }
  if (typeof fromPasswd === 'string' && fromPasswd.startsWith('/')) return fromPasswd;
  return '/bin/sh';
}

/** Pulls the PATH out of the shell's stdout and validates it. Returns the
 *  accepted entries, or [] if the markers are missing (a shell that failed,
 *  timed out, or printed nothing -- execFileSoft hands all three back as
 *  '').
 *
 *  A profile is user-controlled input. Anything that is not plainly an
 *  absolute directory path is dropped rather than repaired: an empty entry
 *  (PATH's own spelling of "the current directory"), a relative one, and
 *  anything absurdly long. The first two are the ones that matter -- both
 *  make a bare-name spawn resolve against whatever directory the process
 *  happens to be in, which for a launched agent is one of the user's own
 *  project folders. */
export function parseLoginPath(stdout: string): string[] {
  const start = stdout.indexOf(BEGIN);
  if (start < 0) return [];
  const from = start + BEGIN.length;
  const stop = stdout.indexOf(END, from);
  if (stop < 0) return [];
  return dedupe(stdout.slice(from, stop).split(':').filter(isUsableEntry)).slice(0, MAX_ENTRIES);
}

function isUsableEntry(entry: string): boolean {
  return entry.startsWith('/') && entry.length <= MAX_ENTRY_LENGTH;
}

function dedupe(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries.filter(e => (seen.has(e) ? false : (seen.add(e), true)));
}

/** The PATH this process should run with: exactly what we already
 *  inherited, with the login shell's unseen directories APPENDED. Returns
 *  null when the shell named nothing we did not already have.
 *
 *  Purely additive, and both halves of that are deliberate.
 *
 *  Nothing is removed, because the inherited minimal PATH is exactly where
 *  ps, lsof, pgrep, osascript and open live -- everything discovery already
 *  works with today. A profile that clobbers PATH rather than appending to
 *  it (`export PATH=~/bin`) must not be able to take those away.
 *
 *  Nothing is reordered, because a directory that is ALREADY on PATH is
 *  already reachable, and moving it earlier can only change which of two
 *  same-named binaries wins. The inherited order is the one the process was
 *  given: under `npm run dev` that is npm's own, with node_modules/.bin
 *  deliberately first, and in a GUI launch it is the system directories.
 *  Putting a profile's entries in front of those would let a user-
 *  controlled file decide which `ps` or `open` this app runs, which is a
 *  trust boundary this has no reason to cross -- and it would silently
 *  invert npm's local-binary precedence for every dev run. Appending
 *  cannot: it only makes reachable what was not reachable at all, which is
 *  the entire problem being solved. */
export function mergePath(resolved: string[], inherited: string | undefined): string | null {
  const existing = dedupe((inherited ?? '').split(':').filter(isUsableEntry));
  const have = new Set(existing);
  const added = resolved.filter(e => !have.has(e));
  if (added.length === 0) return null;
  return [...existing, ...added].slice(0, MAX_ENTRIES).join(':');
}

export type LoginPathDeps = {
  /** Defaults to discovery's execFileSoft: 2s timeout, SIGKILL on expiry,
   *  '' on any failure. Reused rather than reimplemented so there is one
   *  bounded shell-out in this codebase, not two. */
  exec?: (bin: string, args: string[]) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  shell?: () => string;
};

/** Asks the login shell for its PATH and returns the merged result plus
 *  the directories it added, or null when the shell told us nothing we did
 *  not already have -- in which case the caller leaves the inherited PATH
 *  exactly as it was. That "already had" case is the normal one under
 *  `npm run dev`, where the process was started FROM the login shell.
 *
 *  -i so the interactive profile (.zshrc, .bashrc) runs: on a default
 *  macOS zsh that is where Homebrew's shellenv and every version manager
 *  put themselves, and a non-interactive shell would miss all of it. -l so
 *  the login profile runs too. -c so the shell runs this one command and
 *  exits rather than waiting on stdin. */
export async function resolveLoginPath(
  deps: LoginPathDeps = {},
): Promise<{ path: string; added: string[] } | null> {
  const exec = deps.exec ?? ((bin, args) => execFileSoft(bin, args));
  const env = deps.env ?? process.env;
  const shell = (deps.shell ?? (() => loginShell(env)))();
  const entries = parseLoginPath(await exec(shell, ['-ilc', PROBE]));
  if (entries.length === 0) return null;
  const merged = mergePath(entries, env.PATH);
  if (merged === null) return null;
  const had = new Set((env.PATH ?? '').split(':'));
  return { path: merged, added: entries.filter(e => !had.has(e)) };
}

/** The one in-flight (or finished) applyLoginPath call for this process.
 *  Module scope, not a parameter, because the thing it guards is a property
 *  of the PROCESS -- process.env.PATH has either been repaired or it has
 *  not -- and every later spawn reads that same single variable. */
let applied: Promise<ApplyResult> | null = null;

export type ApplyResult =
  | { status: 'applied'; path: string; added: string[] }
  | { status: 'unchanged' }
  | { status: 'failed'; error: string };

/** applyLoginPath, memoised. Startup calls this once; anything that needs
 *  the repaired PATH awaits whenLoginPathApplied() below rather than
 *  trusting that startup got there first. */
export function applyLoginPathOnce(deps: LoginPathDeps = {}): Promise<ApplyResult> {
  return applied ??= applyLoginPath(deps);
}

/** The PATH repair, as something to await -- the explicit form of a
 *  dependency that was previously only true because of the order of two
 *  statements in app.whenReady.
 *
 *  This matters more than it looks. A GUI launch hands this process a PATH
 *  with no tmux, claude or codex on it (see this file's header), so a probe
 *  that runs before the repair reports every dependency as MISSING on a
 *  machine where all three are installed -- and it reports it confidently,
 *  in a first-run screen whose entire job is to be believed. There is no
 *  failure visible at the call site; the answer is just wrong.
 *
 *  Throws rather than silently resolving when the repair was never started,
 *  because a caller that got here first has an ordering bug, and the honest
 *  moment to find that is in a test, not in a stranger's first launch. */
export function whenLoginPathApplied(): Promise<ApplyResult> {
  if (applied === null) {
    throw new Error(
      'the login shell PATH has not been resolved yet -- call applyLoginPathOnce() '
      + 'during startup before probing for any binary',
    );
  }
  return applied;
}

/** Drops the memo, so a test can exercise the not-yet-started case and the
 *  in-flight case independently. Nothing in the app calls this: one repair
 *  per process is the whole point. */
export function resetLoginPathOnce(): void {
  applied = null;
}

/** Sets process.env.PATH for the rest of this process's life, which is
 *  what makes every later spawn benefit without each one growing its own
 *  env-building code: execFileSync('tmux'), discovery's execFile calls,
 *  node-pty (attachTerminal spreads process.env into the pty's env), and
 *  the osascript/open calls in ipc.ts all read it. One assignment at
 *  startup, before any of them runs.
 *
 *  Returns what it did, for the caller's log line. Never throws: a startup
 *  step that can abort startup is not an improvement over a short PATH. */
export async function applyLoginPath(deps: LoginPathDeps = {}): Promise<ApplyResult> {
  try {
    const resolved = await resolveLoginPath(deps);
    if (resolved === null) return { status: 'unchanged' };
    (deps.env ?? process.env).PATH = resolved.path;
    return { status: 'applied', ...resolved };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
