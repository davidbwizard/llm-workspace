// Shared live-process discovery for both providers (claude, codex). Lifted
// out of src/cli.ts's private `liveClaudeProcesses` (Task 11), which only
// ever grepped for `claude` -- every Codex session went unmatched. Extended
// here to also grep for `codex`, and to report each process's age and
// memory (a follow-up to Phase 3: a session whose process is still alive
// and one whose transcript just hasn't been touched in weeks land in the
// same "idle" group today, and age/memory is what lets a person tell them
// apart -- e.g. deciding whether to kill a 9-day-old, 206 MB one).
//
// Every call here shells out to pgrep/ps/lsof. A full sweep against this
// machine's real process set (13 processes across both providers, ~107
// subprocess spawns once tty/cwd/age-mem/ancestry-chain lookups are all
// counted) measured ~500ms run synchronously -- an order of magnitude over
// what's safe on Electron's main thread, which also serves IPC. Run async
// and concurrently instead: the same sweep measured ~118ms wall clock, with
// the event loop confirmed still responsive throughout (a 20ms ticker kept
// firing during the sweep in the same measurement). src/main/index.ts
// refreshes a cache on an interval; buildFleetPayload (src/main/ipc.ts)
// reads whatever is cached rather than triggering a sweep itself, so
// building a fleet payload -- which can happen on every coalesced watcher
// push, roughly every 250ms -- never waits on a subprocess.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import {
  parseProcessList, parseTty, parseLsofCwd, parseLsofNames, parseEtime, parseRss, classifyHost,
  nodeHostedProvider, PROVIDER_BINS, type LiveProcess,
} from './parse.ts';
import { parseProcessChainHop, resolvePaths } from '../config.ts';
import {
  readLiveSessionFile, startTimeAgrees, type LiveSessionFile, type LiveSessionRead,
} from '../providers/claude/liveSession.ts';
import { isRolloutPath } from '../providers/codex/rolloutPath.ts';
import type { Provider } from '../core/types.ts';

const execFileP = promisify(execFile);

/** The executable name a JavaScript entry point's process actually carries:
 *  an npm-installed CLI has a `#!/usr/bin/env node` shebang, so the kernel
 *  runs node and `comm` is `node`, never the CLI's own name. Such a process
 *  is identified by its argv instead -- see nodeHostedProvider
 *  (src/discovery/parse.ts) for the rules and what they deliberately
 *  reject. */
const NODE_BIN = 'node';

/** One shell-out, injectable so tests can drive discovery deterministically
 *  (missing binary, a pid that exited mid-lookup, canned output) without
 *  touching real processes -- the same dependency-injection pattern
 *  src/config.ts's buildProcessChain already uses for its `hop` callback.
 *  Contract: must never reject -- fail soft to '' instead, exactly like
 *  src/cli.ts's synchronous safeExec, which defaultExec below mirrors.
 *  discoverLiveProcesses also wraps its own top-level await in try/catch,
 *  as defence in depth against an exec that breaks this contract. */
export type ExecFn = (bin: string, args: string[], opts?: ExecOpts) => Promise<string>;

/** `okExitCodes`: non-zero exit codes whose stdout is still whole and worth
 *  keeping. `lsof -p a,b` exits 1 when ANY listed pid has gone, yet prints
 *  every pid it did find -- without this, one process exiting mid-sweep
 *  would blank the answer for all the others. */
export interface ExecOpts { okExitCodes?: readonly number[] }

