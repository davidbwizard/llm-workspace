import { watch as fsWatch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../store/db.ts';
import type { LiveProcess } from '../discovery/parse.ts';
import { deriveActivity, type OpenSession } from '../fleet/state.ts';
import type { LiveSessionRead, LiveSessionFile } from '../providers/claude/liveSession.ts';
import { readLiveSession } from '../discovery/live.ts';
import { currentBlockers, hasMultiplePromptEvents, openPromptEvent } from '../store/signals.ts';
import { resolvePaths } from '../config.ts';
import type { Provider } from '../core/types.ts';
import type { PromptView } from '../core/prompt.ts';
import { buildPromptView, type AnswerDeps } from './answer.ts';
import { readModeFor, type ModeState } from './mode.ts';
import { tmuxNameForPid } from './sessions.ts';
import { contextForSession, defaultContextOpts } from './usage.ts';
import type { SessionContext } from '../core/usage.ts';

/** The pane's own three-way activity -- collapsed from fleet/state.ts's
 *  five-way Activity because the pane has neither a fleet card's blocker
 *  text nor a separate affordance for "a permission prompt" vs. "a
 *  question": both just mean the pane should show waiting. `error` reads
 *  as idle, since there is nothing further for the strip to say about it. */
export type LiveActivity = 'working' | 'idle' | 'waiting';

export type SessionLivePayload = {
  version: 1;
  pid: number;
  sessionId: string | null;
  /** null means the app cannot tell -- an unmatched pid, or a pid that
   *  matches no session. The pane shows no strip and starts no "not seen"
   *  countdown on it in that case, rather than guessing idle. */
  activity: LiveActivity | null;
  /** Epoch ms this working stretch began, or null when not working or
   *  unknown. Sourced differently per provider -- see the comment on its
   *  computation below for why. */
  since: number | null;
  events: number;
  /** The prompt Claude is waiting on (quick-answers design §5-6), or null:
   *  not waiting, hooks off, or no PermissionRequest matching this wait.
   *  Content comes from the hook payload; permission and plan choices
   *  from the pane. */
  prompt: PromptView | null;
  /** Context window use for the conversation header (usage design, Part
   *  A) -- the same { usedTokens, windowTokens, leftPct } the session's
   *  card carries, or null (no session, or no count yet). */
  context: SessionContext | null;
  /** The permission mode the pane is reporting, and whether the chip may
   *  switch it right now (mode-switcher design §2, §4.1). null means there
   *  is no chip to show at all -- a session this app did not launch has no
   *  pane to read. `mode: null` inside a non-null state means the reader
   *  could not identify the mode: the chip then shows NOTHING rather than
   *  a guess (§5). */
  mode: ModeState | null;
};

/** The pid's live session file, re-read now, trusted only if its startedAt
 *  is the one discovery verified (stable across `/clear`, different for any
 *  other process). null for Codex, for a process discovery never verified,
 *  and for a failed or mismatched read. Shared by Reattach and Reply
 *  (src/main/ipc.ts) so the two cannot drift on what counts as a fresh,
 *  exact read.
 *
 *  Lives here, not in ipc.ts, since Task 6 (session:watch, below) needs
 *  ipc.ts to import buildSessionLive/watchSessionFor from this module --
 *  the reverse import this module had before (of this very function)
 *  would have made that a cycle. ipc.ts imports it back from here for its
 *  own callers (resolveReattachTarget below, promptOpenFor, busyForPid). */
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
 *  refreshPushEnrichment -- both src/main/ipc.ts) rather than running a
 *  query of its own -- reattachSession (src/main/launch.ts) has no database
 *  or discovery access itself, by design, so this is the one place that
 *  resolves the pid before handing it in as an injected dependency.
 *  sessionId is only ever non-null on a `unique` match (OpenSession's own
 *  doc comment, src/fleet/state.ts) -- unique now covers an exact
 *  live-session match as well as a unique cwd match (spec §3.3) -- an
 *  ambiguous or unmatched pid still resolves to null here, which
 *  reattachSession treats as "cannot identify", never a guess.
 *
 *  Exact identity first (spec 2026-09-15-exact-session-identity-design.md
 *  §3.5): the enriched cache can be up to one sweep old, and a `/clear` in
 *  that window changes the session id. Uses freshLiveSession (above) for
 *  that fresh, verified read -- the same helper ipc.ts's promptOpenFor uses,
 *  so the two cannot drift on what counts as fresh. Anything else falls
 *  back to the cache exactly as before.
 *
 *  Moved here alongside freshLiveSession for the same cycle-breaking reason
 *  -- see that function's own doc comment. */
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

