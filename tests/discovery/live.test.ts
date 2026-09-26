import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  discoverLiveProcesses, execFileSoft, resetLiveSessionWarnings, type ExecFn, type DiscoveryDeps,
} from '../../src/discovery/live.ts';
import type { LiveSessionFile, LiveSessionRead } from '../../src/providers/claude/liveSession.ts';

// A canned exec: keys are "bin arg1 arg2 ...", exactly how discoverLiveProcesses
// invokes exec() -- so a test only needs to name the calls it cares about.
// Anything not listed resolves to '', matching the real defaultExec's own
// fail-soft behaviour for a missing binary or an exited pid.
function fakeExec(responses: Record<string, string>): ExecFn {
  return async (bin, args) => responses[[bin, ...args].join(' ')] ?? '';
}

// Stub to keep all tests off the real ~/.claude/sessions directory.
const NO_SESSION_FILE: DiscoveryDeps = {
  readLiveSession: () => ({ ok: false, reason: 'missing' }),
};

describe('discoverLiveProcesses', () => {
  it('finds processes for both providers concurrently and reports pid/provider/tty/cwd/host/age/memory', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '100 claude\n200 codex\n300 zsh\n',
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

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs).toHaveLength(2);
    const byPid = new Map(procs.map(p => [p.pid, p]));

    // provider comes from the command name in the process list (100 is
    // 'claude', 200 is 'codex'), not from any per-pid lookup -- it is
    // known before any of the other fields are, and unlike them is never
    // subject to a ps/lsof call failing soft. 300 runs neither binary and
    // is not reported at all.
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
    it('resolves to an empty list when ps is unavailable (the real ENOENT path: exec fails soft to empty output)', async () => {
      const exec: ExecFn = async () => '';
      await expect(discoverLiveProcesses(exec)).resolves.toEqual([]);
    });

    it('still reports a pid the process list found even when every per-pid lookup for it comes back empty', async () => {
      const exec: ExecFn = async (bin, args) =>
        bin === 'ps' && args[0] === '-axo' ? '100 claude\n' : '';
      const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
      expect(procs).toEqual([
        { pid: 100, provider: 'claude', tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null },
      ]);
    });

    it('never rejects even if an injected exec violates its own no-throw contract', async () => {
      const exec: ExecFn = async () => { throw new Error('boom'); };
      await expect(discoverLiveProcesses(exec)).resolves.toEqual([]);
    });
  });

  // The bug this closes: discovery used `pgrep -x <bin>`, and pgrep does
  // not report the CALLING process's own ancestors. The app is routinely
  // launched from inside an agent session (a person asks their agent to
  // start it), and that session was then the one session discovery could
  // never see. Measured 2026-09-16: the same `pgrep -x claude` returned
  // four pids from an unrelated process tree and three from inside one of
  // them -- the missing pid being the session that launched the app.
  // Enumerating with ps and filtering in-process is caller-independent.
  it('enumerates with ps rather than pgrep, whose results depend on who is asking', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push([bin, ...args]);
      return bin === 'ps' && args[0] === '-axo' ? '42 claude\n' : '';
    };
    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid)).toEqual([42]);
    expect(calls.some(c => c[0] === 'pgrep')).toBe(false);
    expect(calls).toContainEqual(['ps', '-axo', 'pid=,comm=']);
  });

  it('matches on the basename, so a provider binary run from a full path still counts', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '30651 /Applications/ChatGPT.app/Contents/Resources/codex\n',
      'ps -o ppid=,comm= -p 30651': '1 ChatGPT\n',
    });
    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => ({ pid: p.pid, provider: p.provider }))).toEqual([{ pid: 30651, provider: 'codex' }]);
  });

  it('never interpolates the pid into a shell string -- each ps/lsof call receives it as its own argv entry', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'ps' && args[0] === '-axo') return '42 claude\n';
      return '';
    };
    await discoverLiveProcesses(exec, NO_SESSION_FILE);
    for (const call of calls) {
      // The enumeration call names no pid at all, so it has nothing to check.
      if (call[1] === '-axo') continue;
      // The pid appears as its own array element (String(42) === '42'),
      // never concatenated into a combined string like '-p 42' or embedded
      // inside another argument.
      expect(call).toContain('42');
      expect(call.some(a => a !== '42' && a.includes('42'))).toBe(false);
    }
  });
});

