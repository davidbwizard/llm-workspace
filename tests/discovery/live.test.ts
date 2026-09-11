import { describe, it, expect, vi } from 'vitest';
import { discoverLiveProcesses, type ExecFn } from '../../src/discovery/live.ts';

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
