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

const execFileP = promisify(execFile);

/** The two provider CLIs discovery greps for -- the same 'claude' | 'codex'
 *  vocabulary the rest of the app uses for Provider, spelled out here as
 *  literal pgrep arguments rather than imported as a type. */
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

/** Walk the parent chain for classifyHost, one hop per call to exec(). The
 *  async twin of src/config.ts's buildProcessChain -- kept as its own,
 *  smaller copy here rather than changing that function's signature to
 *  async, since config.ts is out of scope for this change and its existing
 *  synchronous callers must not be disturbed. Reuses parseProcessChainHop,
 *  the actual line-parsing logic, unchanged. */
async function walkProcessChain(pid: number, exec: ExecFn, maxDepth = 12): Promise<string[]> {
  const chain: string[] = [];
  let cur: number | null = pid;
  let depth = 0;
  while (cur !== null && depth < maxDepth) {
    const step = parseProcessChainHop(await exec('ps', ['-o', 'ppid=,comm=', '-p', String(cur)]));
    if (!step) break;
    chain.push(basename(step.comm));
    if (step.ppid <= 1) break;
    cur = step.ppid;
    depth++;
  }
  return chain;
}

/** Inspect one pid, already known-live from pgrep. The four lookups (tty,
 *  cwd, age+memory, ancestry chain) are independent of one another, so they
 *  run concurrently rather than one after another. Each is individually
 *  fail-soft (exec's contract, see above) -- a pid whose ps/lsof calls all
 *  come back empty (e.g. it exited between pgrep and this call) still
 *  produces a LiveProcess, just with every derived field null/'unknown'
 *  rather than the pid disappearing. */
async function inspectPid(pid: number, exec: ExecFn): Promise<LiveProcess> {
  const [ttyOut, cwdOut, statOut, chain] = await Promise.all([
    exec('ps', ['-o', 'tty=', '-p', String(pid)]),
    exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    exec('ps', ['-o', 'etime=,rss=', '-p', String(pid)]),
    walkProcessChain(pid, exec),
  ]);
  return {
    pid,
    tty: parseTty(ttyOut),
    cwd: parseLsofCwd(cwdOut),
    host: classifyHost(chain),
    ageSeconds: parseEtime(statOut),
    rssBytes: parseRss(statOut),
  };
}

/** One full discovery sweep across both providers, run concurrently. Never
 *  throws: `exec` already fails soft per call, and any unexpected
 *  rejection (a bug, or an exec that breaks its own no-throw contract) is
 *  caught here too. Spec 7.1a: process discovery is enrichment only, over a
 *  session list built independently from transcripts -- a discovery
 *  failure must never be able to reach, let alone reduce, that list. */
export async function discoverLiveProcesses(exec: ExecFn = defaultExec): Promise<LiveProcess[]> {
  try {
    const byProvider = await Promise.all(PROVIDER_BINS.map(async bin => {
      const pids = parsePgrep(await exec('pgrep', ['-x', bin]));
      return Promise.all(pids.map(pid => inspectPid(pid, exec)));
    }));
    return byProvider.flat();
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