// Codex exact identity: which rollout files each Codex process holds open.
// Measured 2026-09-18: a Codex CLI whose folder was moved mid-session keeps
// its session_meta cwd at the OLD path, so cwd matching can never find it --
// but the process still holds its rollouts open. Fixture recorded from
// `lsof -Fpn -p 45781,45783,46619,80187` on that machine (see
// tests/discovery/parse.test.ts).
describe('open Codex rollouts', () => {
  const LSOF_FPN = readFileSync(resolve('tests/fixtures/discovery/lsof-Fpn-codex.txt'), 'utf8');
  const HOME = '/Users/exampleuser00';
  const ROOT = `${HOME}/.codex/sessions`;
  const DAY = `${ROOT}/2026/09/17`;
  const DEPS: DiscoveryDeps = { ...NO_SESSION_FILE, codexSessions: ROOT };
  const APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const PS = `45781 ${APP_CODEX}\n45783 ${APP_CODEX}\n46619 ${APP_CODEX}\n80187 codex\n100 claude\n`;
  const LSOF_KEY = 'lsof -Fpn -p 45781,45783,46619,80187';
  const MOVED_CWD = `${HOME}/Documents/ExampleOrg/Education/educational-farm`;

  it('lists every rollout the process holds open, root and subagent threads alike, in lsof order', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': PS,
      'lsof -a -p 80187 -d cwd -Fn': `p80187\nfcwd\nn${MOVED_CWD}\n`,
      [LSOF_KEY]: LSOF_FPN,
    });
    const procs = await discoverLiveProcesses(exec, DEPS);
    const byPid = new Map(procs.map(p => [p.pid, p]));
    expect(byPid.get(80187)).toMatchObject({ provider: 'codex', cwd: MOVED_CWD });
    expect(byPid.get(80187)!.openRollouts).toEqual([
      `${DAY}/rollout-2026-09-17T10-11-56-01a0b05a-8289-7881-97cc-1507cfd4b7b3.jsonl`,
      `${DAY}/rollout-2026-09-17T10-06-25-01a0b055-739c-7822-860d-016ebc9d8f9c.jsonl`,
      `${DAY}/rollout-2026-09-17T07-21-08-01a0afbe-22ea-73b1-a35e-3ecb24fa063f.jsonl`,
      `${DAY}/rollout-2026-09-17T07-21-08-01a0afbe-2356-7480-b351-901c66764f90.jsonl`,
      `${DAY}/rollout-2026-09-17T10-06-25-01a0b055-7358-7323-ada2-fc70aa2ed4da.jsonl`,
      `${DAY}/rollout-2026-09-17T10-04-30-01a0b053-b307-7da0-bc12-8fea466f79c2.jsonl`,
    ]);
    // No rollout open (the desktop app's processes here), and never a
    // Claude process: the field is omitted, so their shape is as before.
    for (const pid of [45781, 45783, 46619, 100]) expect(byPid.get(pid)).not.toHaveProperty('openRollouts');
  });

  it('runs ONE lsof for every Codex pid together, never per pid, and never for a Claude pid', async () => {
    const calls: Array<{ bin: string; args: string[]; opts: unknown }> = [];
    const exec: ExecFn = async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (bin === 'ps' && args[0] === '-axo') return PS;
      return [bin, ...args].join(' ') === LSOF_KEY ? LSOF_FPN : '';
    };
    await discoverLiveProcesses(exec, DEPS);
    const rolloutCalls = calls.filter(c => c.bin === 'lsof' && c.args.includes('-Fpn'));
    expect(rolloutCalls).toEqual([
      // lsof exits 1 when any listed pid has gone, but still prints every
      // one it found -- so exit 1 keeps its output.
      { bin: 'lsof', args: ['-Fpn', '-p', '45781,45783,46619,80187'], opts: { okExitCodes: [1] } },
    ]);
  });

  it('skips the lookup entirely when there is no Codex process', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push([bin, ...args]);
      return bin === 'ps' && args[0] === '-axo' ? '100 claude\n' : '';
    };
    await discoverLiveProcesses(exec, DEPS);
    expect(calls.some(c => c.includes('-Fpn'))).toBe(false);
  });

  it('ignores anything outside the Codex sessions folder or not named like a rollout', async () => {
    const good = `${DAY}/rollout-2026-09-17T07-21-08-good.jsonl`;
    const exec = fakeExec({
      'ps -axo pid=,comm=': '80187 codex\n',
      'lsof -Fpn -p 80187': [
        'p80187', 'f30', `n${good}`,
        'f31', `n${good}`, // a second fd on the same file lists it once
        'f32', 'n/tmp/rollout-2026-09-17T07-21-08-outside.jsonl',
        'f33', `n${ROOT}/../evil/rollout-2026-09-17T07-21-08-dotdot.jsonl`,
        'f34', `n${HOME}/.codex/sessions-evil/rollout-2026-09-17T07-21-08-prefix.jsonl`,
        'f35', `n${DAY}/notes.jsonl`,
        'f36', `n${DAY}/rollout-2026-09-17T07-21-08-x.jsonl.bak`,
        'f37', 'nrollout-2026-09-17T07-21-08-relative.jsonl',
        'f38', `n${HOME}/.codex/thread-writer-locks/01a0afbe-22ea-73b1-a35e-3ecb24fa063f.lock`,
      ].join('\n') + '\n',
    });
    const [proc] = await discoverLiveProcesses(exec, DEPS);
    expect(proc!.openRollouts).toEqual([good]);
  });

  describe('falls back to cwd matching (no openRollouts) and never loses the process', () => {
    const base = {
      'ps -axo pid=,comm=': '80187 codex\n',
      'lsof -a -p 80187 -d cwd -Fn': `p80187\nfcwd\nn${MOVED_CWD}\n`,
    };
    const expectFallback = async (exec: ExecFn) => {
      const procs = await discoverLiveProcesses(exec, DEPS);
      expect(procs).toHaveLength(1);
      expect(procs[0]).toMatchObject({ pid: 80187, provider: 'codex', cwd: MOVED_CWD });
      expect(procs[0]).not.toHaveProperty('openRollouts');
    };

    it('when lsof fails or times out (execFileSoft resolves to empty output)', async () => {
      await expectFallback(fakeExec({ ...base, 'lsof -Fpn -p 80187': '' }));
    });

    it('when lsof prints garbage', async () => {
      await expectFallback(fakeExec({
        ...base,
        'lsof -Fpn -p 80187': 'lsof: illegal option character: F\nusage: [-?abhKlnNoOPRtUvVX]\n<html>\np\nn\npNaN\nn/x\n',
      }));
    });

    it('when the exec for this one call rejects, against its own contract', async () => {
      const inner = fakeExec(base);
      await expectFallback(async (bin, args) => {
        if (args.includes('-Fpn')) throw new Error('boom');
        return inner(bin, args);
      });
    });
  });
});

