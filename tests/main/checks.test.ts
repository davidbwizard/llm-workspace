import { describe, it, expect, vi } from 'vitest';
import {
  DEPENDENCIES, VERSION_TIMEOUT_MS, DOCTOR_TIMEOUT_MS, MAX_DOCTOR_OUTPUT_CHARS,
  probeDependency, runChecks, capabilitiesFor, firstLine, defaultProbeExec,
  type ProbeRun, type ProbeExec, type DependencyCheck,
} from '../../src/main/checks.ts';

/** A ProbeExec built from a map of `"<bin> <args>"` -> outcome. Anything not
 *  named answers as missing, so a test only has to say what it cares about. */
function execFrom(table: Record<string, ProbeRun>): ProbeExec {
  return async (bin, args) => table[[bin, ...args].join(' ')] ?? { status: 'missing' };
}

const exited = (code: number, stdout = '', stderr = ''): ProbeRun =>
  ({ status: 'exited', code, stdout, stderr });

/** The PATH gate every runChecks call here satisfies; the ordering tests
 *  below are the ones that exercise what happens when it is not satisfied. */
const pathReady = () => Promise.resolve();

const byId = (checks: DependencyCheck[], id: string) => checks.find(c => c.id === id)!;

describe('the four outcomes are distinguishable', () => {
  // "missing" and "broken" are different sentences to the person (design
  // §7), so these four must never collapse into one another.
  it('reports a present, healthy dependency as ok, with its version', async () => {
    const check = await probeDependency('claude', execFrom({
      'claude --version': exited(0, '2.1.278 (Claude Code)\n'),
      'claude doctor': exited(0, 'No installation issues found.\n'),
    }));
    expect(check.state).toBe('ok');
    expect(check.version).toBe('2.1.278 (Claude Code)');
    expect(check.doctor?.state).toBe('ok');
  });

  it('reports a present dependency whose doctor exits non-zero as unhealthy', async () => {
    const check = await probeDependency('claude', execFrom({
      'claude --version': exited(0, '2.1.278 (Claude Code)\n'),
      'claude doctor': exited(1, 'Auto-updates: failing\n'),
    }));
    expect(check.state).toBe('unhealthy');
    // Present, so the version is still known and still reported: this is the
    // fact that separates unhealthy from missing.
    expect(check.version).toBe('2.1.278 (Claude Code)');
    expect(check.doctor).toEqual(
      expect.objectContaining({ state: 'unhealthy', exitCode: 1 }),
    );
  });

  it('reports a binary that is not on PATH as missing', async () => {
    const check = await probeDependency('codex', execFrom({}));
    expect(check.state).toBe('missing');
    expect(check.version).toBeNull();
    // Nothing to be healthy or unhealthy about.
    expect(check.doctor).toBeNull();
  });

  it('reports a version probe that never finished as timeout, not missing', async () => {
    const check = await probeDependency('tmux', execFrom({ 'tmux -V': { status: 'timeout' } }));
    expect(check.state).toBe('timeout');
    expect(check.version).toBeNull();
  });

  it('gives each of the four states its own sentence', async () => {
    const states = await Promise.all([
      probeDependency('tmux', execFrom({ 'tmux -V': exited(0, 'tmux 3.7c') })),
      probeDependency('claude', execFrom({
        'claude --version': exited(0, '2.1.278'), 'claude doctor': exited(1, 'bad'),
      })),
      probeDependency('codex', execFrom({})),
      probeDependency('tmux', execFrom({ 'tmux -V': { status: 'timeout' } })),
    ]);
    const details = states.map(s => s.detail);
    expect(new Set(details).size).toBe(4);
    expect(details.every(d => d.length > 0)).toBe(true);
  });
});

describe('what the probes are allowed to run', () => {
  // Design §3: "No probe may ever send a prompt to a model." Every command
  // this module runs is pinned here, so adding one is a deliberate edit to
  // this list rather than something that slips in.
  it('runs only --version and doctor, and never a bare invocation', async () => {
    const calls: string[] = [];
    const exec: ProbeExec = async (bin, args) => {
      calls.push([bin, ...args].join(' '));
      return exited(0, 'x');
    };
    await runChecks({ exec, pathReady });
    expect(calls.sort()).toEqual([
      'claude --version', 'claude doctor',
      'codex --version', 'codex doctor',
      'tmux -V',
    ]);
  });

  // tmux has no doctor subcommand; inventing one would spawn a tmux SERVER
  // on a machine that has none, which is the opposite of a read-only probe.
  it('never runs a doctor for tmux', async () => {
    const check = await probeDependency('tmux', execFrom({ 'tmux -V': exited(0, 'tmux 3.7c') }));
    expect(check.state).toBe('ok');
    expect(check.doctor).toBeNull();
  });

  it('does not run doctor at all when the binary is missing', async () => {
    const calls: string[] = [];
    await probeDependency('codex', async (bin, args) => {
      calls.push([bin, ...args].join(' '));
      return { status: 'missing' };
    });
    expect(calls).toEqual(['codex --version']);
  });
});

