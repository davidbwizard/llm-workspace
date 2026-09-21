import {
  readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, statSync, fchmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Spec §5.2. Sparse lifecycle only. MessageDisplay is deliberately absent:
 *  it fires during streaming, and one subprocess per token-flush is
 *  unacceptable churn inside the user's own sessions. */
export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PermissionRequest', 'PermissionDenied', 'Notification',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PostCompact', 'CwdChanged', 'Elicitation', 'ElicitationResult',
] as const;

/** The one PreToolUse matcher we install. Matcher filtering happens BEFORE
 *  the helper is spawned, so this does not run on every Bash/Edit/Read call. */
export const PRE_TOOL_MATCHER = 'AskUserQuestion|ExitPlanMode';

export interface Fragment { event: string; matcher: string | null; id: string; command: string }
export interface Manifest { owned: string[]; command: string }
/** `changed` is false when every fragment was already present (and nothing
 *  was reconciled away), so applyInstall has nothing to write.
 *
 *  `added` is the fragments this plan would actually ADD -- the ones not
 *  already in the file. It comes out of the same pass that builds `next`,
 *  rather than being recomputed by whatever wants to describe the plan,
 *  precisely so the consent screen and the write can never disagree about
 *  what is about to happen (design §6: "Show exactly what will be written,
 *  and to which file, before writing it"). */
export interface InstallPlan {
  next: any; manifest: Manifest; changed: boolean; added: Fragment[]; baseText?: string;
}

/** applyInstall's changed-since-read refusal -- its own class so a caller
 *  can tell it apart from a read or write failure (final review I5). */
export class SettingsChangedError extends Error {
  constructor() {
    super('settings.json changed on disk since the diff was computed');
    this.name = 'SettingsChangedError';
  }
}

/** `sh '<path>'`, with any single quote in the path escaped for the
 *  shell. The one quoting rule for every command this app writes into
 *  settings.json -- the hooks below and the "Usage and context" status line
 *  (src/hooks/usageSwitch.ts) -- so the two can never quote differently. */