/** resolveReattachTarget's cache fallback (above) and freshLiveSession's
 *  fresh re-read, both injectable so tests never touch real files or a real
 *  push-enrichment cache. `cached` defaults to [] rather than requiring it:
 *  a pid resolved through the exact live-session path alone
 *  (freshLiveSession succeeding) never needs it, and this keeps the common
 *  call shape -- db, pid, processes, now -- usable on its own, the same way
 *  killSession/revealSession (src/main/ipc.ts) default their own injectable
 *  pieces to the real implementation. A real caller pushing this to the
 *  renderer should still pass its actual open-session cache, the same one
 *  ipc.ts's own resolveSessionForReattach uses (cachedPushOpenSessions), so
 *  a session that only resolves through the cwd-cache fallback (an
 *  ambiguous-but-launched-by-us Claude session, or any Codex session --
 *  Codex writes no live-session file at all) is still found.
 *
 *  `freshLiveSession`/`resolveReattachTarget` default to the real functions
 *  above when omitted -- overriding them is only ever exercised by a test
 *  that wants to fake the resolution step itself without also faking every
 *  process/read detail those functions read through. */
export interface SessionLiveDeps {
  cached?: OpenSession[];
  read?: (pid: number) => LiveSessionRead;
  freshLiveSession?: (pid: number, processes: LiveProcess[], read: (pid: number) => LiveSessionRead) => LiveSessionFile | null;
  resolveReattachTarget?: (
    pid: number,
    deps: { cached: OpenSession[]; processes: LiveProcess[]; read: (pid: number) => LiveSessionRead },
  ) => { sessionId: string; provider: Provider; cwd: string } | null;
  /** The pane read behind the prompt's choices (buildPromptView,
   *  src/main/answer.ts). Only `capture` is used here; tests inject it so
   *  they never run a real tmux. */
  answer?: AnswerDeps;
  /** Quick answers (Task 6 flash fix): called once, only when the live
   *  status is `waiting`, before the open prompt is looked up. Claude
   *  writes the PermissionRequest ~20 ms after it flips the status, and
   *  the status-file push runs ~250 ms after the flip -- so ingesting here
   *  puts the event in the db for this very push, instead of the next 1 s
   *  spool tick. session:watch (src/main/ipc.ts) wires the real spool. */
  ingestSpool?: () => void;
  /** Context for a session (usage design, Part A). Defaults to
   *  src/main/usage.ts's contextForSession with the real status line and
   *  Codex folders; tests inject it so they never read the real home. */
  context?: (sessionId: string, provider: Provider) => SessionContext | null;
  /** The chip's state (mode-switcher design §2). Defaults to readModeFor
   *  (src/main/mode.ts), which is at most ONE capture-pane per push and
   *  none at all for a session this app did not launch.
   *
   *  Injectable so tests never run a real tmux -- and so the ONE caller
   *  that builds a payload purely to reach `.prompt` (session:answer's
   *  currentPrompt closure, src/main/ipc.ts) can pass `() => null` and skip
   *  the capture entirely: it is answering a prompt, not drawing a chip. */
  mode?: (pid: number) => ModeState | null;
}

/** Wraps `read` so a single buildSessionLive call never opens the same
 *  pid's live-session file twice -- resolveReattachTarget (below) and the
 *  direct freshLiveSession call both need a fresh read of the SAME pid,
 *  and the file cannot have changed between the two calls within one
 *  synchronous function body, so the second read is pure duplicated I/O. */
function memoizeRead(read: (pid: number) => LiveSessionRead): (pid: number) => LiveSessionRead {
  let cached: { pid: number; result: LiveSessionRead } | null = null;
  return (pid: number) => {
    if (cached && cached.pid === pid) return cached.result;
    const result = read(pid);
    cached = { pid, result };
    return result;
  };
}

