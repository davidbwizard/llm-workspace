// What this app needs on the machine, and whether it is actually there.
//
// Design: docs/superpowers/specs/2026-09-21-first-run-checks-design.md §3-§5.
//
// Three dependencies, each with a free, local, non-prompting probe. NO PROBE
// MAY EVER SEND A PROMPT TO A MODEL -- every command named in DEFINITIONS
// below is `--version` or `doctor`, both of which are local and cost
// nothing. The list is pinned by a test (tests/main/checks.test.ts), so
// adding a command here is a deliberate edit to that list rather than
// something that slips in.
//
// Two rules shape everything else in this file:
//
//   - The four outcomes stay apart. "present and healthy", "present but
//     broken", "not installed" and "did not answer" are four different
//     sentences to a person, and collapsing any two of them turns a first-run
//     screen into a screen that lies. So `state` has four values, not a
//     boolean, and each carries its own `detail` sentence.
//   - `doctor` is a SIGNAL, not a data source (design §3). Its exit code is
//     used; its output is kept verbatim for the person to read and is never
//     parsed for meaning. It is a human-facing diagnostic whose wording will
//     change, and an app that reads state out of its phrasing becomes wrong
//     silently on the next release of a tool it does not own.
import { execFile } from 'node:child_process';
import type { Provider } from '../core/types.ts';
import { whenLoginPathApplied } from './loginPath.ts';

export const DEPENDENCIES = ['tmux', 'claude', 'codex'] as const;
export type DependencyId = typeof DEPENDENCIES[number];

/** The version probe's budget. The same 2s execFileSoft (src/discovery/live.ts)
 *  gives every other shell-out in this app: `tmux -V`, `claude --version` and
 *  `codex --version` measured 5ms, 12ms and 39ms on this machine, so 2s is
 *  already two orders of magnitude of headroom. */
export const VERSION_TIMEOUT_MS = 2_000;

/** doctor's budget, and the reason it is not execFileSoft's 2s.
 *
 *  Measured 2026-09-21 on this machine, three consecutive runs: `codex
 *  doctor` took 11.3s, 11.1s and 11.1s -- it inspects the macOS unified
 *  security log among other things. `claude doctor` took ~0.5s. A 2s bound
 *  would therefore report a perfectly healthy Codex install as "timed out"
 *  on every single launch, which is exactly the kind of confident wrong
 *  answer the four-state split exists to prevent. 20s leaves room for a
 *  slower machine without ever becoming an unbounded wait. */
export const DOCTOR_TIMEOUT_MS = 20_000;

/** doctor output is shown to the person, so it is kept whole where it can
 *  be -- `codex doctor` emits ~9,000 characters here, which fits. The cap
 *  exists so a future tool that decides to print a megabyte cannot put a
 *  megabyte through IPC and into the DOM. */
export const MAX_DOCTOR_OUTPUT_CHARS = 16_000;

/** A version string is one short line. Anything longer is a binary being
 *  chatty, not a version. */
const MAX_VERSION_CHARS = 120;

/** One command's outcome, with the four cases kept apart at the boundary
 *  rather than flattened and guessed at afterwards. This is deliberately
 *  NOT execFileSoft's shape: execFileSoft returns '' for a missing binary,
 *  a non-zero exit AND a timeout alike, which is exactly the collapse this
 *  module must not make. */
export type ProbeRun =
  | { status: 'exited'; code: number; stdout: string; stderr: string }
  /** ENOENT: nothing of that name on PATH. */
  | { status: 'missing' }
  /** Killed on expiry. The binary exists; it did not answer. */
  | { status: 'timeout' }
  /** Any other spawn failure -- EACCES on a non-executable file, and so on. */
  | { status: 'failed'; error: string };

export type ProbeExec = (bin: string, args: string[], timeoutMs: number) => Promise<ProbeRun>;