describe('doctor is a signal, not a data source', () => {
  // Design §3: use the exit code, keep the output for the person to read,
  // and never infer state from its wording -- it is a human-facing
  // diagnostic whose phrasing changes between releases.
  it('takes its verdict from the exit code, not the wording', async () => {
    const lying = await probeDependency('codex', execFrom({
      'codex --version': exited(0, 'codex-cli 0.155.1'),
      // Wording that says "error" everywhere, but a clean exit.
      'codex doctor': exited(0, 'error error FAILED not ok broken\n'),
    }));
    expect(lying.state).toBe('ok');

    const quiet = await probeDependency('codex', execFrom({
      'codex --version': exited(0, 'codex-cli 0.155.1'),
      // Reassuring wording, non-zero exit.
      'codex doctor': exited(2, 'All good! Everything is fine.\n'),
    }));
    expect(quiet.state).toBe('unhealthy');
  });

  it('keeps doctor output verbatim for the person to read', async () => {
    const check = await probeDependency('codex', execFrom({
      'codex --version': exited(0, 'codex-cli 0.155.1'),
      'codex doctor': exited(1, 'line one\nline two\n', 'a warning\n'),
    }));
    expect(check.doctor?.output).toContain('line one');
    expect(check.doctor?.output).toContain('line two');
    expect(check.doctor?.output).toContain('a warning');
  });

  it('caps doctor output rather than passing an unbounded string to the UI', async () => {
    const check = await probeDependency('codex', execFrom({
      'codex --version': exited(0, 'codex-cli 0.155.1'),
      'codex doctor': exited(0, 'x'.repeat(MAX_DOCTOR_OUTPUT_CHARS * 3)),
    }));
    expect(check.doctor!.output.length).toBeLessThanOrEqual(MAX_DOCTOR_OUTPUT_CHARS);
  });

  // Measured 2026-09-21 on this machine: `codex doctor` takes ~11s, every
  // run. A 2s bound (execFileSoft's) would report a perfectly healthy Codex
  // as timed out on every single launch.
  it('gives doctor a budget that fits the slowest real one', () => {
    expect(DOCTOR_TIMEOUT_MS).toBeGreaterThan(11_000);
    expect(VERSION_TIMEOUT_MS).toBeLessThan(DOCTOR_TIMEOUT_MS);
  });

  it('passes each probe its own timeout', async () => {
    const seen: { cmd: string; timeout: number }[] = [];
    await probeDependency('codex', async (bin, args, timeoutMs) => {
      seen.push({ cmd: [bin, ...args].join(' '), timeout: timeoutMs });
      return exited(0, 'x');
    });
    expect(seen).toEqual([
      { cmd: 'codex --version', timeout: VERSION_TIMEOUT_MS },
      { cmd: 'codex doctor', timeout: DOCTOR_TIMEOUT_MS },
    ]);
  });

  // A doctor that hangs says nothing about whether the binary runs: the
  // version probe already answered that. Warn and continue (design §8 Q2).
  it('treats a doctor that times out as unhealthy, never as missing', async () => {
    const check = await probeDependency('codex', execFrom({
      'codex --version': exited(0, 'codex-cli 0.155.1'),
      'codex doctor': { status: 'timeout' },
    }));
    expect(check.state).toBe('unhealthy');
    expect(check.version).toBe('codex-cli 0.155.1');
    expect(check.doctor?.state).toBe('timeout');
  });
});

describe('reading a version', () => {
  it('takes the first line only', () => {
    expect(firstLine('tmux 3.7c\nextra chatter\n')).toBe('tmux 3.7c');
  });

  it('is null when the binary printed nothing', async () => {
    const check = await probeDependency('tmux', execFrom({ 'tmux -V': exited(0, '   \n') }));
    expect(check.version).toBeNull();
    // Still ok: it exited cleanly. The version is recorded, never gated on
    // (design §3), so not knowing it costs nothing.
    expect(check.state).toBe('ok');
  });

  it('falls back to stderr, which is where some CLIs print their version', async () => {
    const check = await probeDependency('tmux', execFrom({ 'tmux -V': exited(0, '', 'tmux 3.7c\n') }));
    expect(check.version).toBe('tmux 3.7c');
  });

  it('caps a version line so a chatty binary cannot flood the UI', async () => {
    const check = await probeDependency('tmux', execFrom({ 'tmux -V': exited(0, 'v'.repeat(500)) }));
    expect(check.version!.length).toBeLessThanOrEqual(120);
  });

  it('treats a spawn failure that is not ENOENT as unhealthy, not missing', async () => {
    // e.g. the file is there but not executable. Saying "not installed"
    // would send the person to install something they already have.
    const check = await probeDependency('tmux', execFrom({
      'tmux -V': { status: 'failed', error: 'EACCES: permission denied' },
    }));
    expect(check.state).toBe('unhealthy');
    expect(check.detail).toContain('EACCES');
  });
});