/** One session's live state for the conversation pane -- working / idle /
 *  waiting, and when the current working stretch began. Task 5 of
 *  2026-09-17-live-conversation-feedback: built here, in main, so a later
 *  task can push it on the same fast (watcher/spool/ingest) cadence
 *  fleet:update already uses, rather than the 5s discovery interval the
 *  pane currently waits on.
 *
 *  Returns null only for a pid with no matching live process at all -- an
 *  unknown pid is not answered, mirroring freshLiveSession's own "not this
 *  process" guard. A live process that cannot be resolved to any session
 *  still gets an answer, with every session-derived field null (sessionId,
 *  activity, since) -- the app tried and genuinely cannot tell, which is a
 *  different fact from "this pid does not exist" and the caller (a later
 *  task) needs to tell the two apart to decide whether to show the pane at
 *  all. */
export function buildSessionLive(
  db: Db, pid: number, processes: LiveProcess[], now: number = Date.now(), deps: SessionLiveDeps = {},
): SessionLivePayload | null {
  const proc = processes.find(p => p.pid === pid);
  if (!proc) return null;

  const read = memoizeRead(deps.read ?? readLiveSession);
  // Same helper Reattach/Reply already trust for this exact question
  // (src/main/ipc.ts): exact live-session identity first, falling back to
  // the cwd-matched cache -- see this module's own SessionLiveDeps comment
  // for why `cached` defaults to []. deps.resolveReattachTarget defaults to
  // the real function above -- see SessionLiveDeps' own comment on why that
  // override exists at all.
  const resolveTarget = deps.resolveReattachTarget ?? resolveReattachTarget;
  const target = resolveTarget(pid, { cached: deps.cached ?? [], processes, read });
  // The chip's state (mode-switcher design §2). Built here rather than
  // inside readModeFor's own defaults because this function already holds
  // both things that decide it: `proc.provider` (which menu, which reader)
  // and, below, the activity the whole pane is already drawn from.
  //
  // Blocking the chip off `activity` keeps it agreeing with what the pane
  // is showing: `waiting` means a prompt card or the waiting fallback is
  // up, and a wait without an identified prompt card is exactly the case
  // where the pane may be showing a question -- §4.1's "Shift+Tab into a
  // question does something else entirely".
  //
  // `working` deliberately does NOT block (2026-09-22): a live pane
  // honoured Shift+Tab mid-turn, so the old block bought nothing and left
  // the chip dead for most of the time the pane is worth looking at. See
  // ModeDeps.promptOpen (src/main/mode.ts) for the measurement. A null
  // activity (the app genuinely cannot tell) does not block either. main
  // re-checks all of this independently before it presses anything
  // (setModeFor), so the chip's state is a hint, never the authority.
  const readMode = (activity: LiveActivity | null): ModeState | null => (deps.mode ?? ((p: number) => readModeFor(p, {
    provider: () => proc.provider,
    promptOpen: () => activity === 'waiting',
  })))(pid);

  // The chip belongs to the PANE, not to a matched session, so a live
  // process this app launched but cannot resolve to any recorded session
  // still has a readable, switchable mode.
  if (!target) {
    return {
      version: 1, pid, sessionId: null, activity: null, since: null, events: 0,
      prompt: null, context: null, mode: readMode(null),
    };
  }

  // `last_kind`/`events` deliberately read every row for this session_id,
  // INCLUDING a Codex subagent thread's own rows (they share the root
  // thread's session_id but carry a non-null agent_id -- src/providers/
  // codex/parse.ts's threadAgentId). This matches fleetState's/
  // openSessionsLive's own last_kind subquery (src/fleet/state.ts)
  // exactly, unfiltered -- deriveActivity below is "the cards' activity
  // rule" (see its doc comment), and the pane must be fed the identical
  // signal or it could show a different state than the card for the same
  // session at the same instant.
  //
  // `last_prompt_ts` is scoped to `agent_id IS NULL` on purpose, NOT
  // matching that: it exists only to time "since" for a working Codex
  // session (below), and the pane shows only the root thread's own
  // messages (conversationFor, src/store/conversation.ts, applies the same
  // agent_id IS NULL scope for the same reason) -- a subagent dispatched
  // mid-turn can submit its own prompt.submitted row under the same
  // session_id, and timing "since" from THAT would show a start time that
  // does not correspond to anything the pane displays.
  const row = db.prepare(`
    SELECT COUNT(*) AS events, MAX(ts) AS last_ts,
      (SELECT k.kind FROM events k WHERE k.session_id = e.session_id
        ORDER BY k.ts DESC, k.id DESC LIMIT 1) AS last_kind,
      (SELECT p.ts FROM events p WHERE p.session_id = e.session_id AND p.kind = 'prompt.submitted'
          AND p.agent_id IS NULL
        ORDER BY p.ts DESC, p.id DESC LIMIT 1) AS last_prompt_ts
    FROM events e WHERE e.session_id = ?
  `).get(target.sessionId) as {
    events: number; last_ts: string | null; last_kind: string | null; last_prompt_ts: string | null;
  };

  const fresh = (deps.freshLiveSession ?? freshLiveSession)(pid, processes, read);
  // A failed ingest must not stop the push: the prompt then arrives with
  // the next spool tick, as before. Logged with its message, never swallowed.
  if (fresh?.status === 'waiting' && deps.ingestSpool) {
    try {
      deps.ingestSpool();
    } catch (err) {
      console.error('Quick answers: spool ingest before the waiting push failed:', err instanceof Error ? err.message : String(err));
    }
  }
  // Quick answers §5.2: a live status file outranks a blocker, even one
  // whose status string this code does not recognise -- so the blocker
  // (a 24 h scan of signal_events) is only looked up with no status file at
  // all (final review I2/I4), matching openSessionsLive for the cards.
  const blocker = fresh === null
    ? currentBlockers(db, now).find(b => b.sessionId === target.sessionId) ?? null
    : null;

  const { activity: rawActivity } = deriveActivity({
    lastTs: row.last_ts, lastKind: row.last_kind, blocker,
    // Always true: buildSessionLive only ever runs for a pid it has
    // already matched to this session, via resolveReattachTarget above --
    // by construction there IS a live process for it. The same
    // hasMatchedProcess: true openSessionsLive's own targeted enrichment
    // path uses for exactly this reason (src/fleet/state.ts).
    hasMatchedProcess: true,
    hasLiveSignal: processes.length > 0,
    now,
    liveStatus: fresh?.status ?? null,
    liveWaitingFor: fresh?.waitingFor ?? null,
  });

  // waiting_permission/waiting_input both read as "waiting" here -- the
  // pane has no separate UI for the two (see LiveActivity's doc comment
  // above); `error` reads as idle, since there is nothing further for the
  // strip to say about it.
  const activity: LiveActivity | null =
    rawActivity === 'waiting_permission' || rawActivity === 'waiting_input' ? 'waiting'
      : rawActivity === 'error' ? 'idle'
        : rawActivity;

  // `since` is sourced differently per provider because each has a
  // different notion of "when this turn started" available to it. Claude
  // Code's own status file timestamps the moment it flipped busy
  // (statusUpdatedAtMs, src/providers/claude/liveSession.ts) -- more
  // precise than the transcript (no ingest lag) and the only signal at all
  // for a Claude session with no prompt event ingested yet, right after
  // launch or a /clear. Codex writes no live-session file, so the last
  // root-thread prompt (last_prompt_ts, scoped above) is the only
  // timestamp there is -- and sufficient, since a Codex turn only ever
  // starts from exactly one prompt.
  const since = activity !== 'working' ? null
    : target.provider === 'claude'
      ? (fresh?.status === 'busy' ? fresh.statusUpdatedAtMs ?? null : null)
      : (row.last_prompt_ts ? Date.parse(row.last_prompt_ts) : null);

  // Quick answers §5.1: the open prompt exists only while the status file
  // says waiting, and is the newest PermissionRequest from this wait.
  // waitingSince is statusUpdatedAtMs: Claude writes it only when `status`
  // flips, so it holds still for the whole wait. Without it there is no
  // wait to match an event against, so no prompt (final review M7). The
  // pane is read at most once per push (buildPromptView); a tmux name from
  // the registry is enough to try -- session:answer re-verifies the
  // session is alive.
  const waitingSince = fresh?.status === 'waiting' && typeof fresh.statusUpdatedAtMs === 'number'
    ? fresh.statusUpdatedAtMs
    : null;
  const promptEvent = waitingSince !== null ? openPromptEvent(db, target.sessionId, waitingSince) : null;
  // Two PermissionRequests in one wait: shown, never answered (ambiguity
  // guard; hasMultiplePromptEvents).
  const prompt = promptEvent && waitingSince !== null
    ? buildPromptView(promptEvent, tmuxNameForPid(pid), deps.answer ?? {}, {
      multiplePrompts: hasMultiplePromptEvents(db, target.sessionId, waitingSince),
    })
    : null;

  // One small indexed query plus a stat of one file per push (a Claude
  // snapshot, or a Codex rollout tail-read only when it changed) -- the
  // same source and rule as the cards (src/main/usage.ts).
  const context = deps.context
    ? deps.context(target.sessionId, target.provider)
    : contextForSession(db, target.sessionId, target.provider, defaultContextOpts());

  return {
    version: 1, pid, sessionId: target.sessionId, activity, since,
    events: row.events ?? 0, prompt, context, mode: readMode(activity),
  };
}