// B2 (whole-branch review, 2026-09-11): this used to call execFileP with no
// `timeout`, so one unresponsive command (e.g. lsof stuck on a stale network
// mount) hung forever instead of failing soft. That inverts
// refreshLiveProcesses' own documented promise that a failure costs "at
// most one interval" -- discoverLiveProcesses awaits every inspectPid via
// Promise.all, so a single stuck exec call freezes the entire sweep, and
// with it the open-sessions cache, permanently. killSession (main/ipc.ts)
// awaits refreshLiveProcesses before validating a pid, so the same hang
// also blocks session:kill forever. `killSignal: 'SIGKILL'` because a
// command stuck on I/O (the network-mount case above) may not respond to
// the default SIGTERM either. Exported (not just used internally) so
// main/ipc.ts's defaultHop can share the exact same bounded, fail-soft
// behaviour instead of duplicating it with its own un-timed execFileP call.
//
// Output is bounded by execFile's default maxBuffer (1 MiB): past it the
// command is killed and this resolves to '' like any other failure.
export async function execFileSoft(bin: string, args: string[], opts: ExecOpts = {}): Promise<string> {
  try {
    const { stdout } = await execFileP(bin, args, {
      encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
    });
    return stdout;
  } catch (err) {
    // Only a clean exit with a code the caller listed keeps its stdout. A
    // killed command (timeout) has a signal and no numeric code, and a
    // maxBuffer overflow a string code, so both still resolve to ''.
    const e = err as { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown };
    const ok = typeof e.code === 'number' && (opts.okExitCodes ?? []).includes(e.code)
      && e.signal == null && e.killed !== true && typeof e.stdout === 'string';
    return ok ? e.stdout as string : '';
  }
}

async function defaultExec(bin: string, args: string[], opts?: ExecOpts): Promise<string> {
  return execFileSoft(bin, args, opts);
}

/** Injectable pieces of the live session lookup, so tests never read the
 *  real ~/.claude/sessions and can pin the clock and capture warnings. */
export type DiscoveryDeps = {
  readLiveSession?: (pid: number) => LiveSessionRead;
  now?: () => number;
  warn?: (message: string) => void;
  /** The Codex rollouts folder open files must sit in; defaults to
   *  ~/.codex/sessions. Tests point it at a fixture's redacted home. */
  codexSessions?: string;
};

/** The production reader. Exported for Reattach's fresh re-read
 *  (src/main/ipc.ts), which must hit the same directory discovery does. */
export function readLiveSession(pid: number): LiveSessionRead {
  return readLiveSessionFile(pid, resolvePaths(homedir()).claudeLiveSessions);
}

/** Spec §3.6: a rejected file is logged once per pid and reason per app
 *  run (so format drift is visible without flooding the console every
 *  5-second sweep), and a missing directory once per app run in total. */
const warnedLiveSession = new Set<string>();
export function resetLiveSessionWarnings(): void {
  warnedLiveSession.clear();
}
function warnOnce(key: string, message: string, warn: (m: string) => void): void {
  if (warnedLiveSession.has(key)) return;
  warnedLiveSession.add(key);
  warn(message);
}

/** The file for `pid`, or null when it is missing, rejected, or fails the
 *  pid-reuse start-time check. Never throws. Never logs file contents. */
export function verifiedLiveSession(
  pid: number, ageSeconds: number | null | undefined, deps: DiscoveryDeps = {},
): LiveSessionFile | null {
  const warn = deps.warn ?? (m => console.warn(m));
  const read = (deps.readLiveSession ?? readLiveSession)(pid);
  if (!read.ok) {
    if (read.reason === 'missing_dir') {
      warnOnce('missing_dir', '[live-session] ~/.claude/sessions not found; falling back to cwd matching', warn);
    } else if (read.reason !== 'missing') {
      warnOnce(`${pid}:${read.reason}`, `[live-session] pid ${pid}: session file ignored (${read.reason})`, warn);
    }
    return null;
  }
  if (ageSeconds == null) {
    warnOnce(`${pid}:no_age`, `[live-session] pid ${pid}: session file ignored (process start time unknown)`, warn);
    return null;
  }
  if (!startTimeAgrees(read.file, ageSeconds, (deps.now ?? Date.now)())) {
    warnOnce(`${pid}:start`, `[live-session] pid ${pid}: session file ignored (start time does not match the process)`, warn);
    return null;
  }
  return read.file;
}

/** Result of walking one pid's parent chain: `chain` and `pids` are parallel
 *  arrays, self first (`chain[0]`/`pids[0]` describe `pid` itself, not an
 *  ancestor -- same convention classifyHost already documents for `chain`).
 *  `pids` is the ancestry-filtering follow-up (see filterToSessions below)
 *  riding along on the walk classifyHost already needed, rather than a
 *  second walker over the same processes. */
