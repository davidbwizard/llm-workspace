// Since better-sqlite3 13 (2026-09-17) that package is a Node-API addon
// with a prebuilt binary that loads under both Node and Electron, so it
// normally passes both checks below without a rebuild. What follows was
// written when both addons were V8-direct, and still describes node-pty.
//
// better-sqlite3 and node-pty were both native addons (a real dlopen
// either way) compiled against
// one specific NODE_MODULE_VERSION -- the ABI of whichever V8/Node build
// they were built against. Plain Node and Electron embed different,
// incompatible V8 builds (verified on this machine: Node 24 is ABI 137,
// Electron 44 is ABI 149), so one compiled binary can only ever satisfy
// one of them. Loading it under the other does not fail at build time --
// it throws ERR_DLOPEN_FAILED the first time its native code is actually
// touched, so a stale binary looks fine right up until the app (or the
// test that touches it) runs. For better-sqlite3 that happens the first
// time a Database is actually constructed, not at `require` time; for
// node-pty it happens at `require`/`import` time itself, since its own
// index.js loads the native addon at module scope (see
// node_modules/node-pty/lib/unixTerminal.js) -- either way, each
// package's own `load()` below (see PACKAGES) is what actually touches
// it, and probeReport doesn't care which point that happens at.
//
// This script checks whether the binary CURRENTLY on disk, for EACH
// package below, loads under a given target runtime, and rebuilds from
// source only when it does not. Both packages compile from source (there
// is no prebuilt Electron binary for either here), so an unconditional
// rebuild on every `predev` and `pretest` would tax the dev/test loop for
// no reason the other ~99% of the time the ABI already matches.
//
// Usage:
//   node --experimental-strip-types scripts/check-native-abi.ts node
//   node --experimental-strip-types scripts/check-native-abi.ts electron
//
// Internal (re-invokes this same file under Electron's own runtime, via
// ELECTRON_RUN_AS_NODE, to ask "does the binary on disk load here" -- see
// probeReport()/the NATIVE_ABI_PROBE branch below). Only needed for the
// 'electron' target: the orchestrator already runs under plain Node, so
// the 'node' target probes in-process. PROBE_PKG tells the subprocess
// which package to probe, since there is more than one.
//   NATIVE_ABI_PROBE=1 PROBE_PKG=<name> node --experimental-strip-types scripts/check-native-abi.ts

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/** One native addon this app depends on, and how to check it. */
type NativePackage = {
  /** Used in log lines, and to route the Electron subprocess probe (see
   *  PROBE_PKG) back to the right package. */
  name: string;
  /** Relative to ROOT. */
  pkgDir: string;
  /** Relative to pkgDir -- gates MISSING vs FAIL, same as before this
   *  script covered more than one package. Omitted when the package picks
   *  its own binary at load time (better-sqlite3 13's per-platform
   *  prebuilds), where only loading it can say whether it works. */
  addonPath?: string;
  /** Touches the native addon currently on disk, under whatever runtime
   *  this runs in, with no OTHER observable side effect -- constructing
   *  against ':memory:' for better-sqlite3 (no filesystem side effect),
   *  and merely importing for node-pty, whose own module-scope require of
   *  the addon (see this file's header comment) is the dlopen itself, with
   *  nothing further to trigger. Must let a real ABI-mismatch error
   *  propagate; probeReport is what turns that into a report string. */
  load(): Promise<void>;
};

const PACKAGES: NativePackage[] = [
  {
    name: 'better-sqlite3',
    pkgDir: `${ROOT}node_modules/better-sqlite3`,
    async load() {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(':memory:');
      db.close();
    },
  },
  {
    name: 'node-pty',
    pkgDir: `${ROOT}node_modules/node-pty`,
    addonPath: 'build/Release/pty.node',
    async load() {
      await import('node-pty');
    },
  },
];

/** Try to actually load the addon currently on disk for `pkg`, under
 *  whatever runtime this function runs in. Returns a report string rather
 *  than throwing -- 'OK <abi>', 'FAIL <compiledAbi> <requiredAbi>', or
 *  'MISSING' -- so both the in-process (Node) and subprocess (Electron,
 *  via runElectronProbe() below) callers can read the same shape. */