// ---------------------------------------------------------------------
// Task 6: pushing buildSessionLive's payload to the open conversation pane
// within ~250ms, instead of leaving it to the 5s discovery sweep. Three
// pieces: watchSessionFor (start/move/stop watching one pid), a fs.watch on
// Claude's own live-session file for that pid's status flips (Codex writes
// no such file, so its sessions rely on the watcher/spool/ingest pushes
// below, the same as the fleet cards already do), and notifySessionChanged
// (the coalesced bridge from those pushes to a session:live send).
// ---------------------------------------------------------------------

/** The one thing this module needs from a real fs.watch -- close(), the
 *  error event a real FSWatcher can emit after the fact (a directory
 *  removed, a filesystem going away), and the change event that is the
 *  whole reason startClaudeWatch opens one. Kept narrow rather than
 *  importing fs.FSWatcher itself so a test's fake never has to impersonate
 *  the whole EventEmitter surface, only the things watchSessionFor actually
 *  calls. */
export interface WatchHandle {
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'change', listener: () => void): void;
  close(): void;
}

/** watchSessionFor's dependencies. Deliberately NOT SessionLiveDeps plus
 *  extras: buildPayload is called fresh on every push (the initial one in
 *  watchSessionFor, and every later one from pushSessionLive), so freshness
 *  -- a session that ends, changes activity, or whose live process
 *  disappears entirely between pushes -- is the caller's job, by reading
 *  its own live sources (db, getCachedLiveProcesses(), the push-enrichment
 *  cache) inside the closure body rather than a snapshot handed in once at
 *  watch time. session:watch's handler (src/main/ipc.ts) is the one real
 *  caller, and binds `pid` and the specific window into these three
 *  closures once, when the watch starts. */