describe('every dependency says what it is for and how to get it', () => {
  it.each([...DEPENDENCIES])('%s carries a purpose and an install command', async id => {
    const check = await probeDependency(id, execFrom({}));
    expect(check.purpose.length).toBeGreaterThan(0);
    expect(check.install.length).toBeGreaterThan(0);
    expect(check.name.length).toBeGreaterThan(0);
  });

  // The app installs nothing (design §5). Nothing here may be executed, so
  // nothing here is ever handed to a shell -- it is text with a copy button.
  it('never runs an install command', async () => {
    const calls: string[] = [];
    await runChecks({
      exec: async (bin, args) => { calls.push([bin, ...args].join(' ')); return { status: 'missing' }; },
      pathReady,
    });
    expect(calls.some(c => /brew|npm|curl|install/.test(c))).toBe(false);
  });
});

describe('degrading per capability, never refusing to start', () => {
  const readinessWith = (overrides: Record<string, ProbeRun>) => runChecks({
    exec: execFrom({
      'tmux -V': exited(0, 'tmux 3.7c'),
      'claude --version': exited(0, '2.1.278'),
      'claude doctor': exited(0, 'fine'),
      'codex --version': exited(0, 'codex-cli 0.155.1'),
      'codex doctor': exited(0, 'fine'),
      ...overrides,
    }),
    pathReady,
  });

  it('allows everything when all three are healthy', async () => {
    const r = await readinessWith({});
    expect(r.launch.claude.available).toBe(true);
    expect(r.launch.codex.available).toBe(true);
    expect(r.attach.available).toBe(true);
    expect(r.history.available).toBe(true);
  });

  // Design §4: no tmux means no launching and no attaching, but the history
  // the app has already indexed is still readable -- it opens read-only and
  // says why, rather than refusing to run.
  it('keeps history readable with no tmux, and says why the rest is off', async () => {
    const r = await readinessWith({ 'tmux -V': { status: 'missing' } });
    expect(r.attach.available).toBe(false);
    expect(r.launch.claude.available).toBe(false);
    expect(r.launch.codex.available).toBe(false);
    expect(r.history.available).toBe(true);
    expect(r.history.reason).toBeNull();
    // Disabled WITH a reason, never hidden (design §4).
    expect(r.attach.reason).toMatch(/tmux/i);
    expect(r.launch.claude.reason).toMatch(/tmux/i);
  });

  it('costs a missing provider exactly one launch option', async () => {
    const r = await readinessWith({ 'claude --version': { status: 'missing' } });
    expect(r.launch.claude.available).toBe(false);
    expect(r.launch.claude.reason).toMatch(/Claude/i);
    // The mirror image stays untouched.
    expect(r.launch.codex.available).toBe(true);
    expect(r.launch.codex.reason).toBeNull();
    expect(r.attach.available).toBe(true);
  });

  it('is the mirror image for a missing codex', async () => {
    const r = await readinessWith({ 'codex --version': { status: 'missing' } });
    expect(r.launch.codex.available).toBe(false);
    expect(r.launch.claude.available).toBe(true);
  });

  // Design §8 Q2, David's ruling: doctor is advisory, so the app is not
  // stricter than the tool. An unhealthy provider still launches; the
  // warning is attached, not enforced.
  it('still allows launching a provider whose doctor is unhappy', async () => {
    const r = await readinessWith({ 'codex doctor': exited(1, 'auth expired') });
    expect(byId(r.checks, 'codex').state).toBe('unhealthy');
    expect(r.launch.codex.available).toBe(true);
    // The reason rides along even though the capability is allowed, so the
    // UI can warn without disabling.
    expect(r.launch.codex.warning).toMatch(/codex/i);
  });

  it('reports all three dependencies whatever their state', async () => {
    const r = await readinessWith({ 'tmux -V': { status: 'missing' } });
    expect(r.checks.map(c => c.id)).toEqual([...DEPENDENCIES]);
  });

  it('derives capabilities from checks alone, with no second probe', () => {
    const checks: DependencyCheck[] = [
      { ...stub('tmux'), state: 'missing' },
      { ...stub('claude'), state: 'ok' },
      { ...stub('codex'), state: 'ok' },
    ];
    const caps = capabilitiesFor(checks);
    expect(caps.attach.available).toBe(false);
    expect(caps.history.available).toBe(true);
  });
});