// A matched pid (the process list showed it running a provider binary)
// is a session only if no
// OTHER matched pid is its ancestor -- a session's own helper subprocesses
// (a sandbox permission wrapper, an app-server) still run the same
// binary, but are reachable from the real session through
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
      'ps -axo pid=,comm=': '85962 codex\n56549 codex\n',
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
      'ps -axo pid=,comm=': '85962 codex\n',
      'ps -o ppid=,comm= -p 85962': '20133 codex\n',
      'ps -o ppid=,comm= -p 20133': '1 zsh\n', // zsh never appears in the matched set
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid)).toEqual([85962]);
  });

  it('keeps a matched pid with no tty and no matched ancestor, parented directly by an unmatched app process', async () => {
    // Pins the ChatGPT-desktop-app case explicitly: no tty, and its only
    // parent is an app process that is not a provider binary -- the
    // rule must keep it, not treat "no tty" as a signal to drop.
    const exec = fakeExec({
      'ps -axo pid=,comm=': '30651 codex\n',
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
      'ps -axo pid=,comm=': '1 codex\n2 codex\n',
      'ps -o ppid=,comm= -p 1': '999 codex\n',
      'ps -o ppid=,comm= -p 2': 'not a valid ppid/comm line\n',
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('the real-machine tree: drops all three codex helpers, keeps the real session and the ChatGPT-app session', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '85962 codex\n56549 codex\n56550 codex\n56553 codex\n30651 codex\n',
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

// The npm-install bug, confirmed on the first outside user's machine
// (2026-09-22). His Codex came from npm, so every session's process is
// called `node` and the executable-name match never found it: sessions
// worked while the app stayed open, then could not be typed into after a
// restart, because the pid->tmux map is rebuilt from tmux on restart and
// discovery had no matching process to meet it. His own tmux panes:
//
//   llmws-codex-021c073b 99310  99310 node
//   llmws-codex-78dc464b  4612   4612 node
//   llmws-codex-a6edb3e1 63054  63054 node
//
// The per-argv precision rules are pinned in tests/discovery/parse.test.ts
// (nodeHostedProvider); these pin the sweep that uses them.
describe('node-hosted provider CLIs (an npm install, not a Homebrew cask)', () => {
  it("finds the outside user's three npm-installed Codex sessions, all of them called node", async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '99310 node\n4612 node\n63054 node\n',
      'ps -axo pid=,args=':
        '99310 node /Users/u/.nvm/versions/node/v22.13.0/bin/codex\n'
        + '4612 node /Users/u/.nvm/versions/node/v22.13.0/bin/codex\n'
        + '63054 node /Users/u/.nvm/versions/node/v22.13.0/bin/codex\n',
      'ps -o ppid=,comm= -p 99310': '1 node\n',
      'ps -o ppid=,comm= -p 4612': '1 node\n',
      'ps -o ppid=,comm= -p 63054': '1 node\n',
    });

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid).sort((a, b) => a - b)).toEqual([4612, 63054, 99310]);
    expect(procs.every(p => p.provider === 'codex')).toBe(true);
  });

  it('finds a Homebrew-cask install and an npm install side by side in one sweep', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '100 claude\n200 node\n',
      'ps -axo pid=,args=': '100 claude\n200 node /usr/local/bin/codex\n',
      'ps -o ppid=,comm= -p 100': '1 zsh\n',
      'ps -o ppid=,comm= -p 200': '1 zsh\n',
    });

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => ({ pid: p.pid, provider: p.provider })).sort((a, b) => a.pid - b.pid))
      .toEqual([{ pid: 100, provider: 'claude' }, { pid: 200, provider: 'codex' }]);
  });

  // The false-positive set, all present on the dev machine at once. Showing
  // any of these as a live agent session is worse than missing a real one:
  // the app would offer to type into it.
  it('reports none of the unrelated Node processes running beside the real session', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '100 node\n201 node\n202 node\n203 node\n204 node\n205 Electron\n206 node\n',
      'ps -axo pid=,args=':
        '100 node /usr/local/bin/claude\n'
        + '201 node server.js\n'
        + '202 node /Users/u/Documents/educational-farm/node_modules/.bin/vite preview --host 127.0.0.1 --port 4176\n'
        + '203 node /Users/u/Documents/trello-mcp-enhanced/build/index.js\n'
        + '204 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl\n'
        // This app itself, both the way it runs packaged and the way it runs
        // in development.
        + '205 /Users/u/Documents/llm-workspace/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/u/Documents/llm-workspace\n'
        + '206 node /Users/u/Documents/llm-workspace/node_modules/.bin/electron .\n',
      'ps -o ppid=,comm= -p 100': '1 zsh\n',
    });

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid)).toEqual([100]);
  });

  // The ancestry rule (above) is what tells a session from a helper it
  // spawned. A node-hosted match must take part in that rule, on both sides.
  it("drops a node-hosted session's own node-hosted helper, keeping only the session", async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '100 node\n101 node\n',
      'ps -axo pid=,args=':
        '100 node /usr/local/bin/codex\n'
        + '101 node /usr/local/bin/codex --app-server\n',
      'ps -o ppid=,comm= -p 100': '99 node\n',
      'ps -o ppid=,comm= -p 99': '1 zsh\n',
      // 101 reaches 100 through an unmatched intermediate, as the real
      // machine's helper tree does.
      'ps -o ppid=,comm= -p 101': '150 node\n',
      'ps -o ppid=,comm= -p 150': '100 node_repl\n',
    });

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid)).toEqual([100]);
  });

  it("never matches a node-hosted session's ordinary node children, so they need no ancestry rule at all", async () => {
    // An MCP server the session spawned. It is `node`, it is a child, and it
    // must simply never enter the matched set.
    const exec = fakeExec({
      'ps -axo pid=,comm=': '100 node\n101 node\n',
      'ps -axo pid=,args=':
        '100 node /usr/local/bin/claude\n'
        + '101 node /Users/u/Documents/trello-mcp-enhanced/build/index.js\n',
      'ps -o ppid=,comm= -p 100': '1 zsh\n',
      'ps -o ppid=,comm= -p 101': '100 node\n',
    });

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid)).toEqual([100]);
  });

  it('a node-hosted session is itself an ancestor the rule honours, dropping a cask helper beneath it', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '100 node\n101 codex\n',
      'ps -axo pid=,args=': '100 node /usr/local/bin/codex\n101 codex\n',
      'ps -o ppid=,comm= -p 100': '1 zsh\n',
      'ps -o ppid=,comm= -p 101': '100 node\n',
    });

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid)).toEqual([100]);
  });

  it('falls back to executable-name matching alone when the argv listing fails (ps missing, timed out, or over maxBuffer)', async () => {
    const exec = fakeExec({
      'ps -axo pid=,comm=': '100 claude\n200 node\n',
      // 'ps -axo pid=,args=' deliberately absent -- exec's fail-soft ''.
      'ps -o ppid=,comm= -p 100': '1 zsh\n',
    });

    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid)).toEqual([100]);
  });

  it('reads the argv listing once for the whole machine, never once per pid', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'ps' && args.join(' ') === '-axo pid=,comm=') return '100 node\n101 node\n';
      if (bin === 'ps' && args.join(' ') === '-axo pid=,args=') {
        return '100 node /usr/local/bin/claude\n101 node server.js\n';
      }
      return '';
    };

    await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(calls.filter(c => c.join(' ') === 'ps -axo pid=,args=')).toHaveLength(1);
    expect(calls.some(c => c.includes('args=') && c.includes('-p'))).toBe(false);
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
      bin === 'ps' && args[0] === '-axo' ? '100 claude\n' : '';

    const result = await mod.refreshLiveProcesses(exec, NO_SESSION_FILE);
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
      bin === 'ps' && args[0] === '-axo' ? '100 claude\n' : '', NO_SESSION_FILE);
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

  // lsof exits 1 when any pid it was asked about has gone, yet prints every
  // one it did find. okExitCodes keeps that output; nothing else changes.
  it('keeps stdout on an exit code the caller lists as ok, and only that one', async () => {
    await expect(execFileSoft('sh', ['-c', 'printf partial; exit 1'], { okExitCodes: [1] })).resolves.toBe('partial');
    await expect(execFileSoft('sh', ['-c', 'printf partial; exit 2'], { okExitCodes: [1] })).resolves.toBe('');
    await expect(execFileSoft('sh', ['-c', 'printf partial; exit 1'])).resolves.toBe('');
  });

  it('still fails soft on a timeout even when exit 1 is ok -- a killed command has no exit code', async () => {
    await expect(execFileSoft('sh', ['-c', 'printf partial; sleep 5'], { okExitCodes: [1] })).resolves.toBe('');
  }, 8000);
});

