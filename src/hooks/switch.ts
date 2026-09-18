import {
  existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync,
  renameSync, openSync, closeSync, fsyncSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildHookFragments, planInstall, applyInstall, uninstall, SettingsChangedError, type Manifest,
} from './install.ts';
import { probeCapabilities, type Paths } from '../config.ts';

/** Quick answers design §4. `hooksState`/`setHooks` are the whole surface
 *  the Settings switch (and its `hooks:get`/`hooks:set` IPC channels) needs
 *  -- everything else here is a private implementation detail. */
export interface HooksResult { installed: boolean; error: string | null }

/** A stable location the app's own hooks always point at, independent of
 *  where the app itself is installed (spec §4): "the app's own location can
 *  then change without leaving hooks that point at a missing script." */
export function stableHelperPath(home: string): string {
  return join(home, '.llm-workspace/bin/helper.sh');
}

/** `paths.claudeSettings` is always `<home>/.claude/settings.json`
 *  (config.ts's resolvePaths) -- two `dirname`s recover `home` without
 *  needing a dedicated field on Paths that no other caller needs. */
function homeOf(paths: Paths): string {
  return dirname(dirname(paths.claudeSettings));
}

/** The exact command string our own install writes for the stable path --
 *  reuses buildHookFragments's quoting rule rather than re-deriving it.
 *  Every fragment it returns shares the same command, so any one will do. */
function stableCommand(stable: string): string {
  return buildHookFragments(stable)[0]!.command;
}

/** Copies `source` to `dest` as a temp file in dest's own directory,
 *  fsynced, then renamed over -- the same discipline as install.ts's own
 *  atomic settings.json write, so a crash mid-copy can never leave a
 *  partially-written helper script for a hook to run mid-write. */
function copyHelperAtomic(source: string, dest: string): void {
  const dir = dirname(dest);
  const data = readFileSync(source);
  const tmp = join(dir, `.helper.sh.llmws.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, dest);
}

/** mkdirSync's `mode` is only honoured when it actually creates the
 *  directory -- an already-existing, looser bin directory (e.g. left over
 *  from before this app enforced 0700) would otherwise keep its old mode
 *  forever. The explicit chmod makes this idempotent regardless. */
function ensureBinDir(stable: string): void {
  const dir = dirname(stable);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

const PARSE_ERROR = 'settings.json is not valid JSON -- fix it by hand, then try again.';

/** Step 3's exact order: mkdir bin 0700, copy the helper atomically, THEN
 *  read/parse settings.json -- a parse failure must still leave
 *  settings.json completely untouched, but the helper copy (our own
 *  app-owned file, not the user's config) is safe to write regardless. */
function doInstall(settingsPath: string, stable: string, helperSource: string): string | null {
  try {
    ensureBinDir(stable);
    copyHelperAtomic(helperSource, stable);
  } catch (e) {
    return `Could not install the helper script: ${(e as Error).message}`;
  }

  // A fresh home may not even have ~/.claude yet -- only settings.json
  // itself is allowed to be "missing" per spec; its parent directory is
  // created here so writing it is never blocked on that.
  mkdirSync(dirname(settingsPath), { recursive: true });

  // Only a missing file is "missing" (final review I3): an unreadable one
  // is refused here, before anything is planned or written.
  let baseText = '';
  try {
    baseText = readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `Could not read settings.json: ${(e as Error).message}`;
    }
  }

  let parsed: unknown = {};
  if (baseText !== '') {
    try { parsed = JSON.parse(baseText); }
    catch { return PARSE_ERROR; }
  }

  const plan = planInstall(parsed, buildHookFragments(stable));
  try {
    applyInstall(settingsPath, { ...plan, baseText });
  } catch (e) {
    // Only the changed-on-disk refusal is "try again" (final review I5);
    // anything else is shown with its real cause.
    if (e instanceof SettingsChangedError) return 'Settings changed while installing -- try again';
    return `Could not write settings.json: ${(e as Error).message}`;
  }
  return null;
}

/** The command string is fixed (the stable path never changes), so no
 *  stored manifest is needed to reconstruct it -- spec §4 "Off". */
function doUninstall(settingsPath: string, stable: string): string | null {
  const manifest: Manifest = { owned: [], command: stableCommand(stable) };
  try {
    uninstall(settingsPath, manifest);
  } catch (e) {
    // uninstall() itself tolerates a missing file. Only a real JSON parse
    // failure is the not-valid-JSON message (final review I5); a read or
    // write failure is shown with its real cause.
    if (e instanceof SyntaxError) return PARSE_ERROR;
    return `Could not update settings.json: ${(e as Error).message}`;
  }
  return null;
}

/** The switch's own read: always the real, freshly-probed state, never
 *  cached UI state -- spec §4, "re-read each time Settings opens, so a hand
 *  edit cannot make it lie." probeCapabilities already treats an
 *  unparseable or missing settings.json as "not installed", which is
 *  exactly the conservative answer this needs too. */
export function hooksState(paths: Paths): HooksResult {
  return { installed: probeCapabilities(paths).hooksInstalled, error: null };
}

/** Flips the switch. `helperSource` is the caller's copy of
 *  src/hooks/helper.sh to install FROM (main resolves this via
 *  app.getAppPath(); kept as a parameter here so this stays testable
 *  against a temp file and never assumes the app's own real install
 *  location).
 *
 *  The returned `installed` always comes from re-probing the file
 *  (hooksState), never from which branch ran or whether it "succeeded" --
 *  the one thing this must never do is claim a state the file itself
 *  doesn't show. That already gives the two failure modes spec §4 calls
 *  out their required behaviour for free: an unparseable settings.json and
 *  applyInstall's changed-on-disk refusal both leave hooksInstalled false,
 *  the same way probeCapabilities already treats "can't confirm" as "not
 *  installed" everywhere else. */
export function setHooks(paths: Paths, on: boolean, helperSource: string): HooksResult {
  const stable = stableHelperPath(homeOf(paths));
  const error = on
    ? doInstall(paths.claudeSettings, stable, helperSource)
    : doUninstall(paths.claudeSettings, stable);
  return { installed: hooksState(paths).installed, error };
}

/** Spec §4: "On every app start with hooks installed, refresh the copy if
 *  its content differs." Touches only the stable helper file, never
 *  settings.json, so an app update with a changed helper.sh does not leave
 *  a stale copy running in every session, without rewriting the user's
 *  config on every launch just to check. Best-effort: any failure here
 *  (e.g. the bundled helperSource is missing) is logged, never thrown --
 *  this runs during app startup and must not be able to block it. */
export function refreshHelperIfInstalled(paths: Paths, helperSource: string): void {
  if (!hooksState(paths).installed) return;
  const stable = stableHelperPath(homeOf(paths));
  try {
    const source = readFileSync(helperSource);
    const current = existsSync(stable) ? readFileSync(stable) : null;
    if (current === null || !current.equals(source)) {
      ensureBinDir(stable);
      copyHelperAtomic(helperSource, stable);
    }
  } catch (e) {
    console.error('Quick answers: could not refresh the helper copy:', e);
  }
}
