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
 *  "A later signal arrived" is not a resolution (spec §9.4). */
const RESOLVING = new Set(['PostToolUse', 'PermissionDenied', 'ElicitationResult']);

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

/** Blockers with no correlated resolution. Correlation is by tool_use_id, else
 *  prompt_id — never by "something happened afterwards", which would clear a
 *  live permission dialog the moment an unrelated record landed. */
export function openBlockers(db: Db): Blocker[] {
  const rows = db.prepare(
    'SELECT * FROM signal_events ORDER BY occurred_at').all() as any[];
  const signals = rows.map(rowToSignal);

  const resolved = new Set<string>();
  for (const s of signals) {
    if (!RESOLVING.has(s.kind)) continue;
    if (s.toolUseId) resolved.add(`t:${s.toolUseId}`);
    if (s.promptId) resolved.add(`p:${s.promptId}`);
  }

  const open = new Map<string, Blocker>();
  for (const s of signals) {
    if (!isBlocking(s) || !s.sessionId) continue;
    const key = s.toolUseId ? `t:${s.toolUseId}` : s.promptId ? `p:${s.promptId}` : `e:${s.eventId}`;
    if (resolved.has(key)) continue;
    open.set(key, {
      sessionId: s.sessionId, kind: s.kind, toolUseId: s.toolUseId,
      promptId: s.promptId, occurredAt: s.occurredAt, text: describe(s),
    });
  }
  return [...open.values()];
}