export type CheckState =
  /** Present, and its own doctor (where it has one) exited 0. */
  | 'ok'
  /** Present -- the version probe answered -- but doctor is unhappy, did not
   *  finish, or the binary could not be spawned for a reason other than
   *  being absent. Present-but-broken, never "go install it". */
  | 'unhealthy'
  /** Not on this process's PATH at all. */
  | 'missing'
  /** The version probe itself was killed on expiry: nothing is known. */
  | 'timeout';

export interface DoctorReport {
  state: 'ok' | 'unhealthy' | 'timeout' | 'failed';
  /** null when doctor never exited (timed out, or failed to spawn). */
  exitCode: number | null;
  /** Verbatim, capped, never parsed -- see this file's header. */
  output: string;
}

/** Where to get Homebrew, for a Mac that has not got it. Shown as a link,
 *  never as a command: Homebrew's own install line is a pipe-to-shell, and
 *  this app does not put one of those in front of anyone. Sending someone
 *  to the project's own page lets them read it first. */
export const HOMEBREW_URL = 'https://brew.sh';

/** One confirmed way to install a dependency.
 *
 *  A list, in preference order, rather than a single string, because
 *  "`brew install x`" is useless advice on a Mac without Homebrew -- and
 *  telling someone to install a package manager is a bigger ask than this
 *  app should make casually. `requires` is what makes that visible: the UI
 *  shows a route whose requirement is met as a command to run, and one
 *  whose requirement is missing as a command that needs something first.
 *
 *  Every command here is verified (see DEFINITIONS below), and none of them
 *  is a pipe-to-shell. An unverified `curl ... | sh` is the worst kind of
 *  command to get wrong, so this app ships none. */
export interface InstallRoute {
  command: string;
  /** What must already be on the machine. null when it stands on its own. */
  requires: 'homebrew' | null;
  /** One line of context -- a prerequisite, or which one the vendor
   *  recommends. null when the command needs no explaining. */
  note: string | null;
}

export interface DependencyCheck {
  id: DependencyId;
  /** What a person calls it. */
  name: string;
  state: CheckState;
  /** Recorded, never gated on: a minimum version is a promise this app
   *  cannot keep, having been tested against exactly one of each (design
   *  §3). null when the binary printed nothing recognisable. */
  version: string | null;
  /** One line on what the app needs it for. */
  purpose: string;
  /** Confirmed ways to install it, best first. SHOWN, with a copy button,
   *  and never executed -- the app installs nothing (design §5). */
  install: InstallRoute[];
  doctor: DoctorReport | null;
  /** This state, as one sentence a person can read. Also what a disabled
   *  control shows as its reason, so the two can never disagree. */
  detail: string;
}

/** One thing the app can do, and whether it can do it right now.
 *
 *  `reason` and `warning` are deliberately separate. A capability that is
 *  OFF carries a reason and is disabled-with-that-reason attached, never
 *  hidden (design §4): a control that vanished teaches the person nothing,
 *  one that explains itself teaches them what to install. A capability that
 *  is ON but doubtful carries a warning and stays usable -- doctor is
 *  advisory, and this app is not stricter than the tool it is reporting on
 *  (design §8 Q2, David's ruling). */
export interface Capability {
  available: boolean;
  reason: string | null;
  warning: string | null;
}

export interface Readiness {
  /** ISO timestamp, so Check again visibly produces a new answer rather
   *  than appearing to do nothing when nothing changed. */
  checkedAt: string;
  checks: DependencyCheck[];
  launch: Record<Provider, Capability>;
  /** Attaching to a session that is already running. tmux, same as launch. */
  attach: Capability;
  /** Reading the history this app has already indexed. Never gated on
   *  anything: it is sqlite and files on disk, and it is what makes a
   *  machine with no tmux open read-only instead of refusing to run. */
  history: Capability;
  /** Whether Homebrew is on the resolved PATH. NOT a dependency of this
   *  app -- a dependency of the ADVICE it gives, so the pre-check can
   *  avoid printing a `brew` command to a Mac that has no brew as though
   *  it would work. False when the probe could not confirm it, which is
   *  the conservative direction: being told about a prerequisite you
   *  already have costs a sentence, the other way round costs a dead end. */
  homebrew: boolean;
}