export function shellCommandFor(scriptPath: string): string {
  return `sh '${scriptPath.replace(/'/g, `'\\''`)}'`;
}

export function buildHookFragments(helperPath: string): Fragment[] {
  const command = shellCommandFor(helperPath);
  const frags: Fragment[] = HOOK_EVENTS.map(event => ({
    event, matcher: null, id: `llmws:${event}`, command,
  }));
  frags.push({
    event: 'PreToolUse', matcher: PRE_TOOL_MATCHER,
    id: `llmws:PreToolUse:${PRE_TOOL_MATCHER}`, command,
  });
  return frags;
}

/** Emits only fields the documented hook schema defines (type, command,
 *  timeout). Earlier drafts tagged each entry with a private `_llmws`
 *  marker field for ownership tracking, but that assumes unknown fields on
 *  a hook object are tolerated — unverified, and not worth risking against
 *  the user's live config. Ownership is tracked by the `command` string
 *  instead (see planInstall/uninstall below), which is already a real,
 *  unambiguous schema field: our helper's absolute path. */
export function entryFor(f: Fragment) {
  return {
    ...(f.matcher ? { matcher: f.matcher } : {}),
    hooks: [{ type: 'command', command: f.command, timeout: 5 }],
  };
}

/** Recognizes a hook command emitted by buildHookFragments, for any helper
 *  path: `sh '<path>'` where `<path>` ends in `helper.sh`. Installed
 *  fragments carry only the documented schema fields (type, command,
 *  timeout) -- there is no `_llmws` marker and no on-disk manifest to read
 *  back later -- so this is the one identifying shape our own installer
 *  ever writes, and it is what both the hooksInstalled probe (config.ts)
 *  and a future "discover what we own without a manifest" path should test
 *  against, rather than re-deriving their own notion of ownership. */
export function isOwnedHookCommand(command: unknown): boolean {
  return typeof command === 'string' && /^sh '.*helper\.sh'$/.test(command);
}

/** Removes every hook entry whose `hooks[].command` exactly equals `command`.
 *  Exact match, never a substring: a user hook that merely mentions our
 *  helper's path (e.g. as an argument to their own command) is left alone.
 *  Returns how many entries it removed. */
function removeByCommand(hooks: any, command: string): number {
  let removed = 0;
  for (const event of Object.keys(hooks ?? {})) {
    const before = (hooks[event] as any[]).length;
    hooks[event] = (hooks[event] as any[]).filter((entry: any) =>
      !(Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => h?.command === command)));
    removed += before - hooks[event].length;
    if (hooks[event].length === 0) delete hooks[event];
  }
  return removed;
}

/** Spec §5.3: write a temp file in the same directory, fsync it, then
 *  rename over the original. Never truncate in place — a crash mid-write
 *  would leave the user with an unparseable config and a broken Claude
 *  Code. Shared by applyInstall and uninstall so the two write paths
 *  cannot drift apart.
 *
 *  Keeps the original file's mode (spec §4), so a 0600 settings.json never
 *  becomes 0644 as a side effect of a hooks install/uninstall. The temp
 *  file is created with that mode from the start (final review M9) -- it
 *  never sits at the default 0644 holding the user's settings -- and
 *  fchmod'd to it exactly, since open's mode is narrowed by the umask and
 *  ignored for a leftover temp file; both before any content is written.
 *  One descriptor for create, write and fsync, so a read-only original
 *  mode cannot fail a reopen. A missing original (first-ever write) keeps
 *  the default mode; any other stat failure is thrown, not guessed past. */
function writeJsonAtomic(settingsPath: string, data: any): void {
  const tmp = join(dirname(settingsPath), `.settings.json.llmws.${process.pid}.tmp`);
  let mode: number | null = null;
  try {
    mode = statSync(settingsPath).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const fd = openSync(tmp, 'w', mode ?? 0o666);
  try {
    if (mode !== null) fchmodSync(fd, mode);
    writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, settingsPath);
}

/** Spec §5.3. Merge, never replace. The user already runs their own hooks.
 *
 *  `previousManifest`, when supplied, reconciles against an earlier install
 *  before adding the current fragments: fragments whose command matches the
 *  previous manifest's recorded command are removed first (exact match
 *  only, never a substring or filename match — same discipline as
 *  uninstall). Without this, a project move that changes the helper's
 *  absolute path would add fragments for the new path while the old ones
 *  stayed behind, pointing at a script that no longer exists but still
 *  matching on every relevant event in every session. */
export function planInstall(existing: any, fragments: Fragment[], previousManifest?: Manifest): InstallPlan {
  const next = JSON.parse(JSON.stringify(existing ?? {}));
  next.hooks ??= {};
  let changed = previousManifest ? removeByCommand(next.hooks, previousManifest.command) > 0 : false;

  const owned: string[] = [];
  const added: Fragment[] = [];
  for (const f of fragments) {
    next.hooks[f.event] ??= [];
    const list: any[] = next.hooks[f.event];
    const already = list.some(e =>
      Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === f.command));
    if (!already) { list.push(entryFor(f)); changed = true; added.push(f); }
    owned.push(f.id);
  }

  return { next, manifest: { owned, command: fragments[0]!.command }, changed, added };
}

/** Spec §5.3: re-read before write, then replace atomically. If another tool
 *  changed the file since the diff was computed, refuse — the caller
 *  recomputes and re-shows the diff rather than clobbering a newer version.
 *  Only a missing file reads as empty; any other read failure is thrown
 *  (final review I3). A plan with nothing to add writes nothing (M10).
 *  Takes only what it uses (`next`, `changed`, `baseText`), so the status
 *  line switch (src/hooks/usageSwitch.ts) writes through this same
 *  re-read-then-atomic-write path rather than a copy of it. */
export function applyInstall(
  settingsPath: string, plan: Pick<InstallPlan, 'next' | 'changed'> & { baseText: string },
): void {
  let current = '';
  try {
    current = readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (current !== plan.baseText) throw new SettingsChangedError();
  if (!plan.changed) return;
  writeJsonAtomic(settingsPath, plan.next);
}

/** Removes only entries whose `hooks[].command` exactly equals the
 *  manifest's recorded command. Anything the user added or edited by hand
 *  is left alone.
 *
 *  Task 4: tolerates a missing settings.json -- turning Quick answers off
 *  when there is nothing to uninstall (never installed, or the file was
 *  deleted by hand) is a no-op, not an error. An existing file that fails
 *  to parse still throws, same as before: the caller (src/hooks/switch.ts)
 *  decides how to surface that, and this must never guess at content it
 *  cannot read. */
export function uninstall(settingsPath: string, manifest: Manifest): void {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const cfg = JSON.parse(raw);
  // Final review M10: nothing of ours to remove means nothing to write.
  if (removeByCommand(cfg.hooks, manifest.command) === 0) return;
  writeJsonAtomic(settingsPath, cfg);
}
