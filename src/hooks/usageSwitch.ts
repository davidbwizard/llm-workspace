import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from '../config.ts';
import { shellCommandFor } from './install.ts';
import {
  homeOf, ensureBinDir, copyHelperAtomic, ensureSettingsDir, readSettingsForEdit, writeSettingsEdit,
  refreshStableCopy,
} from './switch.ts';

/** The "Usage and context" switch (usage design, Part A). Mirrors the Quick
 *  answers switch (src/hooks/switch.ts) and shares its settings.json
 *  read/write path and error messages, so the two cannot drift: a stable
 *  copy of the script in ~/.llm-workspace/bin, the atomic mode-keeping
 *  write, never writing an unparseable or unreadable file, only ENOENT
 *  meaning "missing", and no write when nothing changes.
 *
 *  ON sets settings.json `statusLine` to our script only when there is no
 *  status line at all. Claude Code allows exactly one, so a person's own is
 *  never replaced -- the switch refuses and says so. OFF removes
 *  `statusLine` only when it is ours. The state is always re-read from the
 *  file, never remembered. */
export interface UsageSwitchResult { installed: boolean; error: string | null }

export const FOREIGN_STATUS_LINE = 'You already have a status line in settings.json -- not replaced.';
const NOT_AN_OBJECT = 'settings.json is not a JSON object -- fix it by hand, then try again.';

export function stableStatusLinePath(home: string): string {
  return join(home, '.llm-workspace/bin/statusline.sh');
}

/** The exact command string ON writes, quoted by the same rule as the hooks'
 *  own command (install.ts's shellCommandFor). */
export function statusLineCommand(home: string): string {
  return shellCommandFor(stableStatusLinePath(home));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Tightens the statusline snapshot folder to 0700 on every ON, in main --
 *  never in the helper script, whose own `mkdir -p` only sets the mode at
 *  creation and never revisits a folder that already exists looser than
 *  that (the same reasoning as switch.ts's ensureBinDir). */
function ensureStatusLineDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Ours means a command status line running exactly our command string --
 *  the one field that identifies it, the same way hooks are recognised by
 *  their exact command (install.ts's removeByCommand). Other keys (a
 *  `padding` someone added by hand) do not make it someone else's. */
function isOwnStatusLine(value: unknown, home: string): boolean {
  return isPlainObject(value) && value.type === 'command' && value.command === statusLineCommand(home);
}

/** Missing, unreadable or unparseable all read as off -- the same
 *  conservative answer probeCapabilities gives for the hooks. */
export function usageSwitchState(paths: Paths): UsageSwitchResult {
  let installed = false;
  try {
    const cfg: unknown = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    installed = isPlainObject(cfg) && isOwnStatusLine(cfg.statusLine, homeOf(paths));
  } catch {
    installed = false;
  }
  return { installed, error: null };
}

/** Decides from the file before writing anything, so a refusal (their own
 *  status line, bad JSON) leaves nothing of ours behind -- not even the
 *  script copy. When ours is already there the copy is still refreshed
 *  (it may have been deleted by hand) but settings.json is not rewritten. */
function turnOn(paths: Paths, source: string): string | null {
  const home = homeOf(paths);
  const read = readSettingsForEdit(paths.claudeSettings);
  if (!read.ok) return read.error;
  if (!isPlainObject(read.parsed)) return NOT_AN_OBJECT;

  const current = read.parsed.statusLine;
  const ours = isOwnStatusLine(current, home);
  // A `null` status line is no status line; anything else is someone's.
  if (!ours && current !== undefined && current !== null) return FOREIGN_STATUS_LINE;

  const stable = stableStatusLinePath(home);
  try {
    ensureBinDir(stable);
    copyHelperAtomic(source, stable);
    ensureStatusLineDir(paths.statusLineDir);
  } catch (e) {
    return `Could not install the status line script: ${(e as Error).message}`;
  }
  if (ours) return null;

  const dirError = ensureSettingsDir(paths.claudeSettings);
  if (dirError) return dirError;
  const next = { ...read.parsed, statusLine: { type: 'command', command: statusLineCommand(home) } };
  return writeSettingsEdit(paths.claudeSettings, { next, changed: true, baseText: read.baseText });
}

/** Tolerates a missing file (nothing to remove, nothing created) and never
 *  touches a status line that is not ours. */
function turnOff(paths: Paths): string | null {
  const read = readSettingsForEdit(paths.claudeSettings);
  if (!read.ok) return read.error;
  if (!isPlainObject(read.parsed) || !isOwnStatusLine(read.parsed.statusLine, homeOf(paths))) return null;
  const { statusLine: _ours, ...next } = read.parsed;
  return writeSettingsEdit(paths.claudeSettings, { next, changed: true, baseText: read.baseText });
}

/** Flips the switch. `source` is main's copy of src/hooks/statusline.sh
 *  (a parameter, as for setHooks, so tests never touch the app's own
 *  location). `installed` is always re-read from the file afterwards. */
export function setUsageSwitch(paths: Paths, on: boolean, source: string): UsageSwitchResult {
  const error = on ? turnOn(paths, source) : turnOff(paths);
  return { installed: usageSwitchState(paths).installed, error };
}

/** On app start with the switch on, refresh the stable copy if it differs
 *  from this app version's script -- touches only that file, never
 *  settings.json. Best-effort: logged, never thrown, so it cannot block
 *  startup. */
export function refreshStatusLineIfInstalled(paths: Paths, source: string): void {
  if (!usageSwitchState(paths).installed) return;
  try {
    refreshStableCopy(source, stableStatusLinePath(homeOf(paths)));
  } catch (e) {
    console.error('Usage and context: could not refresh the status line script copy:', e);
  }
}