async function probeReport(pkg: NativePackage): Promise<string> {
  if (pkg.addonPath && !existsSync(`${pkg.pkgDir}/${pkg.addonPath}`)) return 'MISSING';
  try {
    await pkg.load();
    return `OK ${process.versions.modules}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "compiled against ... NODE_MODULE_VERSION 149 ... requires
    // NODE_MODULE_VERSION 137" -- both numbers are worth surfacing, but
    // only the mismatch itself (not this exact wording) is load-bearing;
    // an addon missing or broken for any other reason also means rebuild.
    const compiled = message.match(/using\s+NODE_MODULE_VERSION\s+(\d+)/)?.[1] ?? 'unknown';
    const required = message.match(/requires\s+NODE_MODULE_VERSION\s+(\d+)/)?.[1] ?? String(process.versions.modules);
    return `FAIL ${compiled} ${required}`;
  }
}

if (process.env.NATIVE_ABI_PROBE === '1') {
  // Subprocess mode: print the report for the orchestrator (running as a
  // separate, plain-Node process) to read from stdout.
  const pkg = PACKAGES.find(p => p.name === process.env.PROBE_PKG);
  if (!pkg) {
    console.error(`[native-abi] probe subprocess got an unknown package ${JSON.stringify(process.env.PROBE_PKG)}`);
    process.exit(1);
  }
  console.log(await probeReport(pkg));
  process.exit(0);
}

// --- orchestrator --------------------------------------------------------

const target = process.argv[2];
if (target !== 'node' && target !== 'electron') {
  console.error(`[native-abi] usage: check-native-abi.ts <node|electron> (got ${JSON.stringify(target)})`);
  process.exit(1);
}

/** Runs the probe under the local Electron binary via ELECTRON_RUN_AS_NODE
 *  (so it behaves like Node instead of opening a GUI) -- the only way to
 *  ask Electron's actual V8 ABI without a hardcoded version table that
 *  goes stale the next time either dependency is bumped. */
function runElectronProbe(execPath: string, pkgName: string): string {
  return execFileSync(
    execPath,
    ['--experimental-strip-types', THIS_FILE],
    {
      env: { ...process.env, NATIVE_ABI_PROBE: '1', ELECTRON_RUN_AS_NODE: '1', PROBE_PKG: pkgName },
      encoding: 'utf8',
    },
  ).trim();
}

function electronBinPath(): string {
  // Requiring 'electron' from plain Node resolves to the path of the
  // local Electron executable, not the API -- that is the package's
  // documented contract for exactly this use (electron-builder and
  // electron-rebuild both rely on it the same way).
  return execFileSync(
    process.execPath, ['-e', "process.stdout.write(require('electron'))"],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
}

function electronVersion(): string {
  return execFileSync(
    process.execPath, ['-e', "process.stdout.write(require('electron/package.json').version)"],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
}

// Computed once, outside the per-package loop below, rather than once per
// package -- both spawn a subprocess, and the answer is the same for every
// package in this run.
const cachedElectronBinPath = target === 'electron' ? electronBinPath() : null;
const cachedElectronVersion = target === 'electron' ? electronVersion() : null;

const nodeGyp = `${ROOT}node_modules/.bin/node-gyp`;

for (const pkg of PACKAGES) {
  const start = performance.now();

  const report = target === 'node'
    ? await probeReport(pkg)
    : runElectronProbe(cachedElectronBinPath!, pkg.name);

  const [status, a, b] = report.split(' ');
  const probeMs = Math.round(performance.now() - start);

  if (status === 'OK') {
    console.log(`[native-abi] ${pkg.name} already built for ${target} (ABI ${a}, checked in ${probeMs}ms)`);
    continue;
  }

  if (status === 'MISSING') {
    console.log(`[native-abi] ${pkg.name} has no compiled addon yet -- building for ${target}...`);
  } else {
    console.log(`[native-abi] ${pkg.name} is built for ABI ${a}, ${target} needs ABI ${b} -- rebuilding...`);
  }

  const buildArgs = ['rebuild', '--release'];
  if (target === 'electron') {
    buildArgs.push(
      `--target=${cachedElectronVersion}`,
      '--dist-url=https://electronjs.org/headers',
      `--arch=${process.arch}`,
    );
  }

  const buildStart = performance.now();
  execFileSync(nodeGyp, buildArgs, { cwd: pkg.pkgDir, stdio: 'inherit' });
  const buildMs = Math.round(performance.now() - buildStart);
  console.log(`[native-abi] rebuilt ${pkg.name} for ${target} in ${buildMs}ms`);
}