interface ProcessChainWalk {
  chain: string[];
  pids: number[];
}

/** Walk the parent chain for classifyHost (and, via `pids`, for
 *  filterToSessions), one hop per call to exec(). The async twin of
 *  src/config.ts's buildProcessChain -- kept as its own, smaller copy here
 *  rather than changing that function's signature to async, since config.ts
 *  is out of scope for this change and its existing synchronous callers
 *  must not be disturbed. Reuses parseProcessChainHop, the actual
 *  line-parsing logic, unchanged.
 *
 *  Fail-soft: if the very first hop can't be parsed (bad/missing `ps`
 *  output, e.g. the pid exited between pgrep and this call), both arrays
 *  come back empty. filterToSessions treats an empty `pids` as "no ancestor
 *  found in the matched set" -- i.e. keep the process -- which is
 *  deliberate: losing a real session because `ps` hiccuped is worse than
 *  showing one helper. */
async function walkProcessChain(pid: number, exec: ExecFn, maxDepth = 12): Promise<ProcessChainWalk> {
  const chain: string[] = [];
  const pids: number[] = [];
  let cur: number | null = pid;
  let depth = 0;
  while (cur !== null && depth < maxDepth) {
    const step = parseProcessChainHop(await exec('ps', ['-o', 'ppid=,comm=', '-p', String(cur)]));
    if (!step) break;
    chain.push(basename(step.comm));
    pids.push(cur);
    if (step.ppid <= 1) break;
    cur = step.ppid;
    depth++;
  }
  return { chain, pids };
}

/** One inspected pid, plus the ancestor pids its chain walk turned up (self
 *  excluded) -- filterToSessions' input. Kept separate from LiveProcess
 *  itself since ancestry is only needed transiently, to decide whether this
 *  pid survives filtering; it is not part of the public shape. */
interface InspectedPid {
  process: LiveProcess;
  ancestorPids: number[];
  /** True when this pid runs the codex binary but is plumbing rather than a
   *  session -- see isCodexPlumbing. */
  plumbing: boolean;
}

/** codex subcommands that are NOT an interactive session. Deliberately a
 *  short, measured list rather than "every subcommand": `codex resume` and
 *  `codex fork` DO start interactive sessions, so a blanket rule would drop
 *  real work. Each name here was observed running on this machine as a
 *  helper, never as something a person was talking to.
 *
 *  Why this exists at all, when the ancestry rule above already drops a
 *  session's own helpers: these run as SIBLINGS under a parent that is not
 *  itself a codex process -- the ChatGPT desktop app's code-mode host, or
 *  launchd for the daemon -- so no matched pid is any of their ancestors
 *  and the ancestry rule cannot see them. Measured 2026-09-26: of eleven
 *  codex processes outside Fleet's own tmux sessions, ONE was a session the
 *  person started. The rest were two app-server daemons, a pid-update loop
 *  and six ChatGPT-app helpers -- all listed as sessions, and all counted
 *  as rivals when the conversation view tried to decide which transcript
 *  belonged to a pane, which is how a real session's transcript came to be
 *  refused as ambiguous. */
const CODEX_PLUMBING = new Set(['app-server', 'sandbox', 'exec', 'exec-server', 'mcp', 'proxy']);

/** Whether a codex command line names one of those.
 *
 *  It looks for the name ANYWHERE among the arguments, not just in the
 *  first non-flag position. Measured against the real process: the ChatGPT
 *  app runs `codex -c features.code_mode_host=true app-server ...`, so a
 *  flag's value sits in front of the subcommand and a first-position rule
 *  misses it. That is not a hypothetical -- it is the exact process that
 *  survived the first version of this function.
 *
 *  Tokens containing `=` or `/` are skipped, which is what keeps a flag's
 *  value from being mistaken for a subcommand: `-c sandbox_mode=...`
 *  carries `=`, and a path like `-C /Users/.../sandbox` carries `/`.
 *
 *  Known limit, stated rather than hidden: a bare relative value that is
 *  exactly one of these names -- `codex -C sandbox` -- would read as
 *  plumbing and be dropped. Dropping a real session is the harmful
 *  direction, so it is worth knowing; it stays acceptable because Fleet
 *  always passes an absolute `-C`, and the alternative (tracking which
 *  flags take values) is a list that rots against a CLI shipping daily.
 *
 *  Fail-soft, like every other lookup in this file: an args string that is
 *  empty or unparseable reads as "not plumbing", so a pid whose `ps` call
 *  came back empty is KEPT, never dropped on suspicion. */
