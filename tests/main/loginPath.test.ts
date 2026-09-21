import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loginShell, parseLoginPath, mergePath, resolveLoginPath, applyLoginPath,
  applyLoginPathOnce, whenLoginPathApplied, resetLoginPathOnce,
} from '../../src/main/loginPath.ts';

/** Frames a PATH exactly as src/main/loginPath.ts's probe does, so these
 *  tests exercise the real marker contract rather than a lookalike. */
function framed(path: string, before = '', after = ''): string {
  return `${before}\n__LLMWS_PATH_BEGIN__${path}__LLMWS_PATH_END__\n${after}`;
}

describe('which shell gets asked', () => {
  it('prefers $SHELL when it is an absolute path', () => {
    expect(loginShell({ SHELL: '/opt/homebrew/bin/fish' }, () => ({ shell: '/bin/zsh' }))).toBe('/opt/homebrew/bin/fish');
  });

  // The Finder case, measured 2026-09-21: launchctl's environment has no
  // SHELL, so the password database is the only source left.
  it('falls back to the password database when $SHELL is absent', () => {
    expect(loginShell({}, () => ({ shell: '/bin/zsh' }))).toBe('/bin/zsh');
  });

  // $SHELL is inherited environment: a relative value would be resolved
  // against PATH (or the cwd) at spawn time, which is the whole class of
  // problem this file exists to close.
  it.each([
    ['relative', 'zsh'],
    ['empty', ''],
  ])('refuses a %s $SHELL', (_label, value) => {
    expect(loginShell({ SHELL: value }, () => ({ shell: '/bin/zsh' }))).toBe('/bin/zsh');
  });

  it('falls back to /bin/sh when neither source offers an absolute path', () => {
    expect(loginShell({}, () => ({ shell: null }))).toBe('/bin/sh');
  });

  it('falls back to /bin/sh when the password lookup throws', () => {
    expect(loginShell({}, () => { throw new Error('no passwd entry'); })).toBe('/bin/sh');
  });
});

describe('reading the PATH out of the shell output', () => {
  it('takes what is between the markers', () => {
    expect(parseLoginPath(framed('/opt/homebrew/bin:/usr/bin'))).toEqual(['/opt/homebrew/bin', '/usr/bin']);
  });

  // The reason the markers exist: a profile that greets you on stdout
  // would otherwise be glued to the front of the first entry.
  it('ignores a profile that prints its own output around it', () => {
    const out = framed('/opt/homebrew/bin', 'Welcome back!', 'nvm: using v24');
    expect(parseLoginPath(out)).toEqual(['/opt/homebrew/bin']);
  });

  it('ignores a banner printed with no trailing newline of its own', () => {
    expect(parseLoginPath(`no newline here${framed('/opt/homebrew/bin')}`)).toEqual(['/opt/homebrew/bin']);
  });

  // A profile is user-controlled input. Every one of these resolves a bare
  // name against whatever directory the process happens to be in.
  it('drops empty and relative entries', () => {
    expect(parseLoginPath(framed('/usr/bin::.:bin:../bin:/bin'))).toEqual(['/usr/bin', '/bin']);
  });

  it('drops an absurdly long entry', () => {
    const long = `/${'a'.repeat(2000)}`;
    expect(parseLoginPath(framed(`/usr/bin:${long}:/bin`))).toEqual(['/usr/bin', '/bin']);
  });

  it('keeps the first of a repeated entry', () => {
    expect(parseLoginPath(framed('/usr/bin:/bin:/usr/bin'))).toEqual(['/usr/bin', '/bin']);
  });

  it('caps the number of entries', () => {
    const many = Array.from({ length: 400 }, (_, i) => `/d${i}`).join(':');
    expect(parseLoginPath(framed(many))).toHaveLength(256);
  });

  // execFileSoft hands back '' for a shell that failed, timed out or was
  // SIGKILLed, and a shell that printed only a banner has no markers
  // either. All of them must read as "nothing usable", never as a PATH.
  it.each([
    ['empty output', ''],
    ['output with no markers at all', 'zsh: command not found: printf\n'],
    ['a start marker with no end', '__LLMWS_PATH_BEGIN__/usr/bin'],
  ])('reads %s as nothing', (_label, out) => {
    expect(parseLoginPath(out)).toEqual([]);
  });

  it('reads markers around an empty PATH as nothing', () => {
    expect(parseLoginPath(framed(''))).toEqual([]);
  });
});

