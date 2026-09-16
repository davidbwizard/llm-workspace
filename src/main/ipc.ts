// Under plain-Node vitest (no electron-rebuild here), node_modules/electron
// is a stub whose default export is a path string, so this named import
// binds ipcMain to undefined rather than throwing. That stays harmless only
// because ipcMain is dereferenced inside registerIpc's body, never at module
// scope -- a test that imports and calls registerIpc directly will throw.
import { app, ipcMain, BrowserWindow, dialog, nativeTheme } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { Db } from '../store/db.ts';
import {
  openSessions, openSessionsLive, fleetStatePage, type SessionState, type OpenSession,
} from '../fleet/state.ts';
import type { Blocker } from '../store/signals.ts';
import { sanitizeForTerminal, parseProcessChainHop, resolvePaths } from '../config.ts';
import { writeStoredTheme, type ThemeChoice } from './appearance.ts';
import {
  getCachedLiveProcesses, refreshLiveProcesses, execFileSoft, readLiveSession, type ExecFn,
} from '../discovery/live.ts';
import type { LiveProcess } from '../discovery/parse.ts';
import type { LiveSessionRead, LiveSessionFile } from '../providers/claude/liveSession.ts';
import { projectDir } from '../providers/claude/projectKey.ts';
import { sanitizeOutbound, type OutboundRefusal } from './outbound.ts';
import { resolveLiveTmux, tmuxNameForPid, forgetSession, launchedAtForPid } from './sessions.ts';
import {
  sendLiteral, sendKeyName, capturePane, setSessionOption, loadBuffer, pasteBuffer, deleteBuffer,
  type TmuxResult, type TmuxExec,
} from './tmux.ts';
import { makeCoalescer, type Coalescer, type TerminalDataPayload } from './stream.ts';
import { conversationFor, type ConversationCursor } from '../store/conversation.ts';
import type { Provider } from '../core/types.ts';
import { launchSession, reattachSession, resumeSession, type LaunchResult } from './launch.ts';

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
  'pid', 'host', 'ageSeconds', 'rssBytes', 'match', 'sessionId', 'provider', 'events', 'activity', 'tmux',
  'junk',
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
 *  -- called here with an EMPTY session list: fleet:list must stay
 *  structurally incapable of touching the index (David's correction --
 *  "I wouldn't even defer. Let's just not load it unless I request it").
 *  match/sessionId come back 'unknown'/null in THIS payload for an
 *  ordinary cwd match -- EXCEPT a process carrying a verified live session
 *  file (spec 2026-09-15-exact-session-identity-design.md §3.3), which
 *  still resolves to 'unique' and its own sessionId here, since that match
 *  needs no session list at all. lastProse/events/activity stay null
 *  either way -- both builders only ever attach those from an actual
 *  transcript match, and this call is given none. That is no longer the
 *  whole story for an open card, though -- see pushFleet below, which
 *  sends the enriched version once fleet:update actually fires; the gap is
 *  only ever the moment between the window opening and the first push. */
function buildOpenSessions(processes: LiveProcess[]): OpenSession[] {
  return openSessions([], processes, { isTmux: pidIsTmux }).map(o => sanitizeFields(o, OPEN_SESSION_SANITISED_FIELDS));
}

/** The one place that answers "is this pid tmux-backed" -- src/fleet/
 *  state.ts's openSessions/openSessionsLive deliberately have no dependency
 *  of their own on the tmux registry (src/main/sessions.ts's byPid map is a
 *  main-process-only mutable singleton; importing it there would make an
 *  otherwise-pure, easily-fixture-tested module depend on global state).
 *  This is the seam where the real answer is supplied. */
function pidIsTmux(pid: number): boolean {
  return tmuxNameForPid(pid) !== null;
}

/** pushFleet reads this rather than calling openSessionsLive itself --
 *  see refreshPushEnrichment's doc comment for why. Starts empty, exactly
 *  like discovery/live.ts's own process cache, until the first discovery
 *  sweep has actually run. */
let cachedPushOpenSessions: OpenSession[] = [];

/** Refreshes the cache pushFleet (below) reads, from a real
 *  openSessionsLive query -- called from src/main/index.ts's discovery
 *  interval (every 5s), not from pushFleet itself, and not on every
 *  watcher/spool/ingest trigger. Measured against the real index:
 *  openSessionsLive's candidate-cwd query costs 30-60ms warm (its first,
 *  cold-cache call measured 656ms) -- a scan of `kind = 'session.started'`
 *  rows, since there is no index on `kind` in this schema, so the cost
 *  scales with TOTAL EVENTS, not with how many processes are live. That
 *  fails "bounded by live-process count, so it stays cheap on a machine
 *  with 10,000 sessions" on its own -- the property that matters, per the
 *  team lead's own standard -- so this is not run on the push path at
 *  all. Reusing discovery/live.ts's own 5s cadence, the same cadence its
 *  process cache already refreshes on, means every other push trigger
 *  (watcher/spool/ingest, which can fire every ~250ms during a burst)
 *  reads a cache instead of paying that scan: a "needs you" chip up to 5
 *  seconds late, never a query on the push path itself -- exactly the
 *  fallback the team lead pre-authorized if the push-path cost did not
 *  hold up under measurement, which it did not. */
export function refreshPushEnrichment(db: Db, processes: LiveProcess[], now: number = Date.now()): void {
  cachedPushOpenSessions = openSessionsLive(db, processes, now, { isTmux: pidIsTmux, launchedAtForPid });
}

/** The pid's live session file, re-read now, trusted only if its startedAt
 *  is the one discovery verified (stable across `/clear`, different for any
 *  other process). null for Codex, for a process discovery never verified,
 *  and for a failed or mismatched read. Shared by Reattach and Reply so the
 *  two cannot drift on what counts as a fresh, exact read. */
export function freshLiveSession(
  pid: number, processes: LiveProcess[], read: (pid: number) => LiveSessionRead,
): LiveSessionFile | null {
  const proc = processes.find(p => p.pid === pid);
  if (proc?.provider !== 'claude' || !proc.liveSession) return null;
  const fresh = read(pid);
  return fresh.ok && fresh.file.startedAtMs === proc.liveSession.startedAtMs ? fresh.file : null;
}

/** session:reattach's session lookup: which session (id, provider, cwd) a
 *  live pid belongs to. Reads the exact same enriched cache pushFleet
 *  already maintains (cachedPushOpenSessions, refreshed by
 *  refreshPushEnrichment above) rather than running a query of its own --
 *  reattachSession (src/main/launch.ts) has no database or discovery access
 *  itself, by design, so this is the one place that resolves the pid before
 *  handing it in as an injected dependency. sessionId is only ever non-null
 *  on a `unique` match (OpenSession's own doc comment, src/fleet/state.ts)
 *  -- unique now covers an exact live-session match as well as a unique cwd
 *  match (spec §3.3) -- an ambiguous or unmatched pid still resolves to
 *  null here, which reattachSession treats as "cannot identify", never a
 *  guess.
 *
 *  Exact identity first (spec 2026-09-15-exact-session-identity-design.md
 *  §3.5): the enriched cache can be up to one sweep old, and a `/clear` in
 *  that window changes the session id. Uses freshLiveSession (above) for
 *  that fresh, verified read -- the same helper Reply's promptOpenFor
 *  (below) uses, so the two cannot drift on what counts as fresh. Anything
 *  else falls back to the cache exactly as before. */