export function isCodexPlumbing(args: string): boolean {
  return args.trim().split(/\s+/).slice(1)
    .some(t => !t.startsWith('-') && !t.includes('=') && !t.includes('/') && CODEX_PLUMBING.has(t));
}

/** Inspect one pid, already known-live from pgrep for the given `provider`
 *  -- the ONE fact about this pid discovery already had before any of the
 *  four lookups below ran, so it is passed in rather than derived, and is
 *  never subject to their fail-soft behaviour. The four lookups (tty, cwd,
 *  age+memory, ancestry chain) are independent of one another, so they run
 *  concurrently rather than one after another. Each is individually
 *  fail-soft (exec's contract, see above) -- a pid whose ps/lsof calls all
 *  come back empty (e.g. it exited between pgrep and this call) still
 *  produces a LiveProcess, just with every derived field null/'unknown'
 *  (provider excepted) rather than the pid disappearing. */
async function inspectPid(pid: number, provider: Provider, exec: ExecFn, deps: DiscoveryDeps): Promise<InspectedPid> {
  const [ttyOut, cwdOut, statOut, walk, argsOut] = await Promise.all([
    exec('ps', ['-o', 'tty=', '-p', String(pid)]),
    exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    exec('ps', ['-o', 'etime=,rss=', '-p', String(pid)]),
    walkProcessChain(pid, exec),
    // Codex only: the claude CLI has no subcommand surface this rule is
    // about, and reaching into the other provider's command line would be
    // inventing a rule nothing measured.
    provider === 'codex' ? exec('ps', ['-o', 'args=', '-p', String(pid)]) : Promise.resolve(''),
  ]);
  const ageSeconds = parseEtime(statOut);
  const liveSession = provider === 'claude' ? verifiedLiveSession(pid, ageSeconds, deps) : null;
  return {
    process: {
      pid,
      provider,
      tty: parseTty(ttyOut),
      cwd: parseLsofCwd(cwdOut),
      host: classifyHost(walk.chain),
      ageSeconds,
      rssBytes: parseRss(statOut),
      ...(liveSession ? { liveSession } : {}),
    },
    ancestorPids: walk.pids.slice(1), // walk.pids[0] is pid itself, not an ancestor
    plumbing: provider === 'codex' && isCodexPlumbing(argsOut),
  };
}

/** Codex exact identity (the moved-folder fix, 2026-09-18): which rollout
 *  files each Codex process holds open. A Codex CLI keeps its root rollout
 *  open for its whole life, plus one per subagent thread, and the rollout
 *  names the session even when the process's cwd no longer matches the
 *  cwd the session recorded -- measured on a session whose folder was
 *  moved while it ran, which cwd matching could never find.
 *
 *  ONE `lsof` for every Codex pid together, never one per pid. Measured
 *  2026-09-18 on this machine: 4 Codex pids, ~6 KB of output, ~30 ms.
 *  Only names that pass isRolloutPath (absolute, normalised, inside the
 *  sessions folder, rollout-named) survive; everything else lsof lists is
 *  dropped. Enrichment only: any failure -- lsof missing, timed out,
 *  garbage, or an exec that rejects -- yields an empty map, and matching
 *  falls back to cwd exactly as before. Never throws. */
async function openRolloutsByPid(pids: number[], exec: ExecFn, codexRoot: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (pids.length === 0) return out;
  let listing: string;
  try {
    listing = await exec('lsof', ['-Fpn', '-p', pids.join(',')], { okExitCodes: [1] });
  } catch {
    return out;
  }
  for (const [pid, names] of parseLsofNames(listing, new Set(pids))) {
    const rollouts = [...new Set(names.filter(n => isRolloutPath(n, codexRoot)))];
    if (rollouts.length > 0) out.set(pid, rollouts);
  }
  return out;
}

