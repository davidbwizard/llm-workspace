import { basename, isAbsolute } from 'node:path';
import type { Provider } from '../core/types.ts';
import type { LiveSessionFile } from '../providers/claude/liveSession.ts';

export type HostApp = 'iterm2' | 'terminal' | 'vscode' | 'claude-app' | 'codex-app' | 'unknown';

export interface LiveProcess {
  pid: number;
  /** Which provider's CLI this is -- known with certainty at discovery
   *  time, from whichever rule matched this pid in the process listing
   *  (spec §7.1a), independent of any transcript match. Two rules, both in
   *  src/discovery/live.ts: the executable name is exactly one of
   *  PROVIDER_BINS, or it is `node` and nodeHostedProvider (below)
   *  recognises the script it is running. Not nullable and not optional:
   *  neither rule can match without naming exactly one provider, so there
   *  is no code path that discovers a pid without also knowing which
   *  provider it belongs to. */
  provider: Provider;
  tty: string | null;
  cwd: string | null;
  host: HostApp;
  /** Seconds the process has been running (`ps -o etime=`). Optional, not
   *  `| undefined`-free, so every LiveProcess fixture already in the
   *  codebase (match.ts's and cli.ts's tests predate this field) keeps
   *  typechecking without being rewritten -- src/discovery/live.ts, the
   *  only real producer, always sets it, to a number or null, never
   *  omits it. */
  ageSeconds?: number | null;
  /** Resident set size in bytes (`ps -o rss=`, reported in 1024-byte
   *  blocks on macOS/BSD `ps` and normalized to bytes here). Same
   *  optionality rationale as ageSeconds. */
  rssBytes?: number | null;
  /** Exact identity from Claude Code's own ~/.claude/sessions/<pid>.json
   *  (src/providers/claude/liveSession.ts). Present only when the file was
   *  valid AND its start time agreed with this process's; omitted, never
   *  null, otherwise -- so every fixture that predates it, every Codex
   *  process, and every rejected file look identical to before. */
  liveSession?: LiveSessionFile;
  /** Codex only: the rollout files this process holds open (one `lsof` per
   *  sweep, src/discovery/live.ts), each already checked to be an absolute,
   *  normalised path inside ~/.codex/sessions with a rollout name. Root and
   *  subagent threads alike -- telling them apart is the index's job
   *  (src/fleet/state.ts's openSessionsLive). Omitted, never empty, when
   *  there are none or the lookup failed, for the same reason as
   *  liveSession. */
  openRollouts?: string[];
}

/** Parse `ps -axo pid=,comm=` output: one process per line, pid first,
 *  then the executable as `ps` reports it -- sometimes a bare name
 *  (`claude`), sometimes a full path
 *  (`/Applications/ChatGPT.app/Contents/Resources/codex`). A path can
 *  contain spaces, so only the FIRST field is read as the pid and
 *  everything after it is the command verbatim; the caller takes the
 *  basename.
 *
 *  This replaced `pgrep -x <bin>`, which cannot be used for discovery:
 *  pgrep does not report the calling process's own ancestors, so an app
 *  launched FROM an agent session could never see that session -- the one
 *  session a person is most likely to have launched it from. Measured
 *  2026-09-16: the same `pgrep -x claude` returned four pids from an
 *  unrelated process tree and three from inside one of them. Enumerating
 *  with `ps` and filtering here is caller-independent. */
export function parseProcessList(out: string): Array<{ pid: number; comm: string }> {
  const rows: Array<{ pid: number; comm: string }> = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), comm: m[2]! });
  }
  return rows;
}

/** The two provider CLIs discovery looks for -- the same 'claude' | 'codex'
 *  vocabulary Provider (core/types.ts) uses. `as const` gives this array's
 *  elements the literal type `'claude' | 'codex'`, identical to Provider,
 *  so a match is already assignable wherever a Provider is wanted with no
 *  cast: this IS which provider found the pid, not a lookalike string that
 *  happens to match. */
export const PROVIDER_BINS = ['claude', 'codex'] as const;