interface Definition {
  id: DependencyId;
  bin: string;
  name: string;
  purpose: string;
  install: InstallRoute[];
  /** null where the tool has no doctor. For tmux this is not an omission:
   *  inventing a health check for it would mean starting a tmux SERVER on a
   *  machine that has none, which is the opposite of a read-only probe. */
  doctorArgs: string[] | null;
  versionArgs: string[];
}

/** The install routes shown (never run) for anything missing.
 *
 *  Homebrew first for all three, deliberately: it is one idiom rather than
 *  three, and it is the route confirmed working on this machine. Where a
 *  vendor documents a second route that does NOT need Homebrew, it is
 *  offered as well, so a Mac without brew is not simply stuck.
 *
 *  Every command verified 2026-09-21 rather than recalled:
 *  - `tmux` is a Homebrew formula (`brew info --formula tmux` -> 3.7c).
 *  - `claude-code` is the cask documented at code.claude.com/docs/en/setup,
 *    alongside the npm package and the native `curl | bash` installer. The
 *    vendor recommends the native installer (it auto-updates; the cask does
 *    not), but this app does not put a pipe-to-shell in front of anyone, so
 *    the two non-piping routes are what is offered.
 *  - `codex` is a cask, confirmed against the copy installed here:
 *    /opt/homebrew/Caskroom/codex/0.155.1, from github.com/openai/codex. A
 *    sub-agent reported this as unconfirmed and guessed the project might
 *    not be maintained; that was wrong, and the cask was checked directly.
 *    No `curl | sh` route is offered for Codex because none was verified.
 *
 *  Nothing goes in this list that has not been confirmed. A first-run
 *  screen that prints a command which does not work is worse than one that
 *  says plainly that it does not know. */
const DEFINITIONS: Record<DependencyId, Definition> = {
  tmux: {
    id: 'tmux', bin: 'tmux', name: 'tmux',
    purpose: 'Runs every session this app starts, and is how it attaches to one.',
    install: [{ command: 'brew install tmux', requires: 'homebrew', note: null }],
    versionArgs: ['-V'], doctorArgs: null,
  },
  claude: {
    id: 'claude', bin: 'claude', name: 'Claude Code',
    purpose: 'The Claude agent this app launches and talks to.',
    install: [
      { command: 'brew install --cask claude-code', requires: 'homebrew', note: null },
      {
        command: 'npm install -g @anthropic-ai/claude-code',
        requires: null,
        note: 'Needs Node.js 22 or later.',
      },
    ],
    versionArgs: ['--version'], doctorArgs: ['doctor'],
  },
  codex: {
    id: 'codex', bin: 'codex', name: 'Codex',
    purpose: 'The Codex agent this app launches and talks to.',
    install: [{ command: 'brew install --cask codex', requires: 'homebrew', note: null }],
    versionArgs: ['--version'], doctorArgs: ['doctor'],
  },
};

/** The first non-empty line, trimmed and capped. Every `--version` this app
 *  runs answers on one line; anything after it is the binary being chatty. */
export function firstLine(raw: string): string {
  return (raw.split('\n').find(l => l.trim().length > 0) ?? '').trim().slice(0, MAX_VERSION_CHARS);
}

function cap(raw: string): string {
  return raw.length <= MAX_DOCTOR_OUTPUT_CHARS
    ? raw
    : `${raw.slice(0, MAX_DOCTOR_OUTPUT_CHARS - 1)}…`;
}

/** The real exec. Separate from execFileSoft (src/discovery/live.ts) on
 *  purpose: execFileSoft's contract is "fail soft to an empty string", which
 *  makes a missing binary, a broken one and a hung one indistinguishable.
 *  That is the right contract for discovery, where the answer is a list of
 *  processes and an empty one is meaningful. It is the wrong contract here,
 *  where the whole product IS which of those three happened.
 *
 *  Same bounding discipline, though: an explicit timeout with SIGKILL on
 *  expiry, stdin closed immediately so nothing can block waiting on input,
 *  and a bounded maxBuffer. Never throws. */