export function resolveReattachTarget(
  pid: number,
  deps: { cached: OpenSession[]; processes: LiveProcess[]; read: (pid: number) => LiveSessionRead },
): { sessionId: string; provider: Provider; cwd: string } | null {
  const fresh = freshLiveSession(pid, deps.processes, deps.read);
  if (fresh) return { sessionId: fresh.sessionId, provider: 'claude', cwd: fresh.cwd };

  const open = deps.cached.find(o => o.pid === pid);
  if (!open || open.sessionId === null || open.cwd === null) return null;
  return { sessionId: open.sessionId, provider: open.provider, cwd: open.cwd };
}

/** Whether Claude is showing a choice (a question picker or a permission
 *  prompt) for this pid right now. A typed reply cannot answer one: the
 *  picker ignores the letters and Enter selects the highlighted option --
 *  measured 2026-09-15, "blue" was recorded as "Red", and at a permission
 *  prompt option 1 is "Yes". The exact status wins when there is one;
 *  otherwise only a PermissionRequest hook blocker counts, because
 *  hook-based waiting_input can be an ordinary text prompt. */
export function promptOpenFor(
  pid: number,
  deps: { cached: OpenSession[]; processes: LiveProcess[]; read: (pid: number) => LiveSessionRead },
): boolean {
  const fresh = freshLiveSession(pid, deps.processes, deps.read);
  if (fresh && fresh.status !== null) return fresh.status === 'waiting';
  return deps.cached.find(o => o.pid === pid)?.activity === 'waiting_permission';
}

function resolveSessionForReattach(pid: number): { sessionId: string; provider: Provider; cwd: string } | null {
  return resolveReattachTarget(pid, {
    cached: cachedPushOpenSessions, processes: getCachedLiveProcesses(), read: readLiveSession,
  });
}

function isProvider(v: unknown): v is Provider {
  return v === 'claude' || v === 'codex';
}

/** fleet:list -- the renderer's one-time initial pull (FleetView.tsx calls
 *  this exactly once, on mount): open sessions straight from the
 *  live-process cache, nothing else. Never touches the database at all --
 *  getCachedLiveProcesses (src/discovery/live.ts) reads a cache
 *  discovery's own interval maintains, never triggering a sweep itself,
 *  so this is pure JS over an already-small array (measured ~0ms against
 *  the real index's live-process count) regardless of how many sessions
 *  are in the index or whether ingestAll has run yet this session
 *  (src/main/index.ts defers ingestAll until after this first reply
 *  specifically so it can never block it). Unlike pushFleet below, this
 *  never enriches -- see buildOpenSessions' doc comment for why that is
 *  still an acceptable trade for a one-time pull that runs before
 *  anything else has had a chance to. */
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

/** session:conversation's paging cursor, crossing the IPC boundary the same
 *  untrusted way offset/limit above do (spec S11.2). Anything that is not
 *  exactly `{ ts: string, id: <finite integer> }` falls back to undefined
 *  -- i.e. "no cursor", the safe default of just returning the first page
 *  -- rather than throwing and taking the whole channel down over a
 *  malformed or hostile renderer payload. There is no injection risk either
 *  way (conversationFor binds both fields as query parameters, never
 *  interpolates them into SQL text); this is purely about not crashing on
 *  a shape we don't expect. */
export function parseConversationCursor(v: unknown): ConversationCursor | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const { ts, id } = v as { ts?: unknown; id?: unknown };
  if (typeof ts !== 'string' || ts === '') return undefined;
  if (typeof id !== 'number' || !Number.isInteger(id)) return undefined;
  return { ts, id };
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

// ---------------------------------------------------------------------
// session:kill -- the app's first destructive action. Everything above
// this point only observes; this ends a real process. The renderer is
// sandboxed and untrusted (same premise as every other channel here), so
// main must never signal a pid merely because the renderer asked -- every
// step below is a guard against that, not an optimisation.
// ---------------------------------------------------------------------

/** Every reason killSession can refuse to signal a pid. Deliberately a
 *  closed set of internal codes, not a free-form string: nothing here is
 *  ever built from provider text, process output, or anything else
 *  attacker-reachable, so -- unlike SessionState/Blocker/OpenSession above
 *  -- there is no SANITISED/STRUCTURAL split to maintain for this payload.
 *  A future change that turned this into `reason: string` built from,
 *  say, an OS error message would reintroduce exactly the class of problem
 *  that split exists to prevent; tests/main/ipc.test.ts pins this as a
 *  closed union so that change cannot happen silently. */
export type KillRefusalReason =
  | 'invalid_pid'        // not a positive integer
  | 'own_process'        // this app's own main process
  | 'protected_ancestor' // an ancestor of this app's own process
  | 'not_discovered'     // not present in a just-refreshed discovery sweep
  | 'signal_failed';     // process.kill threw something other than ESRCH

/** session:kill's response. Never thrown -- a renderer awaiting
 *  window.fleet.killSession always gets one of these three shapes back,
 *  including for a refusal, so it can show something specific rather than
 *  a generic error. */
export type KillResult =
  | { status: 'killed' }
  | { status: 'already_gone' }
  | { status: 'refused'; reason: KillRefusalReason };

/** Sends the signal -- injectable so tests can prove SIGTERM is what gets
 *  sent, and prove the already_gone/refused paths, without ever touching a
 *  real process (spec: never kill a real process in development or
 *  testing). Contract: throw on failure (Node's process.kill already does
 *  this -- ESRCH if the pid is gone, EPERM if not permitted), never swallow
 *  it -- killSession is what decides how each failure maps to a KillResult. */
export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

/** A tty name as `ps -o tty=` reports it: `ttys009`, occasionally `console`.
 *  Validated before it is ever interpolated into an AppleScript string --
 *  the value comes from our own ps output rather than the renderer, but a
 *  script built by string interpolation is not a place to rely on that. */
const TTY_NAME = /^[a-z][a-z0-9]{0,15}$/;

/** A cwd from `lsof` is our own data, not the renderer's, but it is passed
 *  as an argument to a CLI -- so it is checked for the one property that
 *  matters here: an absolute path, not a flag. execFile takes an argument
 *  array rather than a shell string, so there is no quoting to get wrong. */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/');
}

/** Selects the exact iTerm2 or Terminal session whose tty matches, rather
 *  than merely raising the application. Both expose `tty` on a session/tab,
 *  and `ps` gives us the agent process's tty, so the two can be matched
 *  directly -- `ps` reports `ttys009` where the terminals report
 *  `/dev/ttys009`.
 *
 *  Returns false when there is no matching session -- a window the user has
 *  since closed, or a session running under tmux or in VS Code's integrated
 *  terminal -- so the caller can fall back to just activating the app. */