/** A matched pid (either matching rule, either provider) is a session only
 *  if no OTHER matched pid is its ancestor -- a helper process a session
 *  spawned (a sandbox wrapper, an app-server, ...) runs the same binary, or
 *  the same node-hosted script, as the session that spawned it, but reaches
 *  that session through its own parent chain, however many non-matching
 *  processes (a shell, a REPL) sit in between. Node-hosted matches take
 *  part in this rule on both sides: as helpers to be dropped, and as
 *  ancestors that drop their own helpers. `matchedPids` is every pid
 *  matched this sweep, across both providers and both rules -- a flat set
 *  rather than per-provider, since a helper's ancestor is always the same
 *  provider's session in practice, and nothing about the rule requires
 *  assuming that.
 *
 *  Deliberately NOT filtering on tty, args, or parent name: those are
 *  version- and platform-specific and will rot. Ancestry within the
 *  matched set is the property that actually distinguishes a helper from a
 *  session -- e.g. it keeps a pid parented directly by ChatGPT.app with no
 *  tty at all, exactly as it should, since nothing else matched found in
 *  its chain.
 *
 *  Fail-soft: an `ancestorPids` of `[]` (walkProcessChain's own fail-soft
 *  result when its first hop can't be parsed) trivially satisfies "no
 *  ancestor is in the matched set", so a pid discovery couldn't get
 *  ancestry for is kept, not dropped. */
function filterToSessions(inspected: InspectedPid[], matchedPids: ReadonlySet<number>): LiveProcess[] {
  return inspected
    .filter(({ plumbing }) => !plumbing)
    .filter(({ ancestorPids }) => !ancestorPids.some(a => matchedPids.has(a)))
    .map(({ process }) => process);
}

/** One full discovery sweep across both providers, run concurrently. Never
 *  throws: `exec` already fails soft per call, and any unexpected
 *  rejection (a bug, or an exec that breaks its own no-throw contract) is
 *  caught here too. Spec 7.1a: process discovery is enrichment only, over a
 *  session list built independently from transcripts -- a discovery
 *  failure must never be able to reach, let alone reduce, that list.
 *
 *  Matches every provider pid first (both providers, so the matched set
 *  filterToSessions checks ancestry against is complete before any pid is
 *  inspected), then inspects them all concurrently, then drops helper
 *  processes -- a session's own subprocesses that also happen to run the
 *  same binary (see filterToSessions).
 *
 *  Two matching rules, because an npm-installed CLI is a JavaScript entry
 *  point and its process is therefore called `node`, not `claude`/`codex`
 *  (the bug the first outside user hit, 2026-09-22): the executable name is
 *  exactly a PROVIDER_BINS name, or it is `node` and nodeHostedProvider
 *  recognises the script in its argv. The argv listing that second rule
 *  needs is ONE `ps -axo pid=,args=` for the whole machine, issued
 *  concurrently with the executable-name listing so it costs no wall clock
 *  (measured 2026-09-22 on this machine: 26ms, the same as the comm
 *  listing, against a sweep of ~118ms; 167 KB of output against execFile's
 *  1 MiB maxBuffer, past which it fails soft to name-only matching).
 *
 *  ONE `ps` enumeration per field, filtered here, rather than
 *  `pgrep -x <bin>` per provider. pgrep is unusable for this: it does not
 *  report the calling process's own ancestors, so an app launched from
 *  inside an agent session could never discover that session -- and that is
 *  precisely the session someone is most likely to have launched it from.
 *  Measured 2026-09-16 on this machine: `pgrep -x claude` returned four
 *  pids from an unrelated process tree and three from inside one of them,
 *  the missing one being the session that started the app. `ps -axo` sees
 *  the same table regardless of who asks. */
