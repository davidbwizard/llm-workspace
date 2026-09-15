import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  discoverLiveProcesses, execFileSoft, resetLiveSessionWarnings, type ExecFn,
} from '../../src/discovery/live.ts';
import type { LiveSessionFile, LiveSessionRead } from '../../src/providers/claude/liveSession.ts';

// A canned exec: keys are "bin arg1 arg2 ...", exactly how discoverLiveProcesses
// invokes exec() -- so a test only needs to name the calls it cares about.
// Anything not listed resolves to '', matching the real defaultExec's own
// fail-soft behaviour for a missing binary or an exited pid.
function fakeExec(responses: Record<string, string>): ExecFn {
  return async (bin, args) => responses[[bin, ...args].join(' ')] ?? '';
}

describe('discoverLiveProcesses', () => {
  it('finds processes for both providers concurrently and reports pid/provider/tty/cwd/host/age/memory', async () => {
    const exec = fakeExec({
      'pgrep -x claude': '100\n',
      'pgrep -x codex': '200\n',
      'ps -o tty= -p 100': 'ttys001\n',
      'lsof -a -p 100 -d cwd -Fn': 'p100\nfcwd\nn/repo/a\n',
      'ps -o etime=,rss= -p 100': '05:23  1234\n',
      'ps -o ppid=,comm= -p 100': '50 claude\n',
      'ps -o ppid=,comm= -p 50': '1 iTerm2\n',
      'ps -o tty= -p 200': 'ttys002\n',
      'lsof -a -p 200 -d cwd -Fn': 'p200\nfcwd\nn/repo/b\n',
      'ps -o etime=,rss= -p 200': '09-14:02:34  654321\n',
      'ps -o ppid=,comm= -p 200': '1 codex\n',
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs).toHaveLength(2);
    const byPid = new Map(procs.map(p => [p.pid, p]));

    // provider comes from WHICH pgrep found the pid (100 from 'pgrep -x
    // claude' above, 200 from 'pgrep -x codex'), not from any per-pid
    // lookup -- it is known before any of the other fields are, and
    // unlike them is never subject to a ps/lsof call failing soft.
    expect(byPid.get(100)).toEqual({
      pid: 100, provider: 'claude', tty: 'ttys001', cwd: '/repo/a', host: 'iterm2',
      ageSeconds: 5 * 60 + 23, rssBytes: 1234 * 1024,
    });
    expect(byPid.get(200)).toEqual({
      pid: 200, provider: 'codex', tty: 'ttys002', cwd: '/repo/b', host: 'unknown',
      ageSeconds: ((9 * 24 + 14) * 60 + 2) * 60 + 34, rssBytes: 654321 * 1024,
    });
  });

  it('returns an empty list when no process matches either provider', async () => {
    const exec = fakeExec({});
    await expect(discoverLiveProcesses(exec)).resolves.toEqual([]);
  });

  // Spec 7.1a follow-up: process discovery is enrichment over a session
  // list built independently from transcripts, so a discovery failure must
  // never be able to reach that list. These three pin fail-soft at
  // increasing levels of severity.
  describe('fails soft', () => {
    it('resolves to an empty list when pgrep is unavailable (the real ENOENT path: exec fails soft to empty output)', async () => {
      const exec: ExecFn = async () => '';
      await expect(discoverLiveProcesses(exec)).resolves.toEqual([]);
    });

    it('still reports a pid pgrep found even when every per-pid lookup for it comes back empty', async () => {
      const exec: ExecFn = async (bin, args) =>
        bin === 'pgrep' && args[1] === 'claude' ? '100\n' : '';
      const procs = await discoverLiveProcesses(exec);
      expect(procs).toEqual([
        { pid: 100, provider: 'claude', tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null },
      ]);
    });

    it('never rejects even if an injected exec violates its own no-throw contract', async () => {
      const exec: ExecFn = async () => { throw new Error('boom'); };
      await expect(discoverLiveProcesses(exec)).resolves.toEqual([]);
    });
  });

  it('never interpolates the pid into a shell string -- each ps/lsof call receives it as its own argv entry', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'pgrep') return '42\n';
      return '';
    };
    await discoverLiveProcesses(exec);
    for (const call of calls) {
      if (call[0] === 'pgrep') continue;
      // The pid appears as its own array element (String(42) === '42'),
      // never concatenated into a combined string like '-p 42' or embedded
      // inside another argument.
      expect(call).toContain('42');
      expect(call.some(a => a !== '42' && a.includes('42'))).toBe(false);
    }
  });
});

