import { homedir } from 'node:os';
import type { Db } from '../store/db.ts';
import { resolvePaths, type Paths } from '../config.ts';
import type { OpenSession } from '../fleet/state.ts';
import { readClaudeRateLimits, readClaudeSnapshot } from '../providers/claude/statusLine.ts';
import { readCodexContext, readCodexRateLimits } from '../providers/codex/rateLimits.ts';
import { isRolloutPath } from '../providers/codex/rolloutPath.ts';
import type { Provider } from '../core/types.ts';
import { buildContext, sessionContext, type SessionContext, type UsagePayload } from '../core/usage.ts';

/** Usage and context (usage design, Part A), main side: per-session context
 *  for the session payloads, and usage:get. */

// --- Per-session context -----------------------------------------------

export interface ContextOpts { statusLineDir: string; codexSessions: string }

/** The real paths -- what production passes. */
export function defaultContextOpts(): ContextOpts {
  const paths = resolvePaths(homedir());
  return { statusLineDir: paths.statusLineDir, codexSessions: paths.codexSessions };
}

export interface LatestTurn { usedTokens: number; modelId: string | null; tsMs: number }

/** The fallback source: each session's latest MAIN-thread turn.completed
 *  that carries tokens (a subagent's turn is its own context; a synthetic
 *  record has none). Used = input + cache read + cache write -- the same
 *  input-only formula as the status line. One query for every id, each
 *  resolved through the events_session_ts index; bounded by how many ids
 *  are asked for (live sessions), never by history size. */
export function latestTurns(db: Db, sessionIds: string[]): Map<string, LatestTurn> {
  const out = new Map<string, LatestTurn>();
  if (sessionIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT t.session_id AS sessionId, t.ts AS ts, t.payload AS payload
    FROM json_each(?) j
    JOIN events t ON t.id = (
      SELECT x.id FROM events x
      WHERE x.session_id = j.value AND x.kind = 'turn.completed' AND x.agent_id IS NULL
        AND COALESCE(json_extract(x.payload, '$.inputTokens'), 0)
          + COALESCE(json_extract(x.payload, '$.cacheReadTokens'), 0)
          + COALESCE(json_extract(x.payload, '$.cacheWriteTokens'), 0) > 0
      ORDER BY x.ts DESC, x.id DESC LIMIT 1)
  `).all(JSON.stringify(sessionIds)) as { sessionId: string; ts: string; payload: string }[];

  for (const r of rows) {
    let p: Record<string, unknown>;
    try { p = JSON.parse(r.payload); } catch { continue; }
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const tsMs = Date.parse(r.ts);
    if (!Number.isFinite(tsMs)) continue;
    out.set(r.sessionId, {
      usedTokens: n(p.inputTokens) + n(p.cacheReadTokens) + n(p.cacheWriteTokens),
      modelId: typeof p.model === 'string' ? p.model : null,
      tsMs,
    });
  }
  return out;
}

/** Context for Claude sessions: the status line snapshot, else the latest
 *  turn, whichever is newer (core/usage.ts's sessionContext). */
export function claudeContextFor(db: Db, sessionIds: string[], opts: ContextOpts): Map<string, SessionContext | null> {
  const turns = latestTurns(db, sessionIds);
  const out = new Map<string, SessionContext | null>();
  for (const id of sessionIds) {
    const read = readClaudeSnapshot(opts.statusLineDir, id);
    const snapshot = read ? {
      usedTokens: read.snapshot.usedTokens, windowTokens: read.snapshot.windowTokens,
      modelId: read.snapshot.modelId, mtimeMs: read.mtimeMs,
    } : null;
    out.set(id, sessionContext({ snapshot, turn: turns.get(id) ?? null }));
  }
  return out;
}

/** Which rollout file holds each Codex session: the source file of the
 *  session's latest ROOT-thread event (a subagent thread shares the root's
 *  session id but writes its own rollout, with its own usage). Comes from
 *  the app's own index, and is still only accepted when it is an absolute,
 *  normalised path inside the Codex sessions folder with a rollout name --
 *  this path is about to be opened. One query for every id, each resolved
 *  through the events_session_ts index. */
export function codexRollouts(db: Db, sessionIds: string[], codexRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT j.value AS sessionId, (
      SELECT x.source_file FROM events x
      WHERE x.session_id = j.value AND x.provider = 'codex' AND x.agent_id IS NULL
      ORDER BY x.ts DESC, x.id DESC LIMIT 1) AS sourceFile
    FROM json_each(?) j
  `).all(JSON.stringify(sessionIds)) as { sessionId: string; sourceFile: string | null }[];
  for (const r of rows) {
    const f = r.sourceFile;
    if (!isRolloutPath(f, codexRoot)) continue;
    out.set(r.sessionId, f);
  }
  return out;
}

/** Context for Codex sessions: the rollout's latest token_count usage
 *  (src/providers/codex/rateLimits.ts's readCodexContext -- a tail read,
 *  cached by size and mtime) against its model_context_window, with the
 *  same leftPct formula as Claude. */
export function codexContextFor(db: Db, sessionIds: string[], opts: ContextOpts): Map<string, SessionContext | null> {
  const files = codexRollouts(db, sessionIds, opts.codexSessions);
  const out = new Map<string, SessionContext | null>();
  for (const id of sessionIds) {
    const file = files.get(id);
    const read = file ? readCodexContext(file) : null;
    out.set(id, read && read.usedTokens !== null ? buildContext(read.usedTokens, read.windowTokens) : null);
  }
  return out;
}

/** One session's context, for the conversation pane's push. */
export function contextForSession(
  db: Db, sessionId: string, provider: Provider, opts: ContextOpts,
): SessionContext | null {
  const byId = provider === 'claude' ? claudeContextFor(db, [sessionId], opts) : codexContextFor(db, [sessionId], opts);
  return byId.get(sessionId) ?? null;
}

/** Fills `context` on the open cards that have a known session. A card
 *  with no session (ambiguous or unmatched) must never borrow one. Same
 *  order, every other field untouched. */
export function withContext(db: Db, open: OpenSession[], opts: ContextOpts): OpenSession[] {
  const idsFor = (provider: Provider) =>
    [...new Set(open.flatMap(o => (o.provider === provider && o.sessionId ? [o.sessionId] : [])))];
  const claudeIds = idsFor('claude');
  const codexIds = idsFor('codex');
  const claude = claudeIds.length > 0 ? claudeContextFor(db, claudeIds, opts) : new Map<string, SessionContext | null>();
  const codex = codexIds.length > 0 ? codexContextFor(db, codexIds, opts) : new Map<string, SessionContext | null>();
  return open.map(o => ({
    ...o,
    context: o.sessionId ? (o.provider === 'claude' ? claude : codex).get(o.sessionId) ?? null : null,
  }));
}

// --- usage:get ---------------------------------------------------------

/** Account-wide rate limits for the Usage button. Called only when the
 *  popover asks, never on a push. Reads files only: the snapshot folder's
 *  listing, and a bounded tail of at most 200 rollouts modified in the
 *  last 8 days (both cached). */
export function buildUsagePayload(
  paths: Pick<Paths, 'statusLineDir' | 'codexSessions'>, now: number = Date.now(),
): UsagePayload {
  return {
    claude: readClaudeRateLimits(paths.statusLineDir, now),
    codex: readCodexRateLimits(paths.codexSessions, now),
  };
}
