// Under plain-Node vitest (no electron-rebuild here), node_modules/electron
// is a stub whose default export is a path string, so this named import
// binds ipcMain to undefined rather than throwing. That stays harmless only
// because ipcMain is dereferenced inside registerIpc's body, never at module
// scope -- a test that imports and calls registerIpc directly will throw.
import { ipcMain, type BrowserWindow } from 'electron';
import type { Db } from '../store/db.ts';
import { fleetState, type SessionState } from '../fleet/state.ts';
import type { Blocker } from '../store/signals.ts';
import { sanitizeForTerminal } from '../config.ts';
import { getCachedLiveProcesses } from '../discovery/live.ts';

export interface FleetPayload { version: 1; generatedAt: string; sessions: SessionState[] }

// Unicode bidirectional overrides (U+202A-U+202E: LRE, RLE, PDF, LRO, RLO)
// and isolates (U+2066-U+2069: LRI, RLI, FSI, PDI) -- e.g. U+202E
// RIGHT-TO-LEFT OVERRIDE, the classic filename-spoofing trick. Their effect
// is UNBOUNDED -- each re-orders how every character after it is DISPLAYED,
// until a matching pop or the end of the string, without changing the text
// itself. Inert in a terminal -- sanitizeForTerminal never touches them --
// but not in a renderer, so what the user reads can differ from what the
// agent actually wrote. This is the Trojan Source set.
//
// Written as \u escapes, deliberately -- not as the literal characters. An
// earlier version of this file used the literal characters, which made the
// set unreviewable (nobody can tell U+200B from U+200C by looking at a
// blank space) and, worse, made this file itself a Trojan Source vector:
// an unterminated LRE/RLO with no matching PDF reorders how the REST of
// the file displays in an editor, diff viewer or review tool. Do not
// "tidy" these back into literal characters.
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/g;
// Zero-width, no script role: zero-width space, word joiner, and the
// byte-order mark. Deliberately NOT included here: ZWNJ/ZWJ (U+200C/U+200D)
// are load-bearing for Persian, Arabic and Indic scripts (ZWNJ) and for
// emoji sequences (ZWJ) -- stripping them silently corrupts correct text,
// which is worse than leaving them, since it happens on honest content
// every day rather than only under attack. LRM/RLM (U+200E/U+200F) are
// also excluded: unlike the override/isolate set above, they only bias
// adjacent neutral characters, not an unbounded span, so they cannot
// reorder arbitrary following text the way BIDI_CONTROL's set can.
//
// Written as \u escapes for the same reason as BIDI_CONTROL above.
const ZERO_WIDTH_FORMATTING = /[\u200b\u2060\ufeff]/g;

/** sanitizeForTerminal (src/config.ts) strips terminal escape sequences and
 *  control characters -- correct for the terminal it was written for. It
 *  does not touch bidi overrides or zero-width formatting characters,
 *  because neither does anything on a terminal. Both do something on a
 *  renderer: this app exists to show faithfully what an agent said, so
 *  display integrity is the product, and provider text can quote arbitrary
 *  file content -- a realistic way such characters arrive. */
function sanitizeForDisplay(s: string): string {
  return sanitizeForTerminal(s).replace(BIDI_CONTROL, '').replace(ZERO_WIDTH_FORMATTING, '');
}

// Every SessionState field, classified into exactly one of these two lists:
// text that can carry provider-authored prose (sanitised through
// sanitizeForDisplay) or structural bookkeeping that cannot (an id, a
// timestamp, an enum, a count -- there is nothing for a bidi override or a
// zero-width character to hide inside a number or a known-value string).
//
// This is a gate, not documentation. tests/main/ipc.test.ts builds a real
// payload and asserts every key on a session is accounted for by one list
// or the other, with none left over. Add a field to SessionState and
// forget to put it in one of these two lists, and that test fails -- it
// has to, because the failure mode this defends against is exactly
// "nobody remembered," which a comment cannot prevent and a test can.
export const SANITISED_FIELDS =
  ['lastProse', 'project', 'cwd'] as const satisfies readonly (keyof SessionState)[];