function selectTerminalSession(host: LiveProcess['host'], tty: string): boolean {
  if (!TTY_NAME.test(tty)) return false;
  const dev = `/dev/${tty}`;
  const script =
    host === 'iterm2'
      ? `tell application "iTerm2"
           repeat with w in windows
             repeat with t in tabs of w
               repeat with s in sessions of t
                 if tty of s is "${dev}" then
                   select w
                   tell w to select t
                   tell t to select s
                   activate
                   return "ok"
                 end if
               end repeat
             end repeat
           end repeat
           return "no"
         end tell`
      : host === 'terminal'
        ? `tell application "Terminal"
             repeat with w in windows
               repeat with t in tabs of w
                 if tty of t is "${dev}" then
                   set selected tab of w to t
                   set index of w to 1
                   activate
                   return "ok"
                 end if
               end repeat
             end repeat
             return "no"
           end tell`
        : null;
  if (!script) return false;
  try {
    return execFileSync('osascript', ['-e', script], { timeout: 4000 }).toString().trim() === 'ok';
  } catch {
    return false;
  }
}

/** Brings a macOS application to the front. Injectable so tests never
 *  actually raise a window. The app name comes from a closed map in
 *  revealSession, never from the renderer, so this is not a place a string
 *  from the window can reach `open`. */