export async function discoverLiveProcesses(exec: ExecFn = defaultExec, deps: DiscoveryDeps = {}): Promise<LiveProcess[]> {
  try {
    const [commList, argvList] = await Promise.all([
      exec('ps', ['-axo', 'pid=,comm=']),
      exec('ps', ['-axo', 'pid=,args=']),
    ]);
    // Same shape as the comm listing -- pid, then the rest of the line
    // verbatim -- so parseProcessList reads both; here the "comm" field is
    // the whole argv. Enrichment only: a failed or oversized argv listing is
    // an empty map, and matching falls back to the executable name alone,
    // exactly as it behaved before node-hosted CLIs were recognised.
    const argvByPid = new Map(parseProcessList(argvList).map(({ pid, comm }) => [pid, comm]));
    const matched = parseProcessList(commList).flatMap(({ pid, comm }) => {
      const name = basename(comm);
      const provider = PROVIDER_BINS.find(bin => bin === name)
        ?? (name === NODE_BIN ? nodeHostedProvider(argvByPid.get(pid) ?? '') : null);
      return provider ? [{ pid, provider }] : [];
    });
    const matchedPids = new Set(matched.map(m => m.pid));
    const codexPids = matched.filter(m => m.provider === 'codex').map(m => m.pid);

    const [inspected, rollouts] = await Promise.all([
      Promise.all(matched.map(({ pid, provider }) => inspectPid(pid, provider, exec, deps))),
      openRolloutsByPid(codexPids, exec, deps.codexSessions ?? resolvePaths(homedir()).codexSessions),
    ]);
    const withRollouts = inspected.map(i => {
      const openRollouts = rollouts.get(i.process.pid);
      return openRollouts ? { ...i, process: { ...i.process, openRollouts } } : i;
    });
    return filterToSessions(withRollouts, matchedPids);
  } catch {
    return [];
  }
}

let cache: LiveProcess[] = [];

/** B2: guards against overlapping sweeps. main/index.ts's discoveryTimer
 *  calls refreshLiveProcesses every 5 seconds with no regard for whether
 *  the previous sweep is still running; killSession (main/ipc.ts) can also
 *  trigger one at any moment. Without this, a sweep slow enough to still be
 *  running at the next tick (formerly: hung forever, see execFileSoft above)
 *  would have a fresh, fully concurrent sweep -- another ~13 processes'
 *  worth of pgrep/ps/lsof calls -- stacked on top of it every single tick,
 *  indefinitely. A caller that arrives while a sweep is already in flight
 *  joins that SAME sweep instead of starting a redundant one, and gets its
 *  real result once it settles -- it is not skipped or given stale data. */
let inFlightSweep: Promise<LiveProcess[]> | null = null;

/** The most recently completed sweep's result -- empty until
 *  refreshLiveProcesses has run at least once, or if it has only ever
 *  found nothing. buildFleetPayload reads this directly rather than
 *  awaiting a sweep, so it never blocks on a subprocess. */
export function getCachedLiveProcesses(): LiveProcess[] {
  return cache;
}

/** Runs a sweep and replaces the cache with its result -- including an
 *  empty result. Deliberately not "keep the last good result on failure":
 *  discoverLiveProcesses's own empty return is indistinguishable between
 *  "pgrep is missing" and "the user genuinely has zero live sessions right
 *  now" (both look like no pids found), so treating empty as "probably a
 *  blip, keep showing the old data" would leave a closed session's host
 *  label stuck on-screen forever. A straight overwrite means a real
 *  failure costs at most one 5-second-interval's worth of stale host
 *  info, which is the honest tradeoff.
 *
 *  See inFlightSweep above for the overlap guard: a call that arrives while
 *  a sweep is already running returns that same in-flight promise rather
 *  than starting a second, concurrent one. */
export async function refreshLiveProcesses(exec: ExecFn = defaultExec, deps: DiscoveryDeps = {}): Promise<LiveProcess[]> {
  if (inFlightSweep) return inFlightSweep;
  const sweep = discoverLiveProcesses(exec, deps).then(result => {
    cache = result;
    return result;
  });
  inFlightSweep = sweep;
  try {
    return await sweep;
  } finally {
    if (inFlightSweep === sweep) inFlightSweep = null;
  }
}