/** Node flags that mean there is no script file at all -- the next argv
 *  entry is source code (`-e`/`--eval`/`-p`/`--print`) or the whole run is a
 *  syntax check (`-c`/`--check`). Seeing one abandons the whole process
 *  rather than reading the code, or the checked file, as a path to match. */
const NODE_NO_SCRIPT_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '--check']);

/** The npm package directories the two CLIs ship in, matched as exact scope
 *  AND name. `@oai/cua-repl` (ChatGPT.app bundles its own node and runs that
 *  under it, seen on the dev machine 2026-09-22) is why neither the scope
 *  alone nor a substring of the package name is enough. */
const PROVIDER_PACKAGES: ReadonlyArray<readonly [Provider, string]> = [
  ['claude', '/node_modules/@anthropic-ai/claude-code/'],
  ['codex', '/node_modules/@openai/codex/'],
];

/** Which provider, if any, a `node` process is hosting, from its full argv
 *  (`ps -axo pid=,args=`). Null for every other Node process.
 *
 *  Why this exists: an npm-installed provider CLI is a JavaScript entry
 *  point with a `#!/usr/bin/env node` shebang, so the kernel runs NODE and
 *  the process's `comm` is `node`. Matching the executable name alone --
 *  all discovery did until 2026-09-22 -- found a Homebrew-cask install and
 *  never an npm one. The first outside user had npm-installed Codex: his
 *  sessions worked while the app stayed open, then could not be typed into
 *  after a restart, because the pid->tmux map is rebuilt from tmux on
 *  restart and discovery had no matching process to meet it.
 *
 *  A false positive is worse than a miss here: an unrelated Node process
 *  shown as a live agent session is one the app would offer to type into.
 *  So the evidence required is the SCRIPT PATH, and it must be either
 *
 *    - an absolute path whose file name is exactly a PROVIDER_BINS name --
 *      what an npm bin entry is, wherever the prefix puts it (nvm, volta,
 *      pnpm, bun and Homebrew's npm prefix all differ, and only some have a
 *      `/bin/` segment, so the prefix itself is not evidence); or
 *    - an absolute path inside one of PROVIDER_PACKAGES, for the package
 *      entry point run directly rather than through its bin entry.
 *
 *  Deliberately rejected, each trading reach for precision:
 *   - a RELATIVE script path (`node ./claude`): it is relative to that
 *     process's cwd, not ours, so it cannot be resolved from a listing --
 *     and an installed CLI's path is always absolute.
 *   - an EXTENSION on an otherwise matching name (`claude.js`): a project
 *     file called that is far likelier than an executable named exactly
 *     `claude`, and npm bin entries carry no extension.
 *   - RESOLVING the path on disk (readlink, then the package.json `name`):
 *     the strongest evidence available, but it is filesystem work per
 *     candidate on a sweep that runs every 5 seconds, and this rule is
 *     already exactly as strong as the executable-name rule beside it. It
 *     is the upgrade path if a false positive is ever reported.
 *   - a flag that takes a separate value (`node -r foo /usr/local/bin/claude`
 *     reads `foo` as the script and so matches nothing). Fail-closed: a
 *     missed session, never a fabricated one.
 *
 *  A path containing spaces cannot be recovered from `ps` output either, and
 *  fails closed the same way. */
export function nodeHostedProvider(args: string): Provider | null {
  let script: string | null = null;
  for (const token of args.trim().split(/\s+/).slice(1)) {
    if (token.startsWith('-')) {
      // `--input-type=module` and friends carry their value inline; only the
      // flag name decides.
      if (NODE_NO_SCRIPT_FLAGS.has(token.split('=')[0]!)) return null;
      continue;
    }
    script = token;
    break;
  }
  if (script === null || !isAbsolute(script)) return null;
  const scriptPath = script;
  const pkg = PROVIDER_PACKAGES.find(([, dir]) => scriptPath.includes(dir));
  return pkg ? pkg[0] : PROVIDER_BINS.find(bin => bin === basename(scriptPath)) ?? null;
}