// A matched pid (pgrep -x claude/codex found it) is a session only if no
// OTHER matched pid is its ancestor -- a session's own helper subprocesses
// (a sandbox permission wrapper, an app-server) still match `pgrep -x
// codex` by binary name, but are reachable from the real session through
// their own parent chain. These fixtures mirror one real machine's actual
// process tree that motivated the fix:
//
//   iTerm2 -> zsh(20133) -> codex(85962)      <- the real session
//                             node_repl(86022)  <- unmatched (not "codex")
//                               codex(56549)    <- helper (permission wrapper)
//                               codex(56550)    <- helper
//                               codex(56553)    <- helper (app-server)
//   ChatGPT.app -> codex(30651), no tty         <- a second, real session
describe('ancestry filtering (session vs. helper subprocess)', () => {
  it('drops a matched pid descended from another matched pid through a non-matching intermediate (grandchild)', async () => {
    const exec = fakeExec({
      'pgrep -x codex': '85962\n56549\n',
      'ps -o ppid=,comm= -p 85962': '20133 codex\n', // 85962's own ppid/comm
      'ps -o ppid=,comm= -p 20133': '1 zsh\n',
      // 56549's parent is 86022 (node_repl) -- unmatched, not "codex" --
      // and 86022's parent is 85962, itself a matched pid.
      'ps -o ppid=,comm= -p 56549': '86022 codex\n',
      'ps -o ppid=,comm= -p 86022': '85962 node_repl\n',
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid)).toEqual([85962]);
  });

  it('keeps a matched pid whose parent chain contains no other matched pid', async () => {
    const exec = fakeExec({
      'pgrep -x codex': '85962\n',
      'ps -o ppid=,comm= -p 85962': '20133 codex\n',
      'ps -o ppid=,comm= -p 20133': '1 zsh\n', // zsh's own pid never appears in pgrep's matched set
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid)).toEqual([85962]);
  });

  it('keeps a matched pid with no tty and no matched ancestor, parented directly by an unmatched app process', async () => {
    // Pins the ChatGPT-desktop-app case explicitly: no tty, and its only
    // parent is an app process that never matched pgrep -x codex -- the
    // rule must keep it, not treat "no tty" as a signal to drop.
    const exec = fakeExec({
      'pgrep -x codex': '30651\n',
      'ps -o tty= -p 30651': '??\n',
      'ps -o ppid=,comm= -p 30651': '412 codex\n',
      'ps -o ppid=,comm= -p 412': '1 ChatGPT\n',
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({ pid: 30651, tty: null, host: 'codex-app' });
  });

  it('keeps a matched pid rather than dropping it when its ancestry walk cannot be parsed', async () => {
    // pid 2's ancestry call returns output walkProcessChain's first hop
    // can't parse (indistinguishable from ps failing outright, or the pid
    // having exited mid-lookup) -- so its ancestry is simply unknown. Fail
    // soft means unknown must resolve to "no known matched ancestor" (kept),
    // never to "looks suspicious, drop it".
    const exec = fakeExec({
      'pgrep -x codex': '1\n2\n',
      'ps -o ppid=,comm= -p 1': '999 codex\n',
      'ps -o ppid=,comm= -p 2': 'not a valid ppid/comm line\n',
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('the real-machine tree: drops all three codex helpers, keeps the real session and the ChatGPT-app session', async () => {
    const exec = fakeExec({
      'pgrep -x codex': '85962\n56549\n56550\n56553\n30651\n',
      'ps -o ppid=,comm= -p 85962': '20133 codex\n',
      'ps -o ppid=,comm= -p 20133': '1 zsh\n',
      'ps -o ppid=,comm= -p 56549': '86022 codex\n',
      'ps -o ppid=,comm= -p 56550': '86022 codex\n',
      'ps -o ppid=,comm= -p 56553': '86022 codex\n',
      'ps -o ppid=,comm= -p 86022': '85962 node_repl\n',
      'ps -o tty= -p 30651': '??\n',
      'ps -o ppid=,comm= -p 30651': '412 codex\n',
      'ps -o ppid=,comm= -p 412': '1 ChatGPT\n',
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid).sort((a, b) => a - b)).toEqual([85962, 30651].sort((a, b) => a - b));
  });
});

// The module-scope cache (getCachedLiveProcesses/refreshLiveProcesses) is
// reset between these tests via vi.resetModules() + a fresh dynamic import,
// since it is shared, mutable state across the whole test file otherwise.
describe('process cache', () => {
  it('is empty before any refresh has run', async () => {
    vi.resetModules();
    const mod = await import('../../src/discovery/live.ts');
    expect(mod.getCachedLiveProcesses()).toEqual([]);
  });

  it('refreshLiveProcesses populates the cache with the sweep result, and returns it too', async () => {
    vi.resetModules();
    const mod: typeof import('../../src/discovery/live.ts') = await import('../../src/discovery/live.ts');
    const exec = async (bin: string, args: string[]) =>
      bin === 'pgrep' && args[1] === 'claude' ? '100\n' : '';

    const result = await mod.refreshLiveProcesses(exec);
    const expected = [
      { pid: 100, provider: 'claude', tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null },
    ];
    expect(result).toEqual(expected);
    expect(mod.getCachedLiveProcesses()).toEqual(expected);
  });

  it('a later refresh replaces the cache rather than merging into it', async () => {
    vi.resetModules();
    const mod = await import('../../src/discovery/live.ts');
    await mod.refreshLiveProcesses(async (bin: string, args: string[]) =>
      bin === 'pgrep' && args[1] === 'claude' ? '100\n' : '');
    expect(mod.getCachedLiveProcesses()).toHaveLength(1);

    await mod.refreshLiveProcesses(async () => ''); // nothing found this time
    expect(mod.getCachedLiveProcesses()).toEqual([]);
  });
});

// B2 (whole-branch review, 2026-09-11): defaultExec (this module) and
// defaultHop (main/ipc.ts) both used to call execFileP with no `timeout`,
// so one unresponsive command (e.g. lsof stuck on a stale network mount)
// hung forever instead of failing soft -- freezing the open-sessions cache
// permanently and, via killSession's own pre-signal refresh, session:kill
// too. execFileSoft is the shared fix both call sites now use; proven here
// with a real subprocess ('sleep 5', which would hang the whole test for 5s
// with no timeout) rather than a mocked exec, since the mocked ExecFn tests
// above never exercise the real execFileP call this bug lived in.
describe('execFileSoft', () => {
  it('fails soft (resolves to \'\') on a real command that outlives its timeout, rather than hanging until it exits', async () => {
    const start = Date.now();
    const out = await execFileSoft('sleep', ['5']);
    const elapsedMs = Date.now() - start;
    expect(out).toBe('');
    // The bug this proves the absence of: no timeout meant this would have
    // taken ~5000ms (however long the subprocess itself ran). Comfortably
    // under that, and under the 5s discovery-sweep interval too, so a hung
    // command can never cost more than "the next sweep is a bit late".
    expect(elapsedMs).toBeLessThan(4000);
  }, 8000);

  it('still fails soft on a plain command failure (unaffected by adding the timeout option)', async () => {
    await expect(execFileSoft('a-binary-that-does-not-exist-anywhere', [])).resolves.toBe('');
  });
});

// B2: pushAfterDiscoverySweep (main/index.ts) fires every 5 seconds with no
// regard for whether the previous sweep already finished, and killSession
// can trigger a sweep at any moment too. Before this fix, a sweep stuck on
// one hung exec call meant a fresh, fully concurrent sweep -- another
// ~13 processes' worth of pgrep/ps/lsof calls -- stacked on top of it every
// single tick, forever (and, since nothing timed out either, no sweep in
// that pile ever finished). These prove the in-flight guard: a caller that
// arrives while a sweep is already running joins that SAME sweep instead of
// starting a new one, is not left hanging once it resolves, and a later
// caller (after the in-flight one has cleared) gets a genuinely fresh sweep.
describe('refreshLiveProcesses — in-flight sweep guard', () => {
  it('does not start a second sweep while one is still pending, and does not accumulate hung calls', async () => {
    vi.resetModules();
    const mod = await import('../../src/discovery/live.ts');

    let pgrepCalls = 0;
    const resolvers: Array<(v: string) => void> = [];
    const hangingExec: ExecFn = (bin) => {
      if (bin !== 'pgrep') return Promise.resolve('');
      pgrepCalls++;
      return new Promise<string>(resolve => resolvers.push(resolve));
    };

    const first = mod.refreshLiveProcesses(hangingExec);
    // Let the synchronous/microtask portion of the first sweep run --
    // discoverLiveProcesses fires both providers' pgrep calls before it
    // awaits anything else.
    await new Promise(resolve => setImmediate(resolve));
    const callsWhileFirstPending = pgrepCalls;
    expect(callsWhileFirstPending).toBeGreaterThan(0);

    const second = mod.refreshLiveProcesses(hangingExec); // arrives while first is still hung
    await new Promise(resolve => setImmediate(resolve));
    expect(pgrepCalls).toBe(callsWhileFirstPending); // no new sweep -- no new subprocess calls

    resolvers.forEach(resolve => resolve('')); // let the hung sweep resolve, as a real timeout eventually would
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]); // the joiner wasn't left hanging either

    // Once the in-flight sweep has cleared, the next call is a fresh one.
    const third = await mod.refreshLiveProcesses(async () => '');
    expect(third).toEqual([]);
    expect(mod.getCachedLiveProcesses()).toEqual([]);
  });

  it('a joining caller gets the SAME result the in-flight sweep produces, not an empty/default one', async () => {
    vi.resetModules();
    const mod = await import('../../src/discovery/live.ts');

    let resolvePgrep: ((v: string) => void) | undefined;
    const exec: ExecFn = async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') {
        return new Promise<string>(resolve => { resolvePgrep = resolve; });
      }
      return '';
    };

    const first = mod.refreshLiveProcesses(exec);
    await new Promise(resolve => setImmediate(resolve));
    const second = mod.refreshLiveProcesses(exec);

    resolvePgrep!('100\n');
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.map(p => p.pid)).toEqual([100]);
  });
});

describe('discoverLiveProcesses: live session file', () => {
  const NOW = 1_789_500_000_000;
  // 05:23 elapsed = 323 s, so the process started at NOW - 323_000.
  const claudeExec = fakeExec({
    'pgrep -x claude': '100\n',
    'ps -o tty= -p 100': 'ttys001\n',
    'lsof -a -p 100 -d cwd -Fn': 'p100\nfcwd\nn/repo/a\n',
    'ps -o etime=,rss= -p 100': '05:23  1234\n',
    'ps -o ppid=,comm= -p 100': '1 claude\n',
  });
  const file = (o: Partial<LiveSessionFile> = {}): LiveSessionFile => ({
    sessionId: 'sess-a', cwd: '/repo/a', startedAtMs: NOW - 323_000 + 700, status: 'waiting', ...o,
  });
  const ok = (f: LiveSessionFile): LiveSessionRead => ({ ok: true, file: f });

  beforeEach(() => resetLiveSessionWarnings());

  it('attaches the file when its start time agrees with the process', async () => {
    const [p] = await discoverLiveProcesses(claudeExec, { readLiveSession: () => ok(file()), now: () => NOW, warn: vi.fn() });
    expect(p!.liveSession).toEqual(file());
  });

  it('ignores the file and warns once when the start time disagrees (pid reuse)', async () => {
    const warn = vi.fn();
    const deps = { readLiveSession: () => ok(file({ startedAtMs: NOW - 900_000 })), now: () => NOW, warn };
    const [p] = await discoverLiveProcesses(claudeExec, deps);
    await discoverLiveProcesses(claudeExec, deps);
    expect(p).not.toHaveProperty('liveSession');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/pid 100.*start time/);
  });

  it('ignores the file when the process age is unknown', async () => {
    const exec: ExecFn = async (bin, args) =>
      (bin === 'ps' && args[1] === 'etime=,rss=') ? '' : claudeExec(bin, args);
    const [p] = await discoverLiveProcesses(exec, { readLiveSession: () => ok(file()), now: () => NOW, warn: vi.fn() });
    expect(p).not.toHaveProperty('liveSession');
  });

  it('treats a missing file as normal: no liveSession, no warning', async () => {
    const warn = vi.fn();
    const [p] = await discoverLiveProcesses(claudeExec, {
      readLiveSession: () => ({ ok: false, reason: 'missing' }), now: () => NOW, warn,
    });
    expect(p).not.toHaveProperty('liveSession');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per pid and reason for a rejected file, naming the reason but not the contents', async () => {
    const warn = vi.fn();
    const deps = { readLiveSession: (): LiveSessionRead => ({ ok: false, reason: 'invalid' }), now: () => NOW, warn };
    await discoverLiveProcesses(claudeExec, deps);
    await discoverLiveProcesses(claudeExec, deps);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/pid 100.*invalid/);
  });

  it('warns once per app run, not per pid, when the sessions directory is missing', async () => {
    const warn = vi.fn();
    const exec = fakeExec({
      'pgrep -x claude': '100\n101\n',
      'ps -o etime=,rss= -p 100': '05:23  1\n', 'ps -o ppid=,comm= -p 100': '1 claude\n',
      'ps -o etime=,rss= -p 101': '05:23  1\n', 'ps -o ppid=,comm= -p 101': '1 claude\n',
    });
    const deps = { readLiveSession: (): LiveSessionRead => ({ ok: false, reason: 'missing_dir' }), now: () => NOW, warn };
    await discoverLiveProcesses(exec, deps);
    await discoverLiveProcesses(exec, deps);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never reads a session file for a Codex process', async () => {
    const readLiveSession = vi.fn((): LiveSessionRead => ({ ok: true, file: file() }));
    const exec = fakeExec({
      'pgrep -x codex': '200\n',
      'ps -o etime=,rss= -p 200': '05:23  1\n',
      'ps -o ppid=,comm= -p 200': '1 codex\n',
    });
    const [p] = await discoverLiveProcesses(exec, { readLiveSession, now: () => NOW, warn: vi.fn() });
    expect(readLiveSession).not.toHaveBeenCalled();
    expect(p).not.toHaveProperty('liveSession');
  });
});