describe('merging with what was inherited', () => {
  it('appends what the shell named and was not already there', () => {
    expect(mergePath(['/opt/homebrew/bin'], '/usr/bin:/bin'))
      .toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  // The guarantee this change must not break: discovery's ps/lsof/pgrep
  // live in the minimal PATH, and a profile that clobbers PATH rather than
  // appending to it must not be able to take them away.
  it('keeps the inherited entries even when the profile replaced PATH entirely', () => {
    expect(mergePath(['/Users/me/bin'], '/usr/bin:/bin:/usr/sbin:/sbin'))
      .toBe('/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/bin');
  });

  // Nothing user-controlled gets to move in front of the directories the
  // process was already given -- /usr/bin's ps, open and osascript stay the
  // ones this app resolves.
  it('never moves an inherited entry, even when the shell lists it first', () => {
    expect(mergePath(['/opt/homebrew/bin', '/usr/bin'], '/usr/bin:/bin'))
      .toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  // The `npm run dev` case: the process was started FROM the login shell,
  // so there is nothing to add and the PATH npm built is left untouched.
  it('reports nothing to do when the shell adds no new directory', () => {
    expect(mergePath(['/usr/bin', '/bin'], '/project/node_modules/.bin:/usr/bin:/bin')).toBeNull();
  });

  it('validates the inherited entries too', () => {
    expect(mergePath(['/opt/homebrew/bin'], '/usr/bin::.')).toBe('/usr/bin:/opt/homebrew/bin');
  });

  it('tolerates no inherited PATH at all', () => {
    expect(mergePath(['/opt/homebrew/bin'], undefined)).toBe('/opt/homebrew/bin');
  });
});

describe('resolving against a shell', () => {
  it('asks the shell for one printf and nothing else', async () => {
    const calls: Array<[string, string[]]> = [];
    await resolveLoginPath({
      exec: async (bin, args) => { calls.push([bin, args]); return framed('/opt/homebrew/bin'); },
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    });
    expect(calls).toHaveLength(1);
    const [bin, args] = calls[0]!;
    expect(bin).toBe('/bin/zsh');
    expect(args[0]).toBe('-ilc');
    expect(args[1]).toMatch(/^printf /);
  });

  it('returns the merged PATH and what it added to it', async () => {
    const merged = await resolveLoginPath({
      exec: async () => framed('/opt/homebrew/bin:/usr/bin'),
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    });
    expect(merged).toEqual({ path: '/usr/bin:/bin:/opt/homebrew/bin', added: ['/opt/homebrew/bin'] });
  });

  // A shell that hung is SIGKILLed by execFileSoft and reads as '' here.
  // "Nothing to change" is the only safe answer: the inherited PATH at
  // least still has the base system on it.
  it.each([
    ['a shell that printed nothing', ''],
    ['a shell that only errored', 'zsh: no such file or directory\n'],
    ['junk entries only', framed('::.:relative')],
  ])('leaves the inherited PATH alone for %s', async (_label, out) => {
    expect(await resolveLoginPath({
      exec: async () => out, env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    })).toBeNull();
  });

  it('reports no change when the login shell names nothing new', async () => {
    expect(await resolveLoginPath({
      exec: async () => framed('/bin:/usr/bin'), env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    })).toBeNull();
  });
});

describe('applying it to the process environment', () => {
  it('sets PATH and says what it set', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    const result = await applyLoginPath({ exec: async () => framed('/opt/homebrew/bin'), env });
    expect(result).toEqual({ status: 'applied', path: '/usr/bin:/opt/homebrew/bin', added: ['/opt/homebrew/bin'] });
    expect(env.PATH).toBe('/usr/bin:/opt/homebrew/bin');
  });

  it('leaves PATH untouched when there is nothing usable to apply', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    expect(await applyLoginPath({ exec: async () => '', env })).toEqual({ status: 'unchanged' });
    expect(env.PATH).toBe('/usr/bin');
  });

  // This runs before anything else in app.whenReady, so it must not be
  // able to take startup down with it.
  it('reports a thrown exec as a failure rather than throwing', async () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    const result = await applyLoginPath({
      exec: async () => { throw new Error('spawn EACCES'); }, env,
    });
    expect(result).toEqual({ status: 'failed', error: 'spawn EACCES' });
    expect(env.PATH).toBe('/usr/bin');
  });
});

// Design §7: "Integration: run the probes against the real binaries on this
// machine." Everything above drives a fake shell; this one drives the real
// one, which is the only thing that can catch the probe command itself
// being wrong (a quoting mistake, a shell that refuses -i, a marker the
// shell rewrites).
describe('against this machine\'s real login shell', () => {
  it('resolves a PATH that has more on it than a GUI launch would inherit', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    const merged = await resolveLoginPath({ env });
    expect(merged).not.toBeNull();
    const entries = merged!.path.split(':');
    // The four it started with are all still there, still in front.
    expect(entries.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(merged!.added.length).toBeGreaterThan(0);
  }, 10_000);
});

// The ordering the whole first-run feature rests on. Without the repaired
// PATH, every dependency probe reports "missing" on a machine where all
// three are installed -- and reports it confidently, in a screen whose only
// job is to be believed. So it is a dependency callers STATE, not an order
// two statements in app.whenReady happen to be in.
describe('the PATH repair as a stated dependency', () => {
  beforeEach(() => { resetLoginPathOnce(); });
  afterEach(() => { resetLoginPathOnce(); });

  it('throws when nothing has started the repair yet', () => {
    // A caller that gets here first has an ordering bug, and the honest
    // moment to find that is in a test, not in a stranger's first launch.
    expect(() => whenLoginPathApplied()).toThrow(/PATH/i);
  });

  it('runs the repair exactly once, however many callers ask', async () => {
    const exec = vi.fn(async () => '');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/bin/zsh' };
    const deps = { exec, env, shell: () => '/bin/zsh' };

    const a = applyLoginPathOnce(deps);
    const b = applyLoginPathOnce(deps);
    expect(a).toBe(b);
    await a;
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('hands every later caller the same settled result', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/bin/zsh' };
    const exec = async () => `\n__LLMWS_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__LLMWS_PATH_END__\n`;
    await applyLoginPathOnce({ exec, env, shell: () => '/bin/zsh' });

    const result = await whenLoginPathApplied();
    expect(result.status).toBe('applied');
    expect(env.PATH).toBe('/usr/bin:/opt/homebrew/bin');
  });

  it('waits for a repair still in flight rather than resolving early', async () => {
    let release!: (v: string) => void;
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/bin/zsh' };
    const exec = () => new Promise<string>(r => { release = r; });

    applyLoginPathOnce({ exec, env, shell: () => '/bin/zsh' });
    let settled = false;
    const waiting = whenLoginPathApplied().then(r => { settled = true; return r; });

    await Promise.resolve();
    expect(settled).toBe(false);

    release(`\n__LLMWS_PATH_BEGIN__/opt/homebrew/bin__LLMWS_PATH_END__\n`);
    expect((await waiting).status).toBe('applied');
  });

  it('resolves rather than throwing when the repair itself failed', async () => {
    // applyLoginPath never throws -- it reports 'failed' and leaves the
    // inherited PATH alone. A probe must then run against that shorter
    // PATH and report honestly, not refuse to run at all.
    const exec = async () => { throw new Error('no shell'); };
    const result = await applyLoginPathOnce({ exec, env: { PATH: '/usr/bin' }, shell: () => '/bin/zsh' });
    expect(result.status).toBe('failed');
    expect((await whenLoginPathApplied()).status).toBe('failed');
  });
});
