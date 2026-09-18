import type Database from 'better-sqlite3';
import type { Db } from './db.ts';

export interface SignalEvent {
  eventId: string;
  occurredAt: string;
  sessionId: string | null;
  promptId: string | null;
  toolUseId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface Blocker {
  sessionId: string;
  kind: string;
  toolUseId: string | null;
  promptId: string | null;
  occurredAt: string;
  /** Human-readable, already extracted from the payload. */
  text: string;
}

/** Kinds that open a blocker. `Notification` is conditional on its subtype and
 *  handled separately: idle_prompt is timer-driven and means idle, not blocked
 *  (spec §9.3). Routing it here would make every unanswered turn an alert. */
const BLOCKING = new Set(['PermissionRequest', 'Elicitation']);
const BLOCKING_NOTIFICATIONS = new Set(['permission_prompt', 'agent_needs_input']);
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Kinds that resolve a blocker, matched on the SAME tool_use_id or prompt_id.
 *  "A later signal arrived" is not a resolution (spec §9.4). `SessionEnd` is
 *  handled separately below: it is session-scoped, not correlated, because
 *  the thing that could have answered a blocker is gone once its session
 *  has ended. */
const RESOLVING = new Set(['PostToolUse', 'PermissionDenied', 'ElicitationResult']);

/** How far back `openBlockers` looks. A blocker open for longer than this is
 *  not actionable, and the table is durable by design (never pruned, per
 *  the schema comment) so an unbounded scan grows for the life of the
 *  install — unacceptable when Task 11 polls this on a 250ms debounce. */
export const OPEN_BLOCKERS_WINDOW_MS = 24 * 60 * 60 * 1000;

function rowToSignal(r: any): SignalEvent {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(r.payload); } catch { payload = {}; }
  return {
    eventId: r.event_id, occurredAt: r.occurred_at, sessionId: r.session_id ?? null,
    promptId: r.prompt_id ?? null, toolUseId: r.tool_use_id ?? null,
    kind: r.kind, payload,
  };
}

export function latestSignals(db: Db, sessionId: string, limit = 50): SignalEvent[] {
  const rows = db.prepare(
    `SELECT * FROM signal_events WHERE session_id = ?
     ORDER BY occurred_at DESC LIMIT ?`).all(sessionId, limit) as any[];
  return rows.map(rowToSignal);
}

function describe(s: SignalEvent): string {
  const p = s.payload as Record<string, any>;
  if (s.kind === 'PermissionRequest') {
    const cmd = p.tool_input?.command ?? p.tool_input?.file_path;
    return cmd ? `Permission: ${p.tool_name ?? 'tool'} ${cmd}` : 'Permission requested';
  }
  if (s.kind === 'PreToolUse' && p.tool_name === 'ExitPlanMode') return 'Approve the plan?';
  if (s.kind === 'PreToolUse' && p.tool_name === 'AskUserQuestion') return 'A question is waiting';
  if (s.kind === 'Elicitation') return 'An MCP server is asking for input';
  if (s.kind === 'Notification') return String(p.message ?? 'Waiting for you');
  return s.kind;
}

function isBlocking(s: SignalEvent): boolean {
  if (BLOCKING.has(s.kind)) return true;
  if (s.kind === 'Notification')
    return BLOCKING_NOTIFICATIONS.has(String((s.payload as any).notificationType));
  if (s.kind === 'PreToolUse')
    return BLOCKING_TOOLS.has(String((s.payload as any).tool_name));
  return false;
}

/** Blockers with no correlated resolution, among signals from the last
 *  `windowMs` (default `OPEN_BLOCKERS_WINDOW_MS`). Correlation is by
 *  tool_use_id, else prompt_id — never by "something happened afterwards",
 *  which would clear a live permission dialog the moment an unrelated
 *  record landed. The one exception is `SessionEnd`, which clears every
 *  open blocker in its session regardless of correlation id: once the
 *  session is gone, nothing can answer a blocker attributed to it.
 *
 *  `now` is injectable (defaults to `Date.now()`), same as `sessionRefs`
 *  (src/config.ts) -- a caller that already pins a fake clock (fleetState,
 *  Task 4) needs the window measured from that same clock, or a fixture
 *  timestamp that is safely inside the window by every other measure can
 *  still fall outside it once real wall-clock time drifts away from the
 *  fixture's fake "now" between when the test was written and when it
 *  runs. */
export function openBlockers(db: Db, windowMs = OPEN_BLOCKERS_WINDOW_MS, now: number = Date.now()): Blocker[] {
  const since = new Date(now - windowMs).toISOString();
  const rows = db.prepare(
    'SELECT * FROM signal_events WHERE occurred_at >= ? ORDER BY occurred_at').all(since) as any[];
  const signals = rows.map(rowToSignal);

  const resolved = new Set<string>();
  const endedSessions = new Set<string>();
  for (const s of signals) {
    if (s.kind === 'SessionEnd' && s.sessionId) endedSessions.add(s.sessionId);
    if (!RESOLVING.has(s.kind)) continue;
    if (s.toolUseId) resolved.add(`t:${s.toolUseId}`);
    if (s.promptId) resolved.add(`p:${s.promptId}`);
  }

  const open = new Map<string, Blocker>();
  for (const s of signals) {
    if (!isBlocking(s) || !s.sessionId) continue;
    if (endedSessions.has(s.sessionId)) continue;
    const key = s.toolUseId ? `t:${s.toolUseId}` : s.promptId ? `p:${s.promptId}` : `e:${s.eventId}`;
    if (resolved.has(key)) continue;
    open.set(key, {
      sessionId: s.sessionId, kind: s.kind, toolUseId: s.toolUseId,
      promptId: s.promptId, occurredAt: s.occurredAt, text: describe(s),
    });
  }
  return [...open.values()];
}

