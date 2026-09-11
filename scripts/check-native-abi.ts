// better-sqlite3 is a native addon (V8-direct, not Node-API) compiled
// against one specific NODE_MODULE_VERSION -- the ABI of whichever V8/Node
// build it was built against. Plain Node and Electron embed different,
// incompatible V8 builds (verified on this machine: Node 24 is ABI 137,
// Electron 44 is ABI 149), so one compiled binary can only ever satisfy
// one of them. Loading it under the other does not fail at build time --
// it throws ERR_DLOPEN_FAILED the first time a Database is actually
// constructed, not at `require` time, so a stale binary looks fine right
// up until the app (or the test that touches it) runs.
//
// This script checks whether the binary CURRENTLY on disk loads under a
// given target runtime, and rebuilds from source only when it does not.
// better-sqlite3 compiles from source (there is no prebuilt Electron
// binary for it here), so an unconditional rebuild on every `predev` and
// `pretest` would tax the dev/test loop for no reason the other ~99% of
// the time the ABI already matches.
//
// Usage:
//   node --experimental-strip-types scripts/check-native-abi.ts node
//   node --experimental-strip-types scripts/check-native-abi.ts electron
//
// Internal (re-invokes this same file under Electron's own runtime, via
// ELECTRON_RUN_AS_NODE, to ask "does the binary on disk load here" -- see
// probe() below). Only needed for the 'electron' target: the orchestrator
// already runs under plain Node, so the 'node' target probes in-process.
//   NATIVE_ABI_PROBE=1 node --experimental-strip-types scripts/check-native-abi.ts

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_DIR = `${ROOT}node_modules/better-sqlite3`;
const ADDON_PATH = `${PKG_DIR}/build/Release/better_sqlite3.node`;
const THIS_FILE = fileURLToPath(import.meta.url);

/** Try to actually construct a Database from the addon currently on disk,
 *  under whatever runtime this function runs in. Returns a report string
 *  rather than throwing -- 'OK <abi>', 'FAIL <compiledAbi> <requiredAbi>',
 *  or 'MISSING' -- so both the in-process (Node) and subprocess (Electron,
 *  via probe() below) callers can read the same shape. Constructing
 *  against ':memory:' has no filesystem side effect, so this is safe to
 *  run speculatively. */
async function probeReport(): Promise<string> {
  if (!existsSync(ADDON_PATH)) return 'MISSING';
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
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
  console.log(await probeReport());
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
function runElectronProbe(execPath: string): string {
  return execFileSync(
    execPath,
    ['--experimental-strip-types', THIS_FILE],
    {
      env: { ...process.env, NATIVE_ABI_PROBE: '1', ELECTRON_RUN_AS_NODE: '1' },
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

const start = performance.now();

const report = target === 'node'
  ? await probeReport()
  : runElectronProbe(electronBinPath());

const [status, a, b] = report.split(' ');
const probeMs = Math.round(performance.now() - start);

if (status === 'OK') {
  console.log(`[native-abi] better-sqlite3 already built for ${target} (ABI ${a}, checked in ${probeMs}ms)`);
  process.exit(0);
}

if (status === 'MISSING') {
  console.log(`[native-abi] better-sqlite3 has no compiled addon yet -- building for ${target}...`);
} else {
  console.log(`[native-abi] better-sqlite3 is built for ABI ${a}, ${target} needs ABI ${b} -- rebuilding...`);
}

const nodeGyp = `${ROOT}node_modules/.bin/node-gyp`;
const buildArgs = ['rebuild', '--release'];
if (target === 'electron') {
  const electronVersion = execFileSync(
    process.execPath, ['-e', "process.stdout.write(require('electron/package.json').version)"],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  buildArgs.push(
    `--target=${electronVersion}`,
    '--dist-url=https://electronjs.org/headers',
    `--arch=${process.arch}`,
  );
}

const buildStart = performance.now();
execFileSync(nodeGyp, buildArgs, { cwd: PKG_DIR, stdio: 'inherit' });
const buildMs = Math.round(performance.now() - buildStart);
console.log(`[native-abi] rebuilt for ${target} in ${buildMs}ms`);
