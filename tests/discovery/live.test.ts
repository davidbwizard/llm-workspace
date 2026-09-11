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
  it('finds processes for both providers concurrently and reports pid/tty/cwd/host/age/memory', async () => {
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

    expect(byPid.get(100)).toEqual({
      pid: 100, tty: 'ttys001', cwd: '/repo/a', host: 'iterm2',
      ageSeconds: 5 * 60 + 23, rssBytes: 1234 * 1024,
    });
    expect(byPid.get(200)).toEqual({
      pid: 200, tty: 'ttys002', cwd: '/repo/b', host: 'unknown',
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
        { pid: 100, tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null },
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
    const expected = [{ pid: 100, tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null }];
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
