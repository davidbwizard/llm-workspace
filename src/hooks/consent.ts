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
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Paths } from '../config.ts';
import {
  buildHookFragments, buildCodexHookFragments, planInstall, entryFor, type InstallPlan,
} from './install.ts';
import {
  stableHelperPath, homeOf, hooksState, ensureBinDir, copyHelperAtomic,
  ensureSettingsDir, readSettingsForEdit, writeSettingsEdit, doUninstall, type HooksResult,
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

/** A second file this install would touch, described exactly as the first
 *  one is. Design §6 asks the screen to show every file that will be
 *  written and what goes in it; a Codex install writes two, so it lists
 *  two. */
export interface HookTarget {
  file: string;
  fileExists: boolean;
  additions: HookAddition[];
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
  /** `~/.codex/hooks.json` and what would be added to it, or null when
   *  there is nothing to offer: no `~/.codex` on this machine (installing
   *  there would create config for a tool the person does not use), or its
   *  hooks.json could not be read -- in which case `error` says so and the
   *  Claude install is still offered rather than blocked by it. */
  codex: HookTarget | null;
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
let pending: {
  token: string;
  plan: InstallPlan & { baseText: string };
  settingsPath: string;
  /** The Codex half of the same offer, when one was shown. Carried with the
   *  token rather than recomputed at commit time, for the same reason the
   *  Claude plan is: what gets written is the plan that was on screen. */
  codex: { path: string; plan: InstallPlan & { baseText: string } } | null;
} | null = null;

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
    codex: null as HookTarget | null,
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

  const codex = planCodex(paths, helperPath);

  const token = randomUUID();
  pending = {
    token,
    plan: { ...plan, baseText: read.baseText },
    settingsPath: paths.claudeSettings,
    codex: codex.plan === null ? null : { path: paths.codexHooks, plan: codex.plan },
  };
  return { ...base, fileExists, additions, token, error: codex.error, codex: codex.target };
}

/** The Codex half of a preview. Never throws and never blocks the Claude
 *  half: a machine with no `~/.codex` simply has nothing to offer, and a
 *  hooks.json that cannot be read or planned is reported in `error` while
 *  the Claude install stays on the table. Writing hooks for a tool the
 *  person does not use would be its own kind of overreach, so the
 *  directory's existence -- not the file's -- is what decides. */
function planCodex(paths: Paths, helperPath: string): {
  target: HookTarget | null; plan: (InstallPlan & { baseText: string }) | null; error: string | null;
} {
  const none = { target: null, plan: null, error: null };
  if (!existsSync(dirname(paths.codexHooks))) return none;

  const read = readSettingsForEdit(paths.codexHooks);
  if (!read.ok) return { target: null, plan: null, error: `Codex hooks: ${read.error}` };

  let plan: InstallPlan;
  try {
    plan = planInstall(read.parsed, buildCodexHookFragments(helperPath));
  } catch (e) {
    return { target: null, plan: null, error: `Could not read ~/.codex/hooks.json: ${(e as Error).message}` };
  }

  return {
    target: {
      file: paths.codexHooks,
      fileExists: read.baseText !== '',
      additions: plan.added.map(f => ({
        event: f.event, matcher: f.matcher, json: JSON.stringify(entryFor(f), null, 2),
      })),
    },
    plan: { ...plan, baseText: read.baseText },
    error: null,
  };
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

  // The Codex file, when the preview offered one, and only after the Claude
  // write. A failure here is reported but does not undo the Claude install
  // that already landed -- two files cannot be written atomically, and
  // silently rolling one back would be a worse surprise than saying so.
  let codexError: string | null = null;
  if (offer.codex !== null) {
    codexError = ensureSettingsDir(offer.codex.path)
      ?? writeSettingsEdit(offer.codex.path, {
        next: offer.codex.plan.next,
        changed: offer.codex.plan.changed,
        baseText: offer.codex.plan.baseText,
      });
    if (codexError !== null) codexError = `Codex hooks: ${codexError}`;
  }

  // Re-probed from the file, never inferred from which branch ran -- the
  // one thing this must not do is claim a state the file does not show.
  const installed = hooksState(paths).installed;
  // Consent is recorded only for a write that actually landed. An install
  // that was refused is not a yes to anything.
  if (error === null && installed) recordConsent(paths.consent, 'granted');
  return { installed, error: error ?? codexError };
}

/** The clean uninstall design §6 requires. Delegates to the Quick answers
 *  switch's own removal (doUninstall, src/hooks/switch.ts), which removes
 *  only entries whose command exactly equals the one this app writes
 *  (install.ts's removeByCommand). Delegated rather than reimplemented: a
 *  second notion of what this app owns is exactly how "never rewrite
 *  entries the app did not put there" stops being true without anyone
 *  noticing.
 *
 *  No token: showing someone what you are about to REMOVE from your own
 *  footprint is not a thing they need protecting from, and a consent gate
 *  on the exit is a gate on leaving. */
export function uninstallHooks(paths: Paths): HooksResult {
  const stable = stableHelperPath(homeOf(paths));
  const error = doUninstall(paths.claudeSettings, stable);
  // Removal reaches every file the install could have written. doUninstall
  // tolerates a missing file, so a machine that never had Codex hooks costs
  // nothing here -- and one that does must not be left with entries
  // pointing at a helper the person just turned off.
  const codexError = existsSync(paths.codexHooks)
    ? doUninstall(paths.codexHooks, stable)
    : null;
  const installed = hooksState(paths).installed;
  // Turning it off IS an answer, and it is a no. Recorded so the app does
  // not turn round and ask again on the next launch.
  if (error === null && !installed) recordConsent(paths.consent, 'declined');
  return { installed, error: error ?? (codexError === null ? null : `Codex hooks: ${codexError}`) };
}
