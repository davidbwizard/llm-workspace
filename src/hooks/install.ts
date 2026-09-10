import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
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
export interface InstallPlan { next: any; manifest: Manifest; baseText?: string }

export function buildHookFragments(helperPath: string): Fragment[] {
  const command = `sh '${helperPath.replace(/'/g, `'\\''`)}'`;
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
function entryFor(f: Fragment) {
  return {
    ...(f.matcher ? { matcher: f.matcher } : {}),
    hooks: [{ type: 'command', command: f.command, timeout: 5 }],
  };
}

/** Spec §5.3. Merge, never replace. The user already runs their own hooks. */
export function planInstall(existing: any, fragments: Fragment[]): InstallPlan {
  const next = JSON.parse(JSON.stringify(existing ?? {}));
  next.hooks ??= {};
  const owned: string[] = [];

  for (const f of fragments) {
    next.hooks[f.event] ??= [];
    const list: any[] = next.hooks[f.event];
    const already = list.some(e =>
      Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === f.command));
    if (!already) list.push(entryFor(f));
    owned.push(f.id);
  }

  return { next, manifest: { owned, command: fragments[0]!.command } };
}

/** Spec §5.3: re-read before write, then replace atomically. If another tool
 *  changed the file since the diff was computed, refuse — the caller
 *  recomputes and re-shows the diff rather than clobbering a newer version. */
export function applyInstall(settingsPath: string, plan: InstallPlan & { baseText: string }): void {
  let current = '';
  try { current = readFileSync(settingsPath, 'utf8'); } catch { current = ''; }
  if (current !== plan.baseText) {
    throw new Error('settings.json changed on disk since the diff was computed');
  }

  const tmp = join(dirname(settingsPath), `.settings.json.llmws.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(plan.next, null, 2) + '\n', 'utf8');
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, settingsPath);
}

/** Removes only entries whose `hooks[].command` exactly equals the
 *  manifest's recorded command. Exact match, never a substring: a user
 *  hook that merely mentions our helper's path (e.g. as an argument to
 *  their own command) is left alone. Anything the user added or edited by
 *  hand is left alone. */
export function uninstall(settingsPath: string, manifest: Manifest): void {
  const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
  for (const event of Object.keys(cfg.hooks ?? {})) {
    cfg.hooks[event] = (cfg.hooks[event] as any[]).filter(entry =>
      !(Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => h?.command === manifest.command)));
    if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
  }
  const tmp = join(dirname(settingsPath), `.settings.json.llmws.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  renameSync(tmp, settingsPath);
}