// B2: pushAfterDiscoverySweep (main/index.ts) fires every 5 seconds with no
// regard for whether the previous sweep already finished, and killSession
// can trigger a sweep at any moment too. Before this fix, a sweep stuck on
// one hung exec call meant a fresh, fully concurrent sweep -- another
// ~13 processes' worth of ps/lsof calls -- stacked on top of it every
// single tick, forever (and, since nothing timed out either, no sweep in
// that pile ever finished). These prove the in-flight guard: a caller that
// arrives while a sweep is already running joins that SAME sweep instead of
// starting a new one, is not left hanging once it resolves, and a later
// caller (after the in-flight one has cleared) gets a genuinely fresh sweep.
describe('refreshLiveProcesses — in-flight sweep guard', () => {
  it('does not start a second sweep while one is still pending, and does not accumulate hung calls', async () => {
    vi.resetModules();
    const mod = await import('../../src/discovery/live.ts');

    let listCalls = 0;
    const resolvers: Array<(v: string) => void> = [];
    const hangingExec: ExecFn = (bin, args) => {
      if (!(bin === 'ps' && args[0] === '-axo')) return Promise.resolve('');
      listCalls++;
      return new Promise<string>(resolve => resolvers.push(resolve));
    };

    const first = mod.refreshLiveProcesses(hangingExec);
    // Let the synchronous/microtask portion of the first sweep run --
    // discoverLiveProcesses fires its process-list call before it awaits
    // anything else.
    await new Promise(resolve => setImmediate(resolve));
    const callsWhileFirstPending = listCalls;
    expect(callsWhileFirstPending).toBeGreaterThan(0);

    const second = mod.refreshLiveProcesses(hangingExec); // arrives while first is still hung
    await new Promise(resolve => setImmediate(resolve));
    expect(listCalls).toBe(callsWhileFirstPending); // no new sweep -- no new subprocess calls

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

    // A sweep opens with more than one `-axo` listing (executable names and
    // argv, concurrently), so every one of them has to be released -- holding
    // a single resolver would just hang the sweep it is meant to join.
    const resolvers: Array<(v: string) => void> = [];
    const exec: ExecFn = async (bin, args) => {
      if (bin === 'ps' && args[0] === '-axo') {
        return new Promise<string>(resolve => { resolvers.push(resolve); });
      }
      return '';
    };

    const first = mod.refreshLiveProcesses(exec, NO_SESSION_FILE);
    await new Promise(resolve => setImmediate(resolve));
    const second = mod.refreshLiveProcesses(exec, NO_SESSION_FILE);

    expect(resolvers.length).toBeGreaterThan(0);
    resolvers.forEach(resolve => resolve('100 claude\n'));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.map(p => p.pid)).toEqual([100]);
  });
});

