// Consent for the one thing this app does to a file the person owns.
//
// Design: docs/superpowers/specs/2026-09-21-first-run-checks-design.md §6.
//
// The app writes hooks into ~/.claude/settings.json. On the author's own
// machine that is invisible; on a stranger's it is an app editing their
// config. So this module puts a gate IN FRONT of the write rather than a
// dialog beside it:
//
//   previewHooksInstall()  ->  shows the file, the script, and every entry
//                              that will be added, and writes nothing
//   commitHooksInstall()   ->  refuses unless it is handed the token that
//                              preview issued, and then writes exactly the
//                              plan that was shown
//
// The token is not a security boundary -- a compromised renderer can call
// both channels in order, and nothing here pretends otherwise. What it
// guarantees is HONESTY: main cannot write hooks it has not just shown, and
// what it writes is the plan the person saw, byte for byte, because the plan
// itself is what the token holds. If settings.json changed in between,
// applyInstall's own baseText comparison refuses rather than applying over
// content nobody was shown.
//
// "Ask once, and take no for an answer" is the consent RECORD
// (~/.llm-workspace/consent.json). A declined answer is remembered so the
// first-run screen stops asking; the app still runs, with less.
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Paths } from '../config.ts';
import { buildHookFragments, planInstall, entryFor, type InstallPlan } from './install.ts';
import {
  stableHelperPath, homeOf, hooksState, ensureBinDir, copyHelperAtomic,
  ensureSettingsDir, readSettingsForEdit, writeSettingsEdit, type HooksResult,
} from './switch.ts';

export const CONSENT_REQUIRED =
  'The app has to show you what it would write before it writes it. Open the check again and read the list.';

export type ConsentDecision = 'granted' | 'declined';

export interface ConsentRecord {
  hooks?: { decision: ConsentDecision; at: string };
}

/** One entry the install would add, described for a person to read. `json`
 *  is the literal object that will appear under `hooks[event]`, formatted
 *  the same way the file itself is written (two-space indent), so what is
 *  on screen and what lands on disk are the same text. */
export interface HookAddition {
  event: string;
  matcher: string | null;
  json: string;
}

export interface HooksPreview {
  /** The file that will be modified. Absolute, and named outright. */
  file: string;
  /** The script the hooks will point at, copied into the app's own folder. */
  helperPath: string;
  /** Whether that file exists yet. A first-ever write creates it. */
  fileExists: boolean;
  installed: boolean;
  additions: HookAddition[];
  /** Hands this back to commitHooksInstall to say yes. null when there is
   *  nothing safe to offer -- an unreadable or unparseable settings.json. */
  token: string | null;
  error: string | null;
  /** What the person has already answered, if anything. */
  decision: ConsentDecision | null;
}

/** The plan a preview showed, waiting on a yes. One at a time: a second
 *  preview supersedes the first, because the first is no longer what is on
 *  screen. Module scope for the same reason the PATH memo is -- it is a
 *  property of this process, not of any one caller. */
let pending: { token: string; plan: InstallPlan & { baseText: string }; settingsPath: string } | null = null;

/** Drops a pending offer. Called after every commit (the token is spent)
 *  and by tests between cases. */
export function resetPendingConsent(): void {
  pending = null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Missing, empty, unparseable or the wrong shape all read as "nobody has
 *  answered yet". Never throws: a corrupt consent file must not be able to
 *  block the app, and the worst it can cost is being asked once more. */
export function readConsent(path: string): ConsentRecord {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return {}; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!isRecord(parsed)) return {};
  const hooks = parsed.hooks;
  if (!isRecord(hooks)) return {};
  const decision = hooks.decision;
  if (decision !== 'granted' && decision !== 'declined') return {};
  return { hooks: { decision, at: typeof hooks.at === 'string' ? hooks.at : '' } };
}

/** Same atomic discipline as every other file this app writes: a temp file
 *  in the same directory, fsynced, then renamed over. A crash mid-write
 *  must not leave a consent file that reads as a yes nobody gave.
 *
 *  0600 and a 0700 folder: this records a decision about the person's own
 *  config, and nothing else on the machine has any business reading it. */
