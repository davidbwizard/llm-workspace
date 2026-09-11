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
import {
  parsePgrep, parseTty, parseLsofCwd, parseEtime, parseRss, classifyHost, type LiveProcess,
} from './parse.ts';
import { parseProcessChainHop } from '../config.ts';
import type { Provider } from '../core/types.ts';

const execFileP = promisify(execFile);

/** The two provider CLIs discovery greps for -- the same 'claude' | 'codex'
 *  vocabulary Provider (core/types.ts) uses. `as const` gives this array's
 *  elements the literal type `'claude' | 'codex'`, identical to Provider,
 *  so each `bin` below is already assignable to inspectPid's `provider`
 *  parameter with no cast -- this IS which provider found the pid, not a
 *  lookalike string that happens to match. */
const PROVIDER_BINS = ['claude', 'codex'] as const;

/** One shell-out, injectable so tests can drive discovery deterministically
 *  (missing binary, a pid that exited mid-lookup, canned output) without
 *  touching real processes -- the same dependency-injection pattern
 *  src/config.ts's buildProcessChain already uses for its `hop` callback.
 *  Contract: must never reject -- fail soft to '' instead, exactly like
 *  src/cli.ts's synchronous safeExec, which defaultExec below mirrors.
 *  discoverLiveProcesses also wraps its own top-level await in try/catch,
 *  as defence in depth against an exec that breaks this contract. */
export type ExecFn = (bin: string, args: string[]) => Promise<string>;

async function defaultExec(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(bin, args, { encoding: 'utf8' });
    return stdout;
  } catch {
    return '';
  }
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
async function inspectPid(pid: number, provider: Provider, exec: ExecFn): Promise<InspectedPid> {
  const [ttyOut, cwdOut, statOut, walk] = await Promise.all([
    exec('ps', ['-o', 'tty=', '-p', String(pid)]),
    exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    exec('ps', ['-o', 'etime=,rss=', '-p', String(pid)]),
    walkProcessChain(pid, exec),
  ]);
  return {
    process: {
      pid,
      provider,
      tty: parseTty(ttyOut),
      cwd: parseLsofCwd(cwdOut),
      host: classifyHost(walk.chain),
      ageSeconds: parseEtime(statOut),
      rssBytes: parseRss(statOut),
    },
    ancestorPids: walk.pids.slice(1), // walk.pids[0] is pid itself, not an ancestor
  };
}

/** A matched pid (found by `pgrep -x <bin>` for either provider) is a
 *  session only if no OTHER matched pid is its ancestor -- a helper process
 *  a session spawned (a sandbox wrapper, an app-server, ...) still matches
 *  `pgrep -x codex`/`pgrep -x claude` by binary name, but reaches the real
 *  session through its own parent chain, however many non-matching
 *  processes (a shell, a REPL) sit in between. `matchedPids` is every pid
 *  pgrep found this sweep, across both providers -- checked as a flat set
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
 *  Matches every PROVIDER_BINS pid first (both providers, so the matched
 *  set filterToSessions checks ancestry against is complete before any pid
 *  is inspected), then inspects them all concurrently, then drops helper
 *  processes -- a session's own subprocesses that also happen to match
 *  `pgrep -x codex`/`pgrep -x claude` by binary name (see filterToSessions). */
export async function discoverLiveProcesses(exec: ExecFn = defaultExec): Promise<LiveProcess[]> {
  try {
    const matched = (await Promise.all(PROVIDER_BINS.map(async bin =>
      parsePgrep(await exec('pgrep', ['-x', bin])).map(pid => ({ pid, provider: bin }))))).flat();
    const matchedPids = new Set(matched.map(m => m.pid));

    const inspected = await Promise.all(matched.map(({ pid, provider }) => inspectPid(pid, provider, exec)));
    return filterToSessions(inspected, matchedPids);
  } catch {
    return [];
  }
}

let cache: LiveProcess[] = [];

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
 *  info, which is the honest tradeoff. */
export async function refreshLiveProcesses(exec: ExecFn = defaultExec): Promise<LiveProcess[]> {
  cache = await discoverLiveProcesses(exec);
  return cache;
}