export interface WatchDeps {
  /** The discovery cache, read fresh on every call -- never a value
   *  captured once -- so a pid that has since exited is refused even
   *  though it was live a moment ago. Production passes
   *  getCachedLiveProcesses (src/discovery/live.ts) directly. */
  processes: () => LiveProcess[];
  /** The current payload for the pid this WatchDeps was built for, or null
   *  when that pid no longer resolves to a live process at all --
   *  buildSessionLive's own "not this process" contract (see its doc
   *  comment). A null result is also the release signal: pushSessionLive
   *  (below) tears the watch down on it rather than push nothing and leave
   *  a watcher pointed at a process that is gone. */
  buildPayload: () => SessionLivePayload | null;
  send: (payload: SessionLivePayload) => void;
  /** Wraps fs.watch, injectable so unit tests never touch the real
   *  filesystem or leave a real watcher running past the test. */
  watch?: (path: string) => WatchHandle;
}

function defaultWatch(path: string): WatchHandle {
  return fsWatch(path);
}

interface WatchState {
  pid: number;
  sessionId: string | null;
  watcher: WatchHandle | null;
  timer: NodeJS.Timeout | null;
  deps: WatchDeps;
}

/** The one conversation pane's watch, if any. A module-level singleton, not
 *  per-window state: this app shows one conversation pane at a time (spec
 *  2026-09-17-live-conversation-feedback), and pushSessionLive/
 *  notifySessionChanged both take no pid of their own -- they act on
 *  whichever watch is current, which only makes sense if there is exactly
 *  one. */