export function recordConsent(path: string, decision: ConsentDecision, now: () => Date = () => new Date()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: ConsentRecord = { hooks: { decision, at: now().toISOString() } };
  const tmp = join(dir, `.consent.json.llmws.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** What the install would do, and nothing else. Reads settings.json;
 *  writes nothing at all -- not the helper copy, not the settings file, not
 *  the consent record. Everything this returns is what the person is shown
 *  before they are asked. */
export function previewHooksInstall(paths: Paths): HooksPreview {
  const home = homeOf(paths);
  const helperPath = stableHelperPath(home);
  const decision = readConsent(paths.consent).hooks?.decision ?? null;
  const base = {
    file: paths.claudeSettings,
    helperPath,
    installed: hooksState(paths).installed,
    decision,
  };

  const read = readSettingsForEdit(paths.claudeSettings);
  if (!read.ok) {
    return { ...base, fileExists: true, additions: [], token: null, error: read.error };
  }
  const fileExists = read.baseText !== '';

  let plan: InstallPlan;
  try {
    plan = planInstall(read.parsed, buildHookFragments(helperPath));
  } catch (e) {
    return {
      ...base, fileExists, additions: [], token: null,
      error: `Could not read settings.json's hooks: ${(e as Error).message}`,
    };
  }

  // The additions come out of the plan itself, never recomputed here, so
  // the list on screen is the list that will be written.
  const additions = plan.added.map(f => ({
    event: f.event,
    matcher: f.matcher,
    json: JSON.stringify(entryFor(f), null, 2),
  }));

  const token = randomUUID();
  pending = { token, plan: { ...plan, baseText: read.baseText }, settingsPath: paths.claudeSettings };
  return { ...base, fileExists, additions, token, error: null };
}

/** The yes. Writes only the plan the matching preview showed.
 *
 *  Order matters and mirrors setHooks': the helper copy (our own file, in
 *  our own folder) goes first, then settings.json. A failure to write the
 *  person's config must never leave it half-edited, and applyInstall's
 *  re-read-and-compare is what guarantees that what lands is what was on
 *  screen. */
export function commitHooksInstall(paths: Paths, token: unknown, helperSource: string): HooksResult {
  const offer = pending;
  if (
    offer === null
    || typeof token !== 'string' || token.length === 0
    || token !== offer.token
    // A preview taken against a different settings.json is not consent for
    // this one.
    || offer.settingsPath !== paths.claudeSettings
  ) {
    return { installed: hooksState(paths).installed, error: CONSENT_REQUIRED };
  }
  // Spent either way: a refused write must not leave a token lying around
  // that a retry could use without showing the person the new situation.
  resetPendingConsent();

  const stable = stableHelperPath(homeOf(paths));
  try {
    ensureBinDir(stable);
    copyHelperAtomic(helperSource, stable);
  } catch (e) {
    return { installed: hooksState(paths).installed, error: `Could not install the helper script: ${(e as Error).message}` };
  }

  const dirError = ensureSettingsDir(paths.claudeSettings);
  if (dirError) return { installed: hooksState(paths).installed, error: dirError };

  const error = writeSettingsEdit(paths.claudeSettings, {
    next: offer.plan.next, changed: offer.plan.changed, baseText: offer.plan.baseText,
  });

  // Re-probed from the file, never inferred from which branch ran -- the
  // one thing this must not do is claim a state the file does not show.
  const installed = hooksState(paths).installed;
  // Consent is recorded only for a write that actually landed. An install
  // that was refused is not a yes to anything.
  if (error === null && installed) recordConsent(paths.consent, 'granted');
  return { installed, error };
}

/** The clean uninstall design §6 requires. Removes only entries whose
 *  command exactly equals the one this app writes (install.ts's
 *  removeByCommand), so a hook the person wrote -- even one that merely
 *  mentions our helper's path as an argument -- is left alone.
 *
 *  No token: showing someone what you are about to REMOVE from your own
 *  footprint is not a thing they need to be protected from, and a consent
 *  gate on the exit is a gate on leaving. */
export function uninstallHooks(paths: Paths): HooksResult {
  const read = readSettingsForEdit(paths.claudeSettings);
  if (!read.ok) return { installed: hooksState(paths).installed, error: read.error };

  const command = buildHookFragments(stableHelperPath(homeOf(paths)))[0]!.command;
  let next: unknown;
  let changed: boolean;
  try {
    ({ next, changed } = removeOurs(read.parsed, command));
  } catch (e) {
    return { installed: hooksState(paths).installed, error: `Could not update settings.json: ${(e as Error).message}` };
  }

  const error = changed
    ? writeSettingsEdit(paths.claudeSettings, { next, changed, baseText: read.baseText })
    : null;
  const installed = hooksState(paths).installed;
  // Turning it off IS an answer, and it is a no. Recorded so the app does
  // not turn round and ask again on the next launch.
  if (error === null && !installed) recordConsent(paths.consent, 'declined');
  return { installed, error };
}

/** A copy of `settings` with every hook entry running exactly `command`
 *  removed, plus whether anything actually went. Works on a deep copy, so a
 *  failure part-way through cannot leave the caller's object half-edited. */
function removeOurs(settings: unknown, command: string): { next: unknown; changed: boolean } {
  const next: any = JSON.parse(JSON.stringify(settings ?? {}));
  const hooks = next?.hooks;
  if (!isRecord(hooks)) return { next, changed: false };
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry: any) =>
      !(Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => h?.command === command)));
    if (kept.length !== entries.length) changed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return { next, changed };
}