export const STRUCTURAL_FIELDS = [
  'sessionId', 'runId', 'provider', 'lifecycle', 'activity', 'stale',
  'confidence', 'source', 'lastActivityAt', 'agents', 'liveAgents',
  'events', 'blocker', 'match', 'candidates', 'host', 'sharesWorktreeWith',
] as const satisfies readonly (keyof SessionState)[];

// Same gate, for the nested blocker object. `kind` is populated by
// `String(p.hook_event_name ?? 'unknown')` in src/hooks/spool.ts with no
// enum check at write time, so it is freeform text sitting right next to
// the already-sanitised `text` -- sanitised here too, as defence in depth:
// display safety at this boundary should not depend on
// src/store/signals.ts's isBlocking() gate (which happens to constrain
// `kind` to a fixed clean set today, for classification reasons unrelated
// to display) continuing to do so.
export const BLOCKER_SANITISED_FIELDS =
  ['text', 'kind'] as const satisfies readonly (keyof Blocker)[];
export const BLOCKER_STRUCTURAL_FIELDS = [
  'sessionId', 'toolUseId', 'promptId', 'occurredAt',
] as const satisfies readonly (keyof Blocker)[];

/** Sanitises every field named in `fields` whose current value is a string
 *  (some entries, e.g. cwd/lastProse, are nullable -- null passes through
 *  unchanged). Driving sanitisation from the same list the exhaustiveness
 *  test checks means there is one place to update when a field's
 *  classification changes, not two that can quietly drift apart.
 *
 *  Exported so tests/main/ipc.test.ts can call it directly for
 *  blocker.kind: that field can never carry dirty content through the
 *  real signal_events -> openBlockers pipeline (src/store/signals.ts's
 *  isBlocking() only admits a row whose kind exactly equals one of a
 *  fixed clean set), so "does buildFleetPayload's output ever show a
 *  dirty kind" is unobservable by construction -- sanitised or not, the
 *  output is identical for every reachable input. Calling this function
 *  directly, with a hand-built Blocker, is the only way to observe
 *  whether the mechanism itself still processes that field. */
export function sanitizeFields<T extends object>(obj: T, fields: readonly (keyof T)[]): T {
  const out = { ...obj };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string') out[f] = sanitizeForDisplay(v) as unknown as T[typeof f];
  }
  return out;
}

/** Provider text crosses into the renderer here. It is sanitised at this
 *  boundary rather than in a component, so a new component cannot forget
 *  (spec §11.2). React escapes HTML, but control and bidi/zero-width
 *  characters are a separate problem and travel fine through JSX. */
export function buildFleetPayload(db: Db): FleetPayload {
  // getCachedLiveProcesses reads whatever discovery/live.ts's own interval
  // (wired in src/main/index.ts) last found -- this function never triggers
  // a sweep itself, so building a payload (which happens on every
  // coalesced watcher push) never waits on a subprocess. Empty before the
  // first sweep completes, or if discovery fails outright: fleetState
  // already treats `processes` as pure enrichment over the session list it
  // builds from transcript activity, so an empty array here still returns
  // every session, just with host/match/candidates left at their unknown
  // defaults (spec 7.1a).
  const sessions = fleetState(db, { processes: getCachedLiveProcesses() }).map(s => {
    const session = sanitizeFields(s, SANITISED_FIELDS);
    return {
      ...session,
      blocker: session.blocker ? sanitizeFields(session.blocker, BLOCKER_SANITISED_FIELDS) : null,
    };
  });
  return { version: 1, generatedAt: new Date().toISOString(), sessions };
}

/** The complete set of channels main answers. Adding one means adding it to
 *  the preload's enumerated list as well; tests/main/ipc.test.ts asserts
 *  they match. */
export function registerIpc(db: Db): void {
  ipcMain.handle('fleet:list', () => buildFleetPayload(db));
}

export function pushFleet(db: Db, win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('fleet:update', buildFleetPayload(db));
}