/** Kinds that never answer an open prompt, so rule 3 ("nothing newer")
 *  skips them. PreToolUse fires only for AskUserQuestion/ExitPlanMode (the
 *  matcher), always just before the same prompt's PermissionRequest, and in
 *  the SAME whole second -- ingest order (uuid filenames) cannot break that
 *  tie, so it must be skipped rather than read as "newer". SubagentStart/
 *  SubagentStop are background agents starting or finishing while the
 *  prompt stays open (final review M5). */
const NOT_AN_ANSWER = new Set(['Notification', 'PreToolUse', 'SubagentStart', 'SubagentStop']);

/** Cached per Db, the same WeakMap pattern as newestNonNotificationStatement
 *  below: buildSessionLive runs this on every push while a session waits. */
const promptStatementCache = new WeakMap<Db, Database.Statement>();

function promptStatement(db: Db): Database.Statement {
  let stmt = promptStatementCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT * FROM signal_events WHERE session_id = ?
       ORDER BY occurred_at DESC, id DESC LIMIT 20`);
    promptStatementCache.set(db, stmt);
  }
  return stmt;
}

/** §5.1. The newest PermissionRequest stamped at or after waitingSince
 *  floored to the whole second, and only if nothing newer that could answer
 *  it happened in the session. Ledger ruling (final review M6), replacing the
 *  spec's 2 s slack: the status flips to waiting 15-30 ms BEFORE the
 *  PermissionRequest is written and the helper stamps whole seconds, so the
 *  floor is exact; a stamp from the previous second is an earlier prompt. */
export function openPromptEvent(db: Db, sessionId: string, waitingSinceMs: number): SignalEvent | null {
  const rows = promptStatement(db).all(sessionId) as any[];
  const floor = Math.floor(waitingSinceMs / 1000) * 1000;
  for (const r of rows) {
    if (NOT_AN_ANSWER.has(r.kind)) continue;
    if (r.kind !== 'PermissionRequest') return null;
    const at = Date.parse(r.occurred_at);
    return at >= floor ? rowToSignal(r) : null;
  }
  return null;
}

/** Same per-Db cache as promptStatement: buildSessionLive runs this on
 *  every push while a session waits. */
const permissionPairStatementCache = new WeakMap<Db, Database.Statement>();

function permissionPairStatement(db: Db): Database.Statement {
  let stmt = permissionPairStatementCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT occurred_at FROM signal_events WHERE session_id = ? AND kind = 'PermissionRequest'
       ORDER BY occurred_at DESC, id DESC LIMIT 2`);
    permissionPairStatementCache.set(db, stmt);
  }
  return stmt;
}

/** True when more than one PermissionRequest is stamped at or after the
 *  same waitingSince floor as openPromptEvent's: one wait, two prompts.
 *  Parallel tool calls can write both while the pane shows only one
 *  dialog, so the card could show one prompt and answer the other
 *  (coordinator ruling, security review 2026-09-18). Only the newest two
 *  are read, by kind, so no number of other events in between hides one.
 *  A stamp that does not parse counts as in the wait: this guard fails
 *  toward read-only, never toward answerable. */
export function hasMultiplePromptEvents(db: Db, sessionId: string, waitingSinceMs: number): boolean {
  const rows = permissionPairStatement(db).all(sessionId) as { occurred_at: string }[];
  const floor = Math.floor(waitingSinceMs / 1000) * 1000;
  return rows.length === 2 && rows.every((r) => !(Date.parse(r.occurred_at) < floor));
}

/** Cached per Db, same WeakMap pattern as src/hooks/spool.ts's own
 *  statementCache -- currentBlockers (below) runs this on every poll
 *  (Task 11's 250ms debounce), and a fresh db.prepare() on every call piles
 *  up native Statement handles faster than GC reaps them (see spool.ts's
 *  own comment for the Node 24 + better-sqlite3 finalization hazard this
 *  avoids). */
const newestStatementCache = new WeakMap<Db, Database.Statement>();

function newestNonNotificationStatement(db: Db): Database.Statement {
  let stmt = newestStatementCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT occurred_at FROM signal_events WHERE session_id = ? AND kind != 'Notification'
       ORDER BY occurred_at DESC, id DESC LIMIT 1`);
    newestStatementCache.set(db, stmt);
  }
  return stmt;
}

/** openBlockers, minus any blocker its session has moved past: PermissionRequest
 *  carries no tool_use_id and its resolvers are not installed (§5.2). */
export function currentBlockers(db: Db, now: number = Date.now()): Blocker[] {
  const newest = newestNonNotificationStatement(db);
  return openBlockers(db, undefined, now).filter(b =>
    (newest.get(b.sessionId) as { occurred_at: string } | undefined)?.occurred_at === b.occurredAt);
}