function defaultOpen(app: string): void {
  execFileSync('open', ['-a', app], { timeout: 2000 });
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** One hop of `ps -o ppid=,comm= -p <pid>`, real ps this time -- the same
 *  shape discovery/live.ts produces for the same command. Shares that
 *  module's execFileSoft (B2: bounded timeout + SIGKILL, fail-soft to '')
 *  rather than its own separate, previously un-timed execFileP call: an
 *  unresponsive `ps` here used to hang forever, which blocked
 *  ownProcessAncestry -- and so killSession -- indefinitely. This module's
 *  own dependency is still on config.ts's parseProcessChainHop, the actual
 *  parsing logic; execFileSoft is just the shelling-out wrapper, shared so
 *  both call sites get identical, tested timeout behaviour. Fail-soft
 *  behaviour is unchanged: parseProcessChainHop already treats an empty
 *  result as "hop unavailable, stop the walk", which is the safe direction
 *  for a protective walk like ownProcessAncestry below (an incomplete
 *  result can only under-protect a pid the walk never reached, never
 *  wrongly clear one it did). */
async function defaultHop(pid: number): Promise<string> {
  return execFileSoft('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
}

/** This app's own process, and every ancestor of it (parent, grandparent,
 *  ... up to init or maxDepth), walked one hop at a time via `hop`. Exists
 *  so killSession can refuse to signal any pid in this list: a bug that
 *  let a kill request reach the terminal or shell the user launched the
 *  app from -- or the app's own process -- would be the worst outcome this
 *  feature could produce, so this is checked explicitly rather than
 *  assumed impossible because "discovery would never find those pids
 *  anyway" (true today, but not a guarantee this function should depend
 *  on).
 *
 *  Includes process.pid itself as the walk's first element. killSession
 *  also checks pid === process.pid directly, as its own unambiguous guard
 *  -- this array covers that case too, as defence in depth, so a bug that
 *  removed the explicit check would still be caught here.
 *
 *  `hop` is injected (defaultHop above is the real implementation), the
 *  same DI shape discovery/live.ts's ExecFn uses, so tests can drive this
 *  with canned `ps` output -- this walk never needs to run against the
 *  test machine's actual process tree to prove the guard works. */
export async function ownProcessAncestry(
  hop: (pid: number) => Promise<string> = defaultHop, maxDepth = 12,
): Promise<number[]> {
  const pids: number[] = [];
  let cur: number | null = process.pid;
  let depth = 0;
  while (cur !== null && depth < maxDepth) {
    pids.push(cur);
    const step = parseProcessChainHop(await hop(cur));
    if (!step || step.ppid <= 1) break;
    cur = step.ppid;
    depth++;
  }
  return pids;
}

/** session:kill's handler logic. Every guard below runs before any signal
 *  is sent, cheapest first:
 *
 *  1. Shape: pid must be a positive integer. Not a numeric string --
 *     the preload's declared signature is `killSession(pid: number)`, and a
 *     renderer sending anything else is already off-contract (spec S11.2:
 *     validate at the boundary, don't trust the shape). Also closes off
 *     0 and negative values, which POSIX gives special meaning to (`kill`
 *     with pid <= 0 targets a process GROUP, not a single process --
 *     exactly the kind of blast-radius mistake this whole feature exists
 *     to prevent).
 *  2. Never this app's own process.
 *  3. Never an ancestor of this app's own process (ownProcessAncestry
 *     above) -- covers (2) again too, as defence in depth.
 *  4. Refreshed against LIVE truth, not the up-to-5s-stale cache:
 *     refreshLiveProcesses runs a real sweep and only then is the pid
 *     checked against it. A pid the app did not itself just (re)discover
 *     is refused -- this is what stops a renderer from ever naming an
 *     arbitrary pid; the app only ever signals a pid it found itself,
 *     freshly, this call.
 *  5. Only then, the signal -- SIGTERM, never SIGKILL (opts.signal
 *     defaults to defaultSignal above, which always calls process.kill
 *     with whatever this function passes it; this function always passes
 *     'SIGTERM', so upgrading to SIGKILL is not something a caller can even
 *     select, let alone something that happens automatically). A process
 *     that ignores SIGTERM simply stays alive and its card stays on
 *     screen -- deciding to escalate is left to the person looking at it,
 *     not automated here.
 *  6. Either way the process turns out to be gone (killed, or already_gone
 *     -- found the process was already gone when the signal was sent),
 *     forgetSession(pid) below clears the tmux registry entry, if this pid
 *     ever had one. Whole-branch review, item 1: killSession/reattachSession
 *     had no production caller of forgetSession at all, so a long-running
 *     app doing many launches/reattaches leaked one entry per pid forever.
 *     Not exploitable on its own -- resolveLiveTmux re-verifies every
 *     lookup against a real `tmux has-session` before anything acts on it,
 *     so a stale entry is inert -- but it is exactly the "populated thing
 *     nothing acts on" pattern the phase-4 inherited-risks doc warns about.
 *     Safe to call unconditionally: forgetSession on a pid with no entry
 *     (the ordinary case -- most killed pids were never tmux-backed) is a
 *     no-op delete.
 *
 *  `exec`/`hop`/`signal` are all injectable (discovery/live.ts's ExecFn
 *  shape, and the two above) so this is fully testable -- including the
 *  SIGTERM-not-SIGKILL and already_gone/refused paths -- without ever
 *  touching a real process. */
export async function killSession(rawPid: unknown, opts: {
  exec?: ExecFn;
  hop?: (pid: number) => Promise<string>;
  signal?: SignalFn;
} = {}): Promise<KillResult> {
  if (typeof rawPid !== 'number' || !Number.isInteger(rawPid) || rawPid <= 0) {
    return { status: 'refused', reason: 'invalid_pid' };
  }
  const pid = rawPid;

  if (pid === process.pid) return { status: 'refused', reason: 'own_process' };

  const ancestors = await ownProcessAncestry(opts.hop);
  if (ancestors.includes(pid)) return { status: 'refused', reason: 'protected_ancestor' };

  const live = await refreshLiveProcesses(opts.exec);
  if (!live.some(p => p.pid === pid)) return { status: 'refused', reason: 'not_discovered' };

  try {
    (opts.signal ?? defaultSignal)(pid, 'SIGTERM');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ESRCH') {
      forgetSession(pid);
      return { status: 'already_gone' };
    }
    return { status: 'refused', reason: 'signal_failed' };
  }
  forgetSession(pid);
  return { status: 'killed' };
}

/** Which macOS application to bring forward for each host. Keyed by the
 *  HostApp values classifyHost produces. 'unknown' is absent deliberately:
 *  a host we could not identify has nowhere to jump to, and the card
 *  renders the label as plain text rather than a dead button. */
const APP_FOR_HOST: Partial<Record<LiveProcess['host'], string>> = {
  iterm2: 'iTerm',
  terminal: 'Terminal',
  vscode: 'Visual Studio Code',
  'claude-app': 'Claude',
  'codex-app': 'ChatGPT',
};

export type RevealResult = { status: 'revealed' } | { status: 'refused'; reason: KillRefusalReason };

/** Brings the application hosting a session to the front. The renderer sends
 *  only a pid -- main looks up the host in its OWN discovery data and picks
 *  the application name from the closed map above, so a compromised renderer
 *  cannot name something to launch. Same validation shape as killSession,
 *  minus the self/ancestor guards: activating an application cannot end a
 *  process, so the worst case is focusing the wrong window. */
export async function revealSession(rawPid: unknown, opts: {
  exec?: ExecFn;
  open?: (app: string) => void;
} = {}): Promise<RevealResult> {
  if (typeof rawPid !== 'number' || !Number.isInteger(rawPid) || rawPid <= 0) {
    return { status: 'refused', reason: 'invalid_pid' };
  }
  const live = await refreshLiveProcesses(opts.exec);
  const proc = live.find(p => p.pid === rawPid);
  if (!proc) return { status: 'refused', reason: 'not_discovered' };

  const app = APP_FOR_HOST[proc.host];
  if (!app) return { status: 'refused', reason: 'not_discovered' };

  // Try for the exact window and tab first; fall back to raising the
  // application when there is no matching session -- a closed window, tmux,
  // or VS Code's integrated terminal, which has no scriptable tty.
  if (!opts.open && proc.tty && selectTerminalSession(proc.host, proc.tty)) {
    return { status: 'revealed' };
  }

  // VS Code's integrated terminal exposes no tty to AppleScript, so the tab
  // itself cannot be selected. Its CLI can at least focus the window for
  // that project, which is the useful half (spec 7.3's VS Code tier).
  if (!opts.open && proc.host === 'vscode' && proc.cwd && isAbsolutePath(proc.cwd)) {
    try {
      execFileSync('code', ['-r', proc.cwd], { timeout: 4000 });
      return { status: 'revealed' };
    } catch {
      // code CLI absent or failed -- fall through to raising the app.
    }
  }

  try {
    (opts.open ?? defaultOpen)(app);
  } catch {
    return { status: 'refused', reason: 'signal_failed' };
  }
  return { status: 'revealed' };
}

export type KeysRefusalReason = 'not_tmux' | 'session_gone' | 'invalid_pid' | 'prompt_open' | OutboundRefusal;
export type KeysResult = { status: 'sent' } | { status: 'refused'; reason: KeysRefusalReason };

type KeysDeps = {
  has?: (n: string) => boolean;
  /** The tmux exec for every outbound call this function makes -- the
   *  keystroke pair AND the three-call paste path -- so a test captures all
   *  of them, in order, through one mock. Widened to TmuxExec because
   *  load-buffer takes its text on stdin; a mock written as
   *  `(args: string[]) => TmuxResult` is still assignable, so every existing
   *  test keeps compiling unchanged. */
  send?: TmuxExec;
  capture?: (args: string[]) => TmuxResult;
  promptOpen?: (pid: number) => boolean;
  /** Injectable in place of the real between-attempt wait
   *  waitForPasteToSettle (below) uses -- see defaultSleep's doc comment.
   *  The one production caller never passes this. */
  sleep?: (ms: number) => void;
};

/** Counter behind nextPasteBuffer, below. */
let pasteBufferSeq = 0;

/** A fresh buffer name for one send. Never a fixed literal, and this is a
 *  correctness requirement rather than tidiness: tmux REPLACES a named
 *  buffer instead of creating a second one, and the buffer namespace is
 *  shared by every client of a tmux server. Two instances of this app on
 *  one server (an orphaned dev build alongside a fresh one, which has
 *  happened) would interleave as A.load, B.load, A.paste -- and A would
 *  deliver B's text into A's session AND submit it, reporting success.
 *
 *  The pid separates instances; the counter separates sends within one.
 *  Not random: there is nothing to make unguessable here, and a readable
 *  name stays greppable in `tmux list-buffers`. Checked against
 *  TMUX_BUFFER (tmux.ts) before it can become a tmux target. */
function nextPasteBuffer(): string {
  pasteBufferSeq += 1;
  return `llmws-p${process.pid}-${pasteBufferSeq}`;
}

/** Lines captured both for the pre-send liveness check and, for a
 *  multi-line send, as the "before" snapshot waitForPasteToSettle (below)
 *  compares against. Wider than a bare liveness probe needs: the input box
 *  a paste lands in can span more than one line, and a change confined to
 *  line 2 or 3 would be invisible to a single-line capture. Exported only
 *  so tests can size their own fixtures against it, not to make it
 *  configurable. */
export const PASTE_SETTLE_CAPTURE_LINES = 8;

/** Bounds for the settle-poll between a successful paste and sending Enter
 *  (waitForPasteToSettle below). tmux reporting paste-buffer as successful
 *  only means it delivered the bytes -- it says nothing about whether the
 *  receiving program has finished acting on them. Claude Code is an Ink
 *  TUI: it accumulates a bracketed paste until the closing marker and can
 *  still be mid-ingest when the next command reaches the pane, which is
 *  what swallows the Enter that follows too closely behind. 10 attempts of
 *  30ms give ~300ms of budget for a slow run while returning almost
 *  immediately once a change is actually observed on a fast one. Exported
 *  only so tests can size their own fixtures against them, not to make
 *  either one configurable. */
export const PASTE_SETTLE_ATTEMPTS = 10;
export const PASTE_SETTLE_INTERVAL_MS = 30;

/** Real between-attempt wait for waitForPasteToSettle below. This send path
 *  is fully synchronous end to end (every tmux call is execFileSync), so
 *  there is no async context to await a delay from -- Atomics.wait on a
 *  throwaway SharedArrayBuffer is Node's ordinary way to block the current
 *  thread for a bounded time without one. Injectable (KeysDeps.sleep) so
 *  tests can drive the settle loop deterministically, including its
 *  timeout path, without ever waiting in real time; the one production
 *  caller never passes a replacement. */
function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Blocks this (synchronous) send path until the pane's content differs
 *  from `before`, or the budget above elapses -- whichever comes first.
 *  Compares for ANY change, never for the pasted text itself: Claude Code
 *  collapses a large paste in its input box into a placeholder like
 *  "[Pasted text #1 +12 lines]" rather than echoing it literally, so there
 *  is no substring of the original message to look for even when the paste
 *  landed exactly as sent. Returns whether a change was observed; the
 *  caller sends Enter either way regardless of the result -- see the call
 *  site in sendKeysFor for why a timeout here must never become a refusal. */
function waitForPasteToSettle(
  name: string, before: string,
  capture: ((args: string[]) => TmuxResult) | undefined,
  sleep: (ms: number) => void,
): boolean {
  for (let attempt = 0; attempt < PASTE_SETTLE_ATTEMPTS; attempt++) {
    if (attempt > 0) sleep(PASTE_SETTLE_INTERVAL_MS);
    const now = capturePane(name, PASTE_SETTLE_CAPTURE_LINES, capture);
    if (now.ok && now.stdout !== before) return true;
  }
  return false;
}

/** The renderer sends a pid and text, never a session name. Refusals are
 *  returned, not thrown: the card has to be able to say WHY nothing happened,
 *  and "not_tmux" is the ordinary answer for a session running in plain iTerm. */
export function sendKeysFor(pid: unknown, raw: unknown, deps: KeysDeps = {}): KeysResult {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { status: 'refused', reason: 'invalid_pid' };
  }
  // Sanitise BEFORE resolving, so malformed text never reaches tmux even
  // momentarily, and the cheap check runs first. Multi-line is allowed
  // here, but ONLY because the branch below routes it to a bracketed paste
  // -- the keystroke path never sees a newline (see the send block).
  const clean = sanitizeOutbound(raw, { multiline: true });
  if (!clean.ok) return { status: 'refused', reason: clean.reason };

  // tmuxNameForPid distinguishes "never registered" (an ordinary iTerm
  // session -- not_tmux) from "registered, but the tmux session has since
  // died" (session_gone). resolveLiveTmux alone collapses both into null,
  // and the reply card shows the user different text for each.
  const known = tmuxNameForPid(pid);
  if (known === null) return { status: 'refused', reason: 'not_tmux' };
  const name = resolveLiveTmux(pid, { has: deps.has });
  if (name === null) return { status: 'refused', reason: 'session_gone' };

  // A choice is open: typed text plus Enter would pick the highlighted
  // option, not what was typed. Refuse; the Terminal view answers it.
  const promptOpen = deps.promptOpen ?? (p => promptOpenFor(p, {
    cached: cachedPushOpenSessions, processes: getCachedLiveProcesses(), read: readLiveSession,
  }));
  if (promptOpen(pid)) return { status: 'refused', reason: 'prompt_open' };

  // The session name resolving is not proof the pane is still there to
  // receive anything -- re-check the pane itself, immediately before
  // sending, rather than trusting a name that was live a moment ago. For a
  // multi-line send this same capture doubles as the "before" snapshot
  // waitForPasteToSettle compares against below, which is why it captures
  // PASTE_SETTLE_CAPTURE_LINES rather than just one.
  const captured = capturePane(name, PASTE_SETTLE_CAPTURE_LINES, deps.capture);
  if (!captured.ok) return { status: 'refused', reason: 'session_gone' };

  if (clean.text.includes('\n')) {
    // Bracketed paste (spec 2026-09-15-conversation-pane-design.md §3.4).
    // Three calls, never concatenated: load the text into a buffer of our
    // own, paste it as bracketed text and delete the buffer in the same
    // command, then send Enter as a key name our code chose. A failed load
    // or paste refuses BEFORE any Enter goes out, so a half-delivered
    // message is never submitted.
    //
    // What makes the embedded newlines safe to send at all is that the
    // pasted text cannot break out of its own brackets -- which holds only
    // because sanitizeOutbound stripped ESC and 8-bit CSI above. See the
    // doc comment on pasteBuffer (src/main/tmux.ts) for the full argument.
    const buffer = nextPasteBuffer();
    const loaded = loadBuffer(name, buffer, clean.text, deps.send);
    if (!loaded.ok) {
      // The user is shown a generic "That session has ended."; the actual
      // tmux error would otherwise be discarded entirely.
      console.error('tmux load-buffer failed:', loaded.error);
      return { status: 'refused', reason: 'session_gone' };
    }
    const pasted = pasteBuffer(name, buffer, deps.send);
    if (!pasted.ok) {
      console.error('tmux paste-buffer failed:', pasted.error);
      // -d only deletes the buffer on a paste that happened. Buffer names
      // are per-send, so nothing later overwrites this one and it would sit
      // on the tmux server for as long as the server lives.
      const dropped = deleteBuffer(buffer, deps.send);
      if (!dropped.ok) console.error('tmux delete-buffer failed:', dropped.error);
      return { status: 'refused', reason: 'session_gone' };
    }
    // The paste has landed as far as tmux is concerned, but the receiving
    // program (an Ink TUI) may still be mid-ingest of the bracketed-paste
    // sequence -- an Enter that arrives too soon gets swallowed along with
    // it. Give it a bounded chance to visibly react before sending Enter.
    // A timeout is logged, never turned into a refusal: the paste has
    // already landed either way, and refusing would invite a retry that
    // duplicates text already sitting in the pane's input line.
    if (!waitForPasteToSettle(name, captured.stdout, deps.capture, deps.sleep ?? defaultSleep)) {
      console.error('tmux paste settle timed out, sending Enter anyway:', { pid, name });
    }
    // The paste has already landed in the session by this point, so a
    // failed Enter is logged, not refused: refusing here would tell the
    // user the send failed and invite a retry, which would submit a
    // duplicate of text that is already sitting in the pane's input line.
    const entered = sendKeyName(name, 'Enter', deps.send);
    if (!entered.ok) console.error('tmux send-keys (Enter) failed:', entered.error);
    return { status: 'sent' };
  }

  // Two calls, always. Text with -l; Enter as a key name our code chose.
  // Concatenating them would let a reply of "Enter" become a keypress.
  // Reached only when the text has no newline at all, which is exactly what
  // the strict sanitiser would have required of it.
  sendLiteral(name, clean.text, deps.send);
  // As above: the text is already typed into the pane, so a failed Enter is
  // logged rather than turned into a refusal, which would invite a retry
  // and duplicate the typed text on next send.
  const entered = sendKeyName(name, 'Enter', deps.send);
  if (!entered.ok) console.error('tmux send-keys (Enter) failed:', entered.error);
  return { status: 'sent' };
}

