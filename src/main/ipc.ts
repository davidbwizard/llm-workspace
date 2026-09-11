// Under plain-Node vitest (no electron-rebuild here), node_modules/electron
// is a stub whose default export is a path string, so this named import
// binds ipcMain to undefined rather than throwing. That stays harmless only
// because ipcMain is dereferenced inside registerIpc's body, never at module
// scope -- a test that imports and calls registerIpc directly will throw.
import { ipcMain, type BrowserWindow } from 'electron';
import type { Db } from '../store/db.ts';
import {
  openSessions, fleetStatePage, type SessionState, type OpenSession,
} from '../fleet/state.ts';
import type { Blocker } from '../store/signals.ts';
import { sanitizeForTerminal } from '../config.ts';
import { getCachedLiveProcesses } from '../discovery/live.ts';
import type { LiveProcess } from '../discovery/parse.ts';

/** fleet:list's response, and fleet:update's push payload. David's
 *  correction to the original brief: nothing history-related -- not a
 *  count, not the sessions themselves, not even a precomputed-and-held
 *  value -- crosses this boundary until a person actually expands History
 *  and fleet:history (below) is called. openSessions is unaffected by
 *  that: it was never history-derived to begin with (see
 *  buildFleetListPayload's doc comment). */
export interface FleetListPayload {
  version: 1;
  generatedAt: string;
  openSessions: OpenSession[];
}

/** fleet:history's response -- ONE PAGE of History, newest-first, plus the
 *  total session count (which fleetStatePage computes for free as part of
 *  ranking the page, so this never costs a separate query). Fetched only
 *  when History is expanded, and again for each "Show more" click
 *  (src/renderer/components/FleetView.tsx) -- never the whole array in one
 *  shot. */
export interface FleetHistoryPayload {
  version: 1;
  generatedAt: string;
  sessions: SessionState[];
  total: number;
}

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
  'events', 'blocker', 'match', 'candidates', 'host', 'alive',
  'processAgeSeconds', 'processRssBytes', 'sharesWorktreeWith',
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

// Same gate, for OpenSession. `cwd`/`project` are read straight from the
// process (`lsof`'s cwd, spec §7.1a discovery), not from any session, so
// they need their own sanitisation pass here even though the parallel
// SessionState fields are already sanitised upstream. `lastProse` is
// listed for the same defence-in-depth reason as blocker.kind below: even
// though nothing reachable populates it any more (buildOpenSessions never
// matches against a transcript -- see its doc comment), display safety at
// this boundary should not depend on that staying true. `pid` is
// structural -- see the note on it below.
export const OPEN_SESSION_SANITISED_FIELDS =
  ['cwd', 'project', 'lastProse'] as const satisfies readonly (keyof OpenSession)[];
// `pid` is what makes the close action (a later task) possible and safe --
// one card, one process, no guessing -- so it has to reach the renderer.
export const OPEN_SESSION_STRUCTURAL_FIELDS = [
  'pid', 'host', 'ageSeconds', 'rssBytes', 'match', 'sessionId', 'provider', 'events', 'activity',
] as const satisfies readonly (keyof OpenSession)[];

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
 *  fixed clean set), so "does the built payload ever show a dirty kind" is
 *  unobservable by construction -- sanitised or not, the output is
 *  identical for every reachable input. Calling this function directly,
 *  with a hand-built Blocker, is the only way to observe whether the
 *  mechanism itself still processes that field. */
export function sanitizeFields<T extends object>(obj: T, fields: readonly (keyof T)[]): T {
  const out = { ...obj };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string') out[f] = sanitizeForDisplay(v) as unknown as T[typeof f];
  }
  return out;
}

/** Provider text crosses into the renderer here. Sanitised at this
 *  boundary rather than in a component, so a new component cannot forget
 *  (spec §11.2). React escapes HTML, but control and bidi/zero-width
 *  characters are a separate problem and travel fine through JSX. */
function sanitizeSession(s: SessionState): SessionState {
  const session = sanitizeFields(s, SANITISED_FIELDS);
  return {
    ...session,
    blocker: session.blocker ? sanitizeFields(session.blocker, BLOCKER_SANITISED_FIELDS) : null,
  };
}

/** openSessions (src/fleet/state.ts) enumerates from live processes alone
 *  -- called here with an EMPTY session list, always, on both fleet:list
 *  and fleet:update (pushFleet below): David's correction goes further
 *  than the original brief's "defer history" -- "I wouldn't even defer.
 *  Let's just not load it unless I request it." A session being open is
 *  knowable from process discovery alone (spec S7.1a); attributing any
 *  transcript-derived fact to that card (match/sessionId/lastProse/events/
 *  activity) requires fleetState, which is exactly the index-dependent
 *  work that must never run before a person asks for History. Those five
 *  fields therefore always come back 'unknown'/null on an open card now --
 *  including the "needs you" chip, which reads `activity` -- a real,
 *  deliberate trade-off, not an oversight; flagged in the task report. */