export async function defaultProbeExec(bin: string, args: string[], timeoutMs: number): Promise<ProbeRun> {
  return new Promise<ProbeRun>(resolve => {
    const child = execFile(
      bin, args,
      { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errOut = typeof stderr === 'string' ? stderr : '';
        if (!err) return resolve({ status: 'exited', code: 0, stdout: out, stderr: errOut });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null };
        // Killed on expiry: a signal and no numeric exit code. Checked
        // BEFORE the numeric-code branch, since a killed process can also
        // surface a code on some platforms.
        if (e.killed === true || (e.signal != null && typeof e.code !== 'number')) {
          return resolve({ status: 'timeout' });
        }
        if (e.code === 'ENOENT') return resolve({ status: 'missing' });
        if (typeof e.code === 'number') {
          return resolve({ status: 'exited', code: e.code, stdout: out, stderr: errOut });
        }
        return resolve({ status: 'failed', error: String(e.code ?? e.message) });
      },
    );
    // A probe must never sit waiting on input. `doctor` does not read stdin
    // today; closing it means a future version that does fails fast instead
    // of holding the handle until the timeout expires.
    child.stdin?.end();
  });
}

/** One dependency, fully probed. `--version` first and alone decides whether
 *  the binary is THERE -- doctor is only ever asked once that has answered,
 *  so a missing tool costs one spawn rather than two, and a doctor result
 *  can never be mistaken for evidence of presence. */
export async function probeDependency(id: DependencyId, exec: ProbeExec = defaultProbeExec): Promise<DependencyCheck> {
  const def = DEFINITIONS[id];
  const base = { id, name: def.name, purpose: def.purpose, install: def.install };

  const version = await exec(def.bin, def.versionArgs, VERSION_TIMEOUT_MS);

  if (version.status === 'missing') {
    return {
      ...base, state: 'missing', version: null, doctor: null,
      detail: `${def.name} is not installed, or is not on the PATH this app can see.`,
    };
  }
  if (version.status === 'timeout') {
    return {
      ...base, state: 'timeout', version: null, doctor: null,
      detail: `${def.name} did not answer within ${VERSION_TIMEOUT_MS / 1000}s, so the app cannot tell whether it works.`,
    };
  }
  if (version.status === 'failed') {
    return {
      ...base, state: 'unhealthy', version: null, doctor: null,
      detail: `${def.name} is on the PATH but could not be run: ${version.error}.`,
    };
  }
  if (version.code !== 0) {
    return {
      ...base, state: 'unhealthy', version: null, doctor: null,
      detail: `${def.name} is installed but exited with code ${version.code} when asked for its version.`,
    };
  }

  // Present. stderr is the fallback because some CLIs print their version
  // there; the exit code above already said this run succeeded.
  const line = firstLine(version.stdout) || firstLine(version.stderr);
  const found = line.length > 0 ? line : null;

  if (def.doctorArgs === null) {
    return { ...base, state: 'ok', version: found, doctor: null, detail: `${def.name} is installed and ready.` };
  }

  const doctor = await exec(def.bin, def.doctorArgs, DOCTOR_TIMEOUT_MS);
  const report = reportFor(doctor);
  if (report.state === 'ok') {
    return { ...base, state: 'ok', version: found, doctor: report, detail: `${def.name} is installed and its own check passed.` };
  }
  return { ...base, state: 'unhealthy', version: found, doctor: report, detail: detailForDoctor(def.name, report) };
}

function reportFor(run: ProbeRun): DoctorReport {
  if (run.status === 'exited') {
    return {
      state: run.code === 0 ? 'ok' : 'unhealthy',
      exitCode: run.code,
      // Both streams, in the order a terminal would have interleaved them
      // closely enough for reading. Verbatim: never parsed (see the header).
      output: cap([run.stdout, run.stderr].filter(s => s.trim().length > 0).join('\n').trim()),
    };
  }
  if (run.status === 'timeout') {
    return { state: 'timeout', exitCode: null, output: '' };
  }
  // 'missing' here means the binary vanished between the version probe and
  // this one, or has no such subcommand path -- either way it is a failure
  // of the check, not evidence the tool is absent (the version probe already
  // answered that).
  return { state: 'failed', exitCode: null, output: run.status === 'failed' ? run.error : '' };
}