/** Parse `ps -o tty= -p <pid>`. `??` means no controlling terminal. */
export function parseTty(out: string): string | null {
  const t = out.trim();
  return !t || t === '??' || t === '?' ? null : t;
}

/** Parse `lsof -a -p <pid> -d cwd -Fn` — the cwd is the `n`-prefixed line. */
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1).trim() || null;
  }
  return null;
}

/** Parse `lsof -Fpn -p <pid,pid,...>`: a `p<pid>` line starts each
 *  process, and every `n<name>` line after it is one of that process's
 *  open files. Every other line -- the `f<fd>` line lsof always adds before
 *  each name, a warning, garbage -- is skipped. Names before any `p` line,
 *  or under a pid not in `pids`, are dropped. Pids with no names are left
 *  out. */
export function parseLsofNames(out: string, pids: ReadonlySet<number>): Map<number, string[]> {
  const byPid = new Map<number, string[]>();
  let current: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const pid = /^p(\d+)$/.test(line) ? Number(line.slice(1)) : NaN;
      current = pids.has(pid) ? pid : null;
    } else if (line.startsWith('n') && current !== null && line.length > 1) {
      const names = byPid.get(current);
      if (names) names.push(line.slice(1));
      else byPid.set(current, [line.slice(1)]);
    }
  }
  return byPid;
}

/** Parse the elapsed-time field of `ps -o etime=,rss= -p <pid>` -- the first
 *  whitespace-separated token. Its format depends on how long the process
 *  has run: `MM:SS`, `HH:MM:SS`, or `DD-HH:MM:SS`. Returns seconds, or null
 *  for missing or unrecognized input (e.g. the process exited between
 *  pgrep and this call, leaving no output at all). */
export function parseEtime(out: string): number | null {
  const field = out.trim().split(/\s+/)[0];
  if (!field) return null;
  const dash = field.indexOf('-');
  const days = dash >= 0 ? Number(field.slice(0, dash)) : 0;
  const clock = (dash >= 0 ? field.slice(dash + 1) : field).split(':');
  if (clock.length !== 2 && clock.length !== 3) return null;
  const nums = clock.map(Number);
  if (!Number.isFinite(days) || nums.some(n => !Number.isFinite(n))) return null;
  const [hours, minutes, seconds] = nums.length === 3 ? nums : [0, nums[0]!, nums[1]!];
  return ((days * 24 + hours!) * 60 + minutes!) * 60 + seconds!;
}

/** Parse the rss field of `ps -o etime=,rss= -p <pid>` -- the second
 *  whitespace-separated token, in 1024-byte blocks (`ps`'s default unit on
 *  macOS/BSD) -- normalized to bytes here so a UI consumes a plain byte
 *  count, not a unit-dependent one. Returns null for missing or
 *  non-numeric input. */
export function parseRss(out: string): number | null {
  const field = out.trim().split(/\s+/)[1];
  if (!field) return null;
  const kb = Number(field);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** Map a process ancestry chain to its terminal host. Spec §7.3 — this
 *  decides which jump action is offered, and VS Code deliberately gets a
 *  weaker one because a specific tab cannot be targeted.
 *
 *  `chain[0]` is the process being classified (the `claude`/`codex` CLI
 *  itself), not an ancestor — only entries after it say what spawned it.
 *  Excluded here: without this, a bare `claude` at index 0 collides with
 *  the claude-app check below and every unmatched chain misclassifies as
 *  claude-app instead of falling through to unknown. */
export function classifyHost(chain: string[]): HostApp {
  const names = chain.slice(1).map(n => n.toLowerCase());
  if (names.some(n => n.includes('iterm'))) return 'iterm2';
  if (names.some(n => n === 'code' || n.includes('code helper'))) return 'vscode';
  if (names.some(n => n === 'terminal')) return 'terminal';
  if (names.some(n => n === 'claude')) return 'claude-app';
  if (names.some(n => n.includes('chatgpt') || n.includes('codex'))) return 'codex-app';
  return 'unknown';
}