describe('discoverLiveProcesses: live session file', () => {
  const NOW = 1_789_500_000_000;
  // 05:23 elapsed = 323 s, so the process started at NOW - 323_000.
  const claudeExec = fakeExec({
    'ps -axo pid=,comm=': '100 claude\n',
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
      'ps -axo pid=,comm=': '100 claude\n101 claude\n',
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
      'ps -axo pid=,comm=': '200 codex\n',
      'ps -o etime=,rss= -p 200': '05:23  1\n',
      'ps -o ppid=,comm= -p 200': '1 codex\n',
    });
    const [p] = await discoverLiveProcesses(exec, { readLiveSession, now: () => NOW, warn: vi.fn() });
    expect(readLiveSession).not.toHaveBeenCalled();
    expect(p).not.toHaveProperty('liveSession');
  });
});

// A `codex` process is not necessarily a Codex SESSION. The CLI runs its own
// plumbing under the same binary name -- `codex app-server`, `codex sandbox`,
// `codex app-server daemon` -- and those are siblings of each other under a
// non-codex parent (the ChatGPT app's code-mode host, or launchd), so the
// ancestry rule above cannot see them: none is an ancestor of another.
//
// Measured on this machine 2026-09-26: of eleven Codex processes outside
// Fleet's own tmux sessions, exactly ONE was a session the user started. The
// other ten were two app-server daemons, a pid-update loop, and six
// ChatGPT-app helpers. They were listed as sessions, and -- because they
// share a cwd with real work -- they crowded directories enough to make the
// conversation view refuse to identify a transcript.
describe('subcommand filtering (a codex session runs no subcommand)', () => {
  const inspect = (pid: number, args: string) => ({
    [`ps -o tty= -p ${pid}`]: 'ttys004\n',
    [`ps -o ppid=,comm= -p ${pid}`]: '999 node_repl\n',
    [`ps -o args= -p ${pid}`]: `${args}\n`,
  });

  it('drops codex app-server, sandbox and daemon, and keeps the real session beside them', async () => {
    // The exact shape measured: three siblings under one non-codex parent.
    const exec = fakeExec({
      'ps -axo pid=,comm=': '1 codex\n2 codex\n3 codex\n4 codex\n',
      ...inspect(1, '/Applications/ChatGPT.app/Contents/Resources/codex sandbox --full-auto'),
      ...inspect(2, '/Applications/ChatGPT.app/Contents/Resources/codex app-server --analytics'),
      ...inspect(3, '/Users/me/.codex/packages/app-server-daemon/bin/codex app-server daemon pid-update-loop'),
      ...inspect(4, 'codex -c approvals_reviewer=user'),
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid)).toEqual([4]);
  });

  it('drops the ChatGPT app-server, whose subcommand sits AFTER a flag value', async () => {
    // The real command line, measured: the subcommand is not in first
    // position, so a first-non-flag-token rule misses it entirely.
    const exec = fakeExec({
      'ps -axo pid=,comm=': '8 codex\n',
      ...inspect(8, '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled'),
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs).toEqual([]);
  });

  it('keeps a session whose flag VALUE happens to read like a subcommand', async () => {
    // `-c key=value` puts an arbitrary token on the command line. A bare
    // subcommand is what disqualifies a process, never a flag's value.
    const exec = fakeExec({
      'ps -axo pid=,comm=': '5 codex\n',
      ...inspect(5, 'codex -c sandbox_mode=workspace-write --remote unix:///tmp/x.sock'),
    });

    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid)).toEqual([5]);
  });

  it('keeps a pid whose args cannot be read, rather than dropping it', async () => {
    // Same fail-soft discipline as every other lookup here: unknown must
    // resolve to "keep", never to "looks suspicious, drop it".
    const exec = fakeExec({ 'ps -axo pid=,comm=': '6 codex\n' });
    const procs = await discoverLiveProcesses(exec);
    expect(procs.map(p => p.pid)).toEqual([6]);
  });

  it('never applies subcommand filtering to claude', async () => {
    // The rule is about the codex CLI's own subcommand surface. Nothing
    // here should reach into the other provider's command line.
    const exec = fakeExec({
      'ps -axo pid=,comm=': '7 claude\n',
      'ps -o tty= -p 7': 'ttys001\n',
      'ps -o ppid=,comm= -p 7': '1 iTerm2\n',
      'ps -o args= -p 7': 'claude exec something\n',
    });
    const procs = await discoverLiveProcesses(exec, NO_SESSION_FILE);
    expect(procs.map(p => p.pid)).toEqual([7]);
  });
});