function buildOpenSessions(processes: LiveProcess[]): OpenSession[] {
  return openSessions([], processes).map(o => sanitizeFields(o, OPEN_SESSION_SANITISED_FIELDS));
}

/** fleet:list -- the renderer's one-time initial pull (FleetView.tsx calls
 *  this exactly once, on mount) -- and fleet:update's push payload
 *  (pushFleet below): open sessions straight from the live-process cache,
 *  nothing else. Never touches the database at all -- getCachedLiveProcesses
 *  (src/discovery/live.ts) reads a cache discovery's own interval
 *  maintains, never triggering a sweep itself, so this is pure JS over an
 *  already-small array (measured ~0ms against the real index's live-process
 *  count) regardless of how many sessions are in the index or whether
 *  ingestAll has run yet this session (src/main/index.ts defers ingestAll
 *  until after this first reply specifically so it can never block it). */
export function buildFleetListPayload(): FleetListPayload {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    openSessions: buildOpenSessions(getCachedLiveProcesses()),
  };
}

/** fleet:history is paged, not pulled whole -- one page at a time, per
 *  David's correction ("paginate it... main should never build 878
 *  session objects"). These bound the untrusted offset/limit crossing the
 *  IPC boundary from the renderer (spec S11.2: validate at the boundary,
 *  not trust the shape): a non-finite or negative offset becomes 0; a
 *  non-positive, non-numeric, or absurdly large limit becomes
 *  HISTORY_DEFAULT_LIMIT, capped at HISTORY_MAX_LIMIT so a buggy or
 *  compromised renderer cannot request the whole corpus through the back
 *  door this split exists to close. */
export const HISTORY_DEFAULT_LIMIT = 60;
export const HISTORY_MAX_LIMIT = 200;

export function clampOffset(v: unknown): number {
  const n = typeof v === 'number' ? Math.trunc(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function clampLimit(v: unknown): number {
  const n = typeof v === 'number' ? Math.trunc(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return HISTORY_DEFAULT_LIMIT;
  return Math.min(n, HISTORY_MAX_LIMIT);
}

/** fleet:history -- one page of History, fetched only once History is
 *  actually expanded, and again (at the next offset) for each "Show more"
 *  click (src/renderer/components/FleetView.tsx). fleetStatePage
 *  (src/fleet/state.ts) bounds the expensive per-session work to this
 *  page; `total` comes free from the same call, so there is no separate
 *  count query to keep in sync. */
export function buildFleetHistoryPayload(db: Db, offset: number, limit: number): FleetHistoryPayload {
  const { sessions, total } = fleetStatePage(db, offset, limit, { processes: getCachedLiveProcesses() });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sessions: sessions.map(sanitizeSession),
    total,
  };
}

/** The complete set of channels main answers. Adding one means adding it to
 *  the preload's enumerated list as well; tests/main/ipc.test.ts asserts
 *  they match.
 *
 *  `onFleetList`, if given, fires once per fleet:list call, deferred via
 *  setImmediate so it runs strictly after this handler's own return value
 *  has already been handed back for delivery -- never before, and never
 *  synchronously inline (src/main/index.ts hangs starting ingestAll off of
 *  it, and ingestAll is a long blocking call; running it inline here would
 *  delay this very reply by the same amount this whole handler exists to
 *  avoid). Optional so tests, and any future caller with nothing to defer,
 *  can call registerIpc(db) alone. */
export function registerIpc(db: Db, onFleetList?: () => void): void {
  ipcMain.handle('fleet:list', () => {
    const payload = buildFleetListPayload();
    if (onFleetList) setImmediate(onFleetList);
    return payload;
  });
  ipcMain.handle('fleet:history', (_event, offset: unknown, limit: unknown) =>
    buildFleetHistoryPayload(db, clampOffset(offset), clampLimit(limit)));
}

/** Pushed on every watcher/spool/ingest/discovery change (src/main/index.ts).
 *  Sends the exact same FleetListPayload fleet:list does, built the same
 *  way (buildFleetListPayload, process-only) -- pushFleet never needed to
 *  build "anything beyond open sessions": the only reason it used to call
 *  fleetState was to compute historyCount and enrichment, both gone now.
 *  So this stopped touching the database at all, on every one of those
 *  triggers, not just the first -- see src/main/index.ts's discoveryTimer,
 *  which now pushes on every sweep rather than only the first, since a
 *  process starting or ending is the only thing this payload can ever
 *  reflect. */
export function pushFleet(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('fleet:update', buildFleetListPayload());
}