// ---------------------------------------------------------------------
// The terminal streaming bridge -- session:attach/detach/resize/raw, and
// the 'terminal:data' push they feed. The original design ran tmux
// headless: it copied output out by hand with pipe-pane into a fifo and
// poked keys in with send-keys, but never attached a real client. That is
// where every pain point came from -- tmux never learned the widget's
// size (so main had to resize the window by hand before every capture),
// there was no attached client to trigger a redraw (so a fixed settle
// delay stood in for one), and the fifo needed its own directory
// permissions and cleanup.
//
// This attaches a REAL client instead: `tmux attach -t =name:` runs
// inside a node-pty, and that pty's bytes are what the widget renders.
// node-pty gives tmux a real terminal, so pty.resize() makes tmux resize
// the window itself -- no resize-window call, no settle wait, no size
// race -- and tmux redraws the full screen on attach, already at the
// right size, so there is no backlog to capture or replay either. The
// tmux SESSION still outlives the app: killing the pty only detaches this
// one client, the same as closing a real terminal window would.
// ---------------------------------------------------------------------

function validSize(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** pid -> transport for a session's live output: the pty running `tmux
 *  attach`, and the coalescer batching its bytes into 'terminal:data'
 *  pushes. Keyed by pid, never by tmux name, because a pid is the only
 *  identifier the renderer ever holds (same premise as sessions.ts's own
 *  byPid registry). */
type Attachment = { name: string; pty: IPty; coalescer: Coalescer };
const attachments = new Map<number, Attachment>();

export type AttachRefusalReason = 'invalid_pid' | 'invalid_size' | 'not_tmux' | 'session_gone';
export type AttachResult =
  | { status: 'attached' }
  | { status: 'refused'; reason: AttachRefusalReason };

type AttachDeps = {
  has?: (n: string) => boolean;
  /** Injectable in place of node-pty's own `spawn` -- lets a test capture
   *  or fake the IPty a call creates (to assert on its resize/kill/onData)
   *  without substituting anything for the real tmux binary underneath.
   *  Defaults to node-pty's real spawn. */
  spawn?: typeof ptySpawn;
  /** Threaded straight through to makeCoalescer's own injectable `schedule`
   *  (src/main/stream.ts) -- undefined here means undefined there, which
   *  falls back to its real `setTimeout(fn, COALESCE_MS)` default, so this
   *  changes nothing for the one production caller (session:attach, which
   *  never passes it). Exists so a test asserting on detachTerminal's own
   *  explicit flushNow can remove the coalescer's internal auto-flush as a
   *  competing timer entirely, rather than racing it with a sleep -- see
   *  tests/main/stream-bridge.test.ts's "flushNow throws" test. */
  schedule?: (fn: () => void) => void;
  /** Injectable in place of tmux.ts's real defaultExec, for setSessionOption
   *  below -- lets a test capture that call's argv without a real tmux
   *  binary underneath, the same role `capture`/`send` play for KeysDeps. */
  setOption?: (args: string[]) => TmuxResult;
};

/** session:attach. Spawns `tmux attach -t =name:` inside a pty sized to
 *  cols/rows, and feeds every byte it prints to a coalescer whose emit
 *  pushes 'terminal:data' at this window. TERM is set explicitly to a
 *  colour-capable value -- without it neither tmux nor a full-screen
 *  program inside it (Claude Code) renders colour, since node-pty's
 *  default env is a copy of this process's own (a GUI app's environment
 *  frequently has no TERM at all).
 *
 *  Idempotent: a second attach for an already-attached pid is a no-op
 *  success. Without this, a renderer that calls attach twice for the same
 *  pid (a remount, a reconnect) would leak a second pty and coalescer on
 *  top of the first -- and a second real `tmux attach` client alongside
 *  the first, which tmux would happily allow. */
export async function attachTerminal(
  rawPid: unknown, cols: unknown, rows: unknown, win: BrowserWindow, deps: AttachDeps = {},
): Promise<AttachResult> {
  if (typeof rawPid !== 'number' || !Number.isInteger(rawPid) || rawPid <= 0) {
    return { status: 'refused', reason: 'invalid_pid' };
  }
  const pid = rawPid;

  // Same not_tmux/session_gone split as sendKeysFor -- see its doc comment.
  const known = tmuxNameForPid(pid);
  if (known === null) return { status: 'refused', reason: 'not_tmux' };
  const name = resolveLiveTmux(pid, { has: deps.has });
  if (name === null) return { status: 'refused', reason: 'session_gone' };

  if (attachments.has(pid)) return { status: 'attached' };

  if (!validSize(cols) || !validSize(rows)) return { status: 'refused', reason: 'invalid_size' };

  // A session this app did not create -- adopted from iTerm, or from a
  // previous run of this app -- never went through launchSession's own
  // setSessionOption call, so tmux's mouse support (off by default) is
  // still off for it. Set it here too, right before the real client
  // attaches, so every attach -- created or adopted -- ends up scrollable.
  // Session-scoped (never -g): see setSessionOption's own doc comment.
  setSessionOption(name, 'mouse', 'on', deps.setOption);
  // Same reasoning, same site, for tmux's own status line (see
  // launchSession's doc comment in launch.ts) -- an adopted session skipped
  // launchSession entirely, so this is the only place it is ever turned off
  // for one. Session-scoped, never -g.
  setSessionOption(name, 'status', 'off', deps.setOption);

  const spawn = deps.spawn ?? ptySpawn;
  const clientPty = spawn('tmux', ['attach', '-t', `=${name}:`], {
    cols, rows,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const coalescer = makeCoalescer(pid, (payload: TerminalDataPayload) => {
    if (!win.isDestroyed()) win.webContents.send('terminal:data', payload);
  }, deps.schedule);
  clientPty.onData(chunk => coalescer.push(chunk));

  attachments.set(pid, { name, pty: clientPty, coalescer });

  return { status: 'attached' };
}

/** session:detach. Idempotent -- detaching a pid with no attachment is a
 *  no-op success, not an error: the renderer may call this defensively
 *  (e.g. on unmount) without knowing whether attach ever actually
 *  completed for it. Kills only the PTY -- the `tmux attach` client
 *  process -- never the tmux session itself: exactly like closing a real
 *  terminal window, the session and everything running inside it (the
 *  agent process, its shell) keeps running under the tmux server. */
export function detachTerminal(rawPid: unknown): { status: 'detached' } {
  const pid = typeof rawPid === 'number' ? rawPid : NaN;
  const existing = attachments.get(pid);
  if (!existing) return { status: 'detached' };
  attachments.delete(pid);

  // flushNow's emit calls win.webContents.send (attachTerminal above) --
  // if the window is already half-destroyed that can throw, and without
  // this try/finally the pty below would never be killed, leaking the
  // client and its coalescer. Cleanup does not depend on the flush having
  // succeeded, so it belongs in finally, not after a call that might not
  // return.
  try {
    existing.coalescer.flushNow();
  } finally {
    // Default signal is SIGHUP -- the same signal a closed terminal window
    // sends its foreground process, which is exactly what detaching a real
    // tmux client looks like. IPty.kill swallows a "no such process" error
    // internally, so this is safe even if the client has already exited on
    // its own (the tmux session ended, say).
    existing.pty.kill();
  }
  return { status: 'detached' };
}

/** Every live attachment's pty and coalescer, torn down unconditionally.
 *  Called once from app.on('before-quit') in registerIpc below, so a
 *  renderer that never gets to run its own cleanup on the way out (Cmd+Q)
 *  does not leave an orphaned tmux client running after this process
 *  exits. */
export function detachAllTerminals(): void {
  for (const pid of [...attachments.keys()]) detachTerminal(pid);
}

export type ResizeRefusalReason = 'invalid_pid' | 'invalid_size' | 'not_tmux' | 'session_gone';
export type ResizeResult = { status: 'resized' } | { status: 'refused'; reason: ResizeRefusalReason };

/** session:resize. Resizes the PTY, not tmux directly -- because this pty
 *  is a real attached client, tmux itself follows its client's size, the
 *  same way it follows a real terminal window being resized. Unlike
 *  sendKeysFor, there is no extra freshness check before acting -- a
 *  resize fires on every widget resize, far more often than a reply is
 *  sent, and resolveLiveTmux's own liveness check is enough for an action
 *  this frequent and this harmless to repeat.
 *
 *  A pid with no live attachment yet (the widget's first resize, from its
 *  own initial fit, can race ahead of the attach call that will create the
 *  pty) is treated as refused rather than silently doing nothing -- there
 *  is genuinely nothing to resize yet, and the pty attachTerminal spawns
 *  moments later is sized correctly from the start regardless. */
export function resizeTerminal(
  rawPid: unknown, cols: unknown, rows: unknown,
  deps: { has?: (n: string) => boolean } = {},
): ResizeResult {
  if (typeof rawPid !== 'number' || !Number.isInteger(rawPid) || rawPid <= 0) {
    return { status: 'refused', reason: 'invalid_pid' };
  }
  if (!validSize(cols) || !validSize(rows)) return { status: 'refused', reason: 'invalid_size' };

  const known = tmuxNameForPid(rawPid);
  if (known === null) return { status: 'refused', reason: 'not_tmux' };
  const name = resolveLiveTmux(rawPid, { has: deps.has });
  if (name === null) return { status: 'refused', reason: 'session_gone' };

  const existing = attachments.get(rawPid);
  if (!existing) return { status: 'refused', reason: 'session_gone' };

  existing.pty.resize(cols, rows);
  return { status: 'resized' };
}

export type RawRefusalReason = 'invalid_pid' | 'invalid_data' | 'not_tmux' | 'session_gone';
export type RawResult = { status: 'sent' } | { status: 'refused'; reason: RawRefusalReason };

/** session:raw -- the terminal widget's own keystrokes: arrow keys, Ctrl-C,
 *  whatever a TUI's own prompts need (e.g. the Claude Code trust prompt).
 *  Written straight to the attached client's own pty, exactly as a real
 *  terminal would deliver them, which is what lets tmux's own key
 *  processing see them as real input rather than an injected command.
 *  Deliberately skips sanitizeOutbound (src/main/outbound.ts), unlike
 *  session:keys/sendKeysFor above: that sanitiser exists to stop a REPLY
 *  smuggling control bytes past what the popover showed as plain text.
 *  Here, control bytes are not a smuggling risk -- they are the entire
 *  point. Still resolves through the same not_tmux/session_gone checks as
 *  every other tmux-writing channel, plus the same "no live attachment
 *  yet" refusal resizeTerminal uses above: skipping the outbound sanitiser
 *  does not mean skipping "is this pid even a live, attached tmux
 *  session", and there is no pty to write into before attach creates one. */
export function sendRawFor(
  rawPid: unknown, data: unknown, deps: { has?: (n: string) => boolean } = {},
): RawResult {
  if (typeof rawPid !== 'number' || !Number.isInteger(rawPid) || rawPid <= 0) {
    return { status: 'refused', reason: 'invalid_pid' };
  }
  if (typeof data !== 'string' || data.length === 0) return { status: 'refused', reason: 'invalid_data' };

  const known = tmuxNameForPid(rawPid);
  if (known === null) return { status: 'refused', reason: 'not_tmux' };
  const name = resolveLiveTmux(rawPid, { has: deps.has });
  if (name === null) return { status: 'refused', reason: 'session_gone' };

  const existing = attachments.get(rawPid);
  if (!existing) return { status: 'refused', reason: 'session_gone' };

  existing.pty.write(data);
  return { status: 'sent' };
}

export type ThemeResult = { status: 'set'; theme: ThemeChoice } | { status: 'refused' };

type ThemeDeps = {
  setSource?: (theme: ThemeChoice) => void;
  persist?: (theme: ThemeChoice) => void;
};

/** app:theme -- the renderer's appearance choice, reaching the WINDOW.
 *
 *  data-theme on the root element only restyles the page; native
 *  scrollbars, the folder picker and the title bar follow nativeTheme,
 *  which only main can set. The value is checked against the three
 *  literals HERE, before it reaches nativeTheme or the file: the renderer
 *  can call any exposed channel with any argument, whatever the preload's
 *  TypeScript says, so this is the boundary, not the typing.
 *
 *  Both effects are injectable because under plain-Node vitest the electron
 *  import is a stub and `nativeTheme` binds to undefined (see this file's
 *  own note on ipcMain at the top). The defaults are built lazily inside
 *  the call, so nothing dereferences the stub at module scope. */
export function applyThemeChoice(raw: unknown, deps: ThemeDeps = {}): ThemeResult {
  if (raw !== 'system' && raw !== 'light' && raw !== 'dark') return { status: 'refused' };
  const theme: ThemeChoice = raw;
  (deps.setSource ?? ((t: ThemeChoice) => { nativeTheme.themeSource = t; }))(theme);
  // Mirrored for the next launch's first frame only -- see
  // src/main/appearance.ts's doc comment.
  (deps.persist ?? ((t: ThemeChoice) => writeStoredTheme(resolvePaths(homedir()).appearance, t)))(theme);
  return { status: 'set', theme };
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
 *  can call registerIpc(db) alone.
 *
 *  `onSessionKill`, if given, fires strictly after session:kill's own reply
 *  is already on its way to the renderer (same setImmediate-deferral
 *  reasoning as onFleetList above), and only when the result was actually
 *  'killed' -- a refusal or an already-gone pid changes nothing discovery
 *  doesn't already reflect (killSession's own pre-signal refresh already
 *  covers those), so there is nothing for a fresh sweep to usefully catch.
 *  Wired from src/main/index.ts to re-run discovery and push immediately,
 *  rather than leaving the killed pid's card to go stale for up to 5s
 *  until the next scheduled sweep.
 *
 *  `onSessionLaunch`, if given, fires the same way after session:launch or
 *  session:reattach actually starts a new process ('launched', never
 *  'failed') -- same reasoning as onSessionKill above: a session appearing
 *  is exactly the kind of change only a fresh discovery sweep can surface,
 *  and the card should not sit stale for up to 5s waiting for the next
 *  scheduled one. */
export function registerIpc(
  db: Db, onFleetList?: () => void, onSessionKill?: () => void, onSessionLaunch?: () => void,
): void {
  ipcMain.handle('fleet:list', () => {
    const payload = buildFleetListPayload();
    if (onFleetList) setImmediate(onFleetList);
    return payload;
  });
  ipcMain.handle('fleet:history', (_event, offset: unknown, limit: unknown) =>
    buildFleetHistoryPayload(db, clampOffset(offset), clampLimit(limit)));
  ipcMain.handle('session:reveal', (_event, pid: unknown) => revealSession(pid));
  ipcMain.handle('session:kill', async (_event, pid: unknown) => {
    const result = await killSession(pid);
    if (onSessionKill && result.status === 'killed') setImmediate(onSessionKill);
    return result;
  });
  ipcMain.handle('session:conversation', (_event, sessionId: unknown, cursor: unknown) =>
    typeof sessionId === 'string'
      ? conversationFor(db, sessionId, undefined, parseConversationCursor(cursor))
      : { turns: [], nextCursor: null });
  ipcMain.handle('session:keys', (_event, pid: unknown, text: unknown) => sendKeysFor(pid, text));
  ipcMain.handle('app:theme', (_event, theme: unknown) => applyThemeChoice(theme));

  // The streaming bridge (Task 6b): attach/detach/resize/raw, replacing
  // Task 6's TEMPORARY not_implemented stubs in place -- not a second
  // ipcMain.handle for any of these four channels, which Electron would
  // throw on. session:launch/session:reattach were also stubbed the same
  // way; Task 13 replaces those two below.
  //
  // BrowserWindow.fromWebContents(event.sender), not a module-level
  // "mainWindow" reference: this handler already receives the exact
  // WebContents that asked to attach, which is more precise than assuming
  // a single captured window, and needs no extra wiring from
  // src/main/index.ts to thread a window reference in here.
  ipcMain.handle('session:attach', (event, pid: unknown, cols: unknown, rows: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { status: 'refused', reason: 'session_gone' };
    return attachTerminal(pid, cols, rows, win);
  });
  ipcMain.handle('session:detach', (_event, pid: unknown) => detachTerminal(pid));
  ipcMain.handle('session:resize', (_event, pid: unknown, cols: unknown, rows: unknown) =>
    resizeTerminal(pid, cols, rows));
  ipcMain.handle('session:raw', (_event, pid: unknown, data: unknown) => sendRawFor(pid, data));

  // LaunchBar's "Choose…" button -- an alternative to typing the working
  // directory by hand, not a new trust boundary: this returns exactly the
  // path Electron's native dialog handed back, chosen by the person at the
  // keyboard, and session:launch below still runs it through
  // isAbsolutePath itself rather than trusting that this picker guarantees
  // an absolute path. BrowserWindow.fromWebContents(event.sender), same
  // pattern as session:attach above, so the dialog opens as a sheet on
  // macOS rather than a detached window; a missing window (should not
  // happen in practice) falls back to the windowless form, which Electron
  // still shows as a standalone dialog. null means either the user
  // cancelled or nothing was chosen -- the renderer treats both the same
  // way (leave whatever was already typed alone).
  ipcMain.handle('dialog:directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Choose a working directory',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'Choose a working directory',
          properties: ['openDirectory', 'createDirectory'],
        });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // session:launch/session:reattach (Task 13, src/main/launch.ts). The
  // renderer sends only a provider/pid, an explicit user-chosen directory,
  // and a size -- main re-derives the tmux session name, resolves the
  // existing session (reattach), and runs the actual tmux commands itself,
  // same trust boundary as every destructive channel above.
  ipcMain.handle('session:launch', (_event, provider: unknown, cwd: unknown, cols: unknown, rows: unknown) => {
    if (!isProvider(provider)) return { status: 'failed', reason: 'unrecognised provider' };
    if (typeof cwd !== 'string' || !isAbsolutePath(cwd)) {
      return { status: 'failed', reason: 'choose a working directory first' };
    }
    if (!validSize(cols) || !validSize(rows)) return { status: 'failed', reason: 'invalid terminal size' };
    const result: LaunchResult = launchSession(provider, cwd, cols, rows);
    if (onSessionLaunch && result.status === 'launched') setImmediate(onSessionLaunch);
    return result;
  });
  ipcMain.handle('session:reattach', async (_event, pid: unknown, cols: unknown, rows: unknown) => {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return { status: 'failed', reason: 'invalid pid' };
    }
    if (!validSize(cols) || !validSize(rows)) return { status: 'failed', reason: 'invalid terminal size' };
    const result: LaunchResult = await reattachSession(pid, cols, rows, {
      kill: killSession, resolveSession: resolveSessionForReattach,
      hasTranscript: (sessionId, cwd) => existsSync(join(projectDir(cwd), `${sessionId}.jsonl`)),
    });
    if (onSessionLaunch && result.status === 'launched') setImmediate(onSessionLaunch);
    return result;
  });
  // session:resume -- the recovery path for reattach's own
  // 'killed_not_relaunched' state (src/main/launch.ts's doc comment).
  // Whole-branch review, item 3: this comment used to justify safety by
  // saying the renderer "only echoes back" a prior value -- that is not
  // enforced anywhere. contextBridge exposes `resume` to the entire
  // renderer scope, callable with any arguments; nothing here can tell a
  // value the renderer actually got from an earlier result apart from one
  // it invented. What IS enforced, in order below: sessionId must match
  // resumeSession's own SESSION_ID_SAFE shape (checked again inside
  // resumeSession itself, not only here) before it is ever interpolated
  // into the shell string tmux's new-session command takes; cwd must be an
  // absolute path; and the provider is hardcoded to 'claude' in
  // resumeSession, never taken from the renderer at all.
  ipcMain.handle('session:resume', (_event, sessionId: unknown, cwd: unknown, cols: unknown, rows: unknown) => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { status: 'failed', reason: 'invalid session id' };
    }
    if (typeof cwd !== 'string' || !isAbsolutePath(cwd)) {
      return { status: 'failed', reason: 'choose a working directory first' };
    }
    if (!validSize(cols) || !validSize(rows)) return { status: 'failed', reason: 'invalid terminal size' };
    const result: LaunchResult = resumeSession(sessionId, cwd, cols, rows);
    if (onSessionLaunch && result.status === 'launched') setImmediate(onSessionLaunch);
    return result;
  });

  // Belt-and-suspenders for the fifo transport (attachTerminal's doc
  // comment): session:detach is the normal cleanup path, but a renderer
  // that never gets to run it on the way out (Cmd+Q, a crash) would
  // otherwise leave a fifo under the OS temp dir. before-quit runs
  // regardless of how the app is closing.
  app.on('before-quit', detachAllTerminals);
}

/** Pushed on every watcher/spool/ingest/discovery change (src/main/index.ts).
 *  Still never sends historyCount or the sessions array -- same
 *  FleetListPayload shape fleet:list uses -- but, unlike fleet:list, DOES
 *  enrich openSessions, reading cachedPushOpenSessions (refreshed by
 *  refreshPushEnrichment above, not by this function) rather than
 *  querying: a permanently-null "needs you" chip is worse than the
 *  staleness this trades for (it actively tells David nothing needs him,
 *  which is the one thing it must never do wrongly), but the query behind
 *  it is not cheap enough to run on every push -- see
 *  refreshPushEnrichment's doc comment. Never touches the database
 *  itself, same as buildFleetListPayload. */
export function pushFleet(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const openSessions = cachedPushOpenSessions.map(o => sanitizeFields(o, OPEN_SESSION_SANITISED_FIELDS));
  const payload: FleetListPayload = { version: 1, generatedAt: new Date().toISOString(), openSessions };
  win.webContents.send('fleet:update', payload);
}