let watchState: WatchState | null = null;

/** Releases whatever is currently watched -- the timer first (a pending
 *  coalesced push must never fire after its watcher, and the session it was
 *  for, are gone) and then the watcher itself. Safe to call with nothing
 *  watched (every call site, including every early-return in
 *  watchSessionFor below, goes through this rather than checking first). */
function teardownWatch(): void {
  if (!watchState) return;
  if (watchState.timer) clearTimeout(watchState.timer);
  if (watchState.watcher) watchState.watcher.close();
  watchState = null;
}

/** Starts a fs.watch on Claude's own ~/.claude/sessions/<pid>.json for a
 *  verified-live Claude pid -- the file Claude Code flips busy/idle/waiting
 *  in as it works (src/providers/claude/liveSession.ts), so watching it is
 *  what gets a working/idle/waiting flip to the pane in ~0ms instead of
 *  waiting on the next transcript write or the 5s sweep. The path is built
 *  from `pid` alone, which by the time this is called has already passed
 *  watchSessionFor's own validation (a positive integer present in a real
 *  discovery sweep) -- never from renderer-supplied text, which is the
 *  whole point of validating before this is ever reached.
 *
 *  Returns null on any failure to start (fs.watch can throw synchronously,
 *  e.g. ENOENT if the file does not exist yet) -- logged, never thrown,
 *  since a failed fast-path watch must not stop the pid from being watched
 *  at all: the pane still gets updates from the ordinary watcher/spool/
 *  ingest pushes and the 5s sweep, exactly as a Codex session always does. */
function startClaudeWatch(pid: number, watch: (path: string) => WatchHandle): WatchHandle | null {
  const path = join(resolvePaths(homedir()).claudeLiveSessions, `${pid}.json`);
  try {
    const handle = watch(path);
    handle.on('error', err => {
      console.error('session live watch failed, falling back to the 5s sweep:', { pid, path, error: err });
      // A watcher that has emitted 'error' is not guaranteed to have closed
      // its own underlying handle (Node's docs do not promise this) --
      // closed explicitly here rather than left to leak, then dropped from
      // watchState so teardownWatch never double-closes it. The session
      // itself stays watched; only the fast path is gone.
      handle.close();
      if (watchState && watchState.watcher === handle) watchState.watcher = null;
    });
    // The whole point of this watch: a status flip (working/idle/waiting)
    // with no accompanying transcript write -- most visibly Claude entering
    // a question or permission prompt, which by definition stops writing --
    // otherwise reaches the pane only on the 5s sweep. Guarded on `handle`
    // still being the tracked watcher, same as the 'error' handler above,
    // so a change on a watcher that has already been superseded (a fast
    // session switch) or closed on error cannot schedule a push for
    // whatever is watched now.
    //
    // Caveat: if Claude Code ever rewrites this file by atomic rename
    // rather than writing it in place, fs.watch on the path stops emitting
    // after the first write (a Node/OS limitation, not fixable here). The
    // 5s sweep remains the real backstop regardless of whether this fires.
    handle.on('change', () => {
      if (watchState?.watcher === handle) schedulePush();
    });
    return handle;
  } catch (err) {
    console.error('session live watch failed to start, falling back to the 5s sweep:', { pid, path, error: err });
    return null;
  }
}