/** A DependencyCheck with everything but `state` filled in -- for the pure
 *  capabilitiesFor test above, which cares about nothing else. */
function stub(id: 'tmux' | 'claude' | 'codex'): DependencyCheck {
  return {
    id, name: id, state: 'ok', version: null, purpose: 'x', install: 'x',
    doctor: null, detail: 'x',
  };
}

describe('the PATH must be resolved before anything is probed', () => {
  // Design §1/§2: without the login shell's PATH, every probe reports
  // "missing" on a machine where everything is installed. This is the one
  // ordering bug that would make the whole feature lie, so it is a
  // dependency runChecks states, not an order main happens to call things in.
  it('refuses to probe when the PATH step has not been started', async () => {
    await expect(runChecks({ exec: execFrom({}) })).rejects.toThrow(/PATH/i);
  });

  it('waits for a PATH resolution still in flight before spawning anything', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const exec = vi.fn<ProbeExec>(async () => exited(0, 'x'));

    const pending = runChecks({ exec, pathReady: () => gate });
    // Give the microtask queue every chance to run a probe early.
    await Promise.resolve();
    await Promise.resolve();
    expect(exec).not.toHaveBeenCalled();

    release();
    await pending;
    expect(exec).toHaveBeenCalled();
  });

  it('still reports rather than throwing when the PATH step itself failed', async () => {
    // applyLoginPath never throws -- it returns a 'failed' status and leaves
    // the inherited PATH alone. Checks must run against that shorter PATH
    // and report honestly, not refuse.
    const r = await runChecks({
      exec: execFrom({ 'tmux -V': exited(0, 'tmux 3.7c') }),
      pathReady: () => Promise.resolve(),
    });
    expect(byId(r.checks, 'tmux').state).toBe('ok');
    expect(byId(r.checks, 'claude').state).toBe('missing');
  });
});

// Everything above drives a FAKE exec, which proves the state machine but
// proves nothing about the adapter that has to produce those four outcomes
// from a real child process. These run real commands -- all of them
// built-ins that exist on any machine, none of them the three dependencies
// themselves, so this stays deterministic and fast.
describe('the real exec separates the four outcomes', () => {
  it('reports a clean exit with its output', async () => {
    const run = await defaultProbeExec('sh', ['-c', 'echo hello'], 5_000);
    expect(run).toEqual({ status: 'exited', code: 0, stdout: 'hello\n', stderr: '' });
  });

  it('reports a non-zero exit as exited, with the code and the output kept', async () => {
    const run = await defaultProbeExec('sh', ['-c', 'echo out; echo err >&2; exit 3'], 5_000);
    expect(run).toMatchObject({ status: 'exited', code: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  it('reports a binary that is not on PATH as missing', async () => {
    const run = await defaultProbeExec('llmws-definitely-not-a-real-binary', ['--version'], 5_000);
    expect(run).toEqual({ status: 'missing' });
  });

  it('reports a command killed on expiry as timeout, never as missing or exited', async () => {
    const run = await defaultProbeExec('sh', ['-c', 'sleep 30'], 250);
    expect(run).toEqual({ status: 'timeout' });
  });

  // A probe that inherits an open stdin waits on it. The version probes are
  // fast either way; this is about `doctor`, which is the one the app gives
  // a 20s budget and therefore the one that would sit there for 20s.
  it('does not wait on stdin', async () => {
    const run = await defaultProbeExec('cat', [], 2_000);
    expect(run).toEqual({ status: 'exited', code: 0, stdout: '', stderr: '' });
  });
});

describe('a run is a snapshot', () => {
  it('stamps when it ran, so Check again visibly produces a new answer', async () => {
    const r = await runChecks({ exec: execFrom({}), pathReady });
    expect(Date.parse(r.checkedAt)).not.toBeNaN();
  });

  it('probes the three dependencies concurrently, not one after another', async () => {
    let running = 0;
    let peak = 0;
    const exec: ProbeExec = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
      return exited(0, 'x');
    };
    await runChecks({ exec, pathReady });
    // Three dependencies in flight at once. Serial probing would make a
    // launch wait out `codex doctor`'s ~11s before saying anything at all.
    expect(peak).toBeGreaterThanOrEqual(3);
  });
});