function detailForDoctor(name: string, report: DoctorReport): string {
  if (report.state === 'timeout') {
    return `${name} is installed, but its own check did not finish within ${DOCTOR_TIMEOUT_MS / 1000}s.`;
  }
  if (report.state === 'failed') {
    return `${name} is installed, but its own check could not be run: ${report.output || 'unknown error'}.`;
  }
  return `${name} is installed, but its own check reported a problem (exit ${report.exitCode}).`;
}

/** Present enough to use. `unhealthy` counts: the binary answered, doctor is
 *  advisory, and this app does not get to be stricter than the tool it is
 *  reporting on. `timeout` does not: nothing answered, so nothing is known,
 *  and offering a control that will probably hang is worse than offering one
 *  that explains itself. */
function usable(check: DependencyCheck): boolean {
  return check.state === 'ok' || check.state === 'unhealthy';
}

function capabilityFrom(required: DependencyCheck[]): Capability {
  const blocked = required.filter(c => !usable(c));
  if (blocked.length > 0) {
    return { available: false, reason: blocked.map(c => c.detail).join(' '), warning: null };
  }
  const doubtful = required.filter(c => c.state === 'unhealthy');
  return {
    available: true,
    reason: null,
    warning: doubtful.length > 0 ? doubtful.map(c => c.detail).join(' ') : null,
  };
}

/** Capabilities from the checks alone -- no second probe, so what the UI
 *  disables can never disagree with what the screen says is missing. */
export function capabilitiesFor(checks: DependencyCheck[]): Omit<Readiness, 'checkedAt' | 'checks' | 'homebrew'> {
  const find = (id: DependencyId) => checks.find(c => c.id === id)!;
  const tmux = find('tmux');
  return {
    // Design §4: a missing tool costs exactly one capability. Launching
    // needs tmux AND that provider; attaching needs tmux alone.
    launch: {
      claude: capabilityFrom([tmux, find('claude')]),
      codex: capabilityFrom([tmux, find('codex')]),
    },
    attach: capabilityFrom([tmux]),
    // Never gated. The app opens read-only and says why, rather than
    // refusing to run (design §4).
    history: { available: true, reason: null, warning: null },
  };
}

export type CheckDeps = {
  exec?: ProbeExec;
  /** The PATH repair, as something to await. Defaults to the real one --
   *  see whenLoginPathApplied (src/main/loginPath.ts) for why this is a
   *  stated dependency rather than an assumed ordering. */
  pathReady?: () => Promise<unknown>;
  now?: () => Date;
};

/** Is Homebrew on the resolved PATH? Its own probe, not a DependencyCheck:
 *  this app does not need Homebrew, it only needs to know whether the
 *  advice it is about to give is advice this machine can act on.
 *
 *  `brew --version` measured 20ms here -- local, free, and nowhere near
 *  worth its own timeout constant. Anything but a clean exit reads as "not
 *  there", including a timeout: see Readiness.homebrew for why that
 *  direction is the safe one. */
async function probeHomebrew(exec: ProbeExec): Promise<boolean> {
  const run = await exec('brew', ['--version'], VERSION_TIMEOUT_MS);
  return run.status === 'exited' && run.code === 0;
}

/** One full pass. Awaits the PATH repair FIRST, then probes everything
 *  concurrently: `codex doctor` alone is ~11s, and running these in series
 *  would make that the floor for the whole screen. */
export async function runChecks(deps: CheckDeps = {}): Promise<Readiness> {
  await (deps.pathReady ?? whenLoginPathApplied)();
  const exec = deps.exec ?? defaultProbeExec;
  const [checks, homebrew] = await Promise.all([
    Promise.all(DEPENDENCIES.map(id => probeDependency(id, exec))),
    probeHomebrew(exec),
  ]);
  return {
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    checks,
    ...capabilitiesFor(checks),
    homebrew,
  };
}