/** Starts, moves, or stops the conversation pane's live watch. `pid` is
 *  untrusted renderer input (session:watch's own argument, src/main/ipc.ts)
 *  and is revalidated here regardless of what the preload's type signature
 *  claims: a positive integer, and present in `deps.processes()` -- the
 *  discovery cache the rest of this app already trusts as "a process we
 *  ourselves found running" -- or the call is refused and logged. Nothing
 *  else the renderer could send ever reaches a file path.
 *
 *  Validates BEFORE tearing anything down, and a refusal leaves whatever was
 *  already watched untouched and still pushing -- fix round 1 (review of
 *  d3d5010): tearing down unconditionally meant a refused pid arriving
 *  mid-session-switch (0, -1, 1.5, or a pid that had just fallen out of the
 *  discovery cache) silently killed the live-push channel for the pane that
 *  WAS working, with nothing surfaced beyond a log line, until the renderer
 *  happened to call this again with a good pid. `pid: null` is the one
 *  exception -- the renderer's own explicit "stop" (closing the pane, or
 *  switching to a session's Terminal view) -- which always tears down,
 *  since there is no "existing good watch to protect" reading of a
 *  deliberate stop request.
 *
 *  Returns whether a session is now being watched: true only for a
 *  validated pid that started (or moved) a watch, false for null and for
 *  every refusal (including a refusal that left a prior watch running --
 *  the return value answers "is a session now being watched BECAUSE OF THIS
 *  CALL", not "is one being watched at all"). */
export function watchSessionFor(pid: number | null, deps: WatchDeps): boolean {
  if (pid === null) {
    teardownWatch();
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error('session:watch refused a pid that is not a positive integer:', pid);
    return false;
  }
  const proc = deps.processes().find(p => p.pid === pid);
  if (!proc) {
    console.error('session:watch refused a pid absent from the discovery cache:', pid);
    return false;
  }

  teardownWatch();
  const watcher = proc.provider === 'claude' ? startClaudeWatch(pid, deps.watch ?? defaultWatch) : null;

  // watchState is assigned BEFORE buildPayload runs, not after, so the
  // watcher just opened above is reachable through it even if buildPayload
  // throws (it reaches db.prepare(...).get() and currentBlockers, so a closed
  // or busy database can throw). Every teardown path -- teardownWatch
  // itself, win.on('closed'), before-quit -- reaches the watcher only
  // through watchState, so assigning it after a call that can throw would
  // leave the watcher referenced by nothing, unrecoverable for the life of
  // the process.
  watchState = { pid, sessionId: null, watcher, timer: null, deps };
  // Pushed once immediately, before returning, so the pane is not left
  // blank until the first change -- the same reasoning pushFleet's own
  // callers apply on startup (src/main/index.ts).
  const payload = deps.buildPayload();
  watchState.sessionId = payload?.sessionId ?? null;
  if (payload) deps.send(payload);
  return true;
}

/** Sends the current watch's payload, or releases it when the watched pid
 *  no longer resolves to a live process at all (buildPayload's null --
 *  see WatchDeps' own doc comment). Called with no session watched is a
 *  no-op: src/main/index.ts calls this unconditionally after every 5s
 *  discovery sweep, whether or not a pane is currently open. */
export function pushSessionLive(): void {
  if (!watchState) return;
  const payload = watchState.deps.buildPayload();
  if (!payload) {
    teardownWatch();
    return;
  }
  // A session id can change under an unchanged pid -- Claude's own `/clear`
  // (spec 2026-09-15-exact-session-identity-design.md) -- so this is
  // refreshed on every push, not read once at watch time, or a
  // notifySessionChanged for the NEW session id would never match.
  watchState.sessionId = payload.sessionId;
  watchState.deps.send(payload);
}

/** Coalesces a push at 250ms, so a burst of triggers in the same window --
 *  an agent streaming a long response, or Claude's status file flipping
 *  through busy/waiting in quick succession -- still costs at most one push,
 *  the same trade pushFleet's own pushTimer already makes. Shared by
 *  notifySessionChanged (the watcher/spool/ingest triggers, below) and
 *  startClaudeWatch's own 'change' subscription (above), so the two can
 *  never double the push rate by both firing in the same window. No-op with
 *  nothing watched, or with a coalesce already pending. */
function schedulePush(): void {
  if (!watchState || watchState.timer) return;
  const state = watchState;
  state.timer = setTimeout(() => {
    state.timer = null;
    pushSessionLive();
  }, 250);
}

/** The bridge from the app's ordinary change signals (the watcher/spool/
 *  ingest triggers src/main/index.ts already coalesces fleet:update from)
 *  to the conversation pane: a push only when one of `sessionIds` is the
 *  session currently being watched. */
export function notifySessionChanged(sessionIds: Set<string>): void {
  if (!watchState || watchState.sessionId === null || !sessionIds.has(watchState.sessionId)) return;
  schedulePush();
}
