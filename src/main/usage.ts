import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { Db } from '../store/db.ts';
import { resolvePaths, type Paths } from '../config.ts';
import type { OpenSession } from '../fleet/state.ts';
import { readClaudeRateLimits, readClaudeSnapshot } from '../providers/claude/statusLine.ts';
import { readCodexRateLimits } from '../providers/codex/rateLimits.ts';
import {
  clampCompactsAt, sessionContext, COMPACTS_AT_DEFAULT,
  type SessionContext, type UsagePayload,
} from '../core/usage.ts';

/** Usage and context (usage design, Part A), main side: the Compacts at
 *  setting, per-session context for the session payloads, and usage:get. */

// --- Compacts at -------------------------------------------------------
//
// Kept in main, in ~/.llm-workspace/usage.json, for the same reason the
// appearance choice is mirrored there (src/main/appearance.ts): main needs
// the value itself -- leftPct is computed here, before the renderer
// exists or asks -- and main cannot read the renderer's localStorage. Main
// is the one copy: the renderer reads it (usage:compacts-at:get) and
// changes it (usage:compacts-at:set), and keeps no copy of its own.

/** Any failure (missing, unreadable, malformed, not a number) reads as the
 *  default; a number is clamped to 50-100. */
export function readStoredCompactsAt(path: string): number {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return COMPACTS_AT_DEFAULT;
    return clampCompactsAt((raw as Record<string, unknown>).compactsAt) ?? COMPACTS_AT_DEFAULT;
  } catch {
    return COMPACTS_AT_DEFAULT;
  }
}

/** Best-effort, like writeStoredTheme: a failed write costs only the next
 *  launch's value, never this session's -- logged, never thrown. */
export function writeStoredCompactsAt(path: string, compactsAt: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ compactsAt }));
  } catch (err) {
    console.error('writeStoredCompactsAt failed:', err);
  }
}

let compactsAtCache: { path: string; value: number } | null = null;

/** The value in force: read from the file once, then held in memory (it is
 *  read on every 5s enrichment refresh and every conversation push). */
export function currentCompactsAt(path: string): number {
  if (compactsAtCache?.path !== path) compactsAtCache = { path, value: readStoredCompactsAt(path) };
  return compactsAtCache.value;
}

export type CompactsAtResult = { status: 'set'; compactsAt: number } | { status: 'refused' };

/** usage:compacts-at:set. The renderer can send anything, so the value is
 *  checked HERE: a finite number, rounded and clamped to 50-100; anything
 *  else is refused and nothing is stored. Takes effect on the next push
 *  (the 5s sweep at the latest). */
export function applyCompactsAt(
  raw: unknown, path: string,
  deps: { persist?: (path: string, compactsAt: number) => void } = {},
): CompactsAtResult {
  const compactsAt = clampCompactsAt(raw);
  if (compactsAt === null) return { status: 'refused' };
  compactsAtCache = { path, value: compactsAt };
  (deps.persist ?? writeStoredCompactsAt)(path, compactsAt);
  return { status: 'set', compactsAt };
}

// --- Per-session context -----------------------------------------------

export interface ContextOpts { statusLineDir: string; compactsAt: number }

/** The real paths and the setting in force -- what production passes. */
export function defaultContextOpts(): ContextOpts {
  const paths = resolvePaths(homedir());
  return { statusLineDir: paths.statusLineDir, compactsAt: currentCompactsAt(paths.usageSettings) };
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
export function contextFor(db: Db, sessionIds: string[], opts: ContextOpts): Map<string, SessionContext | null> {
  const turns = latestTurns(db, sessionIds);
  const out = new Map<string, SessionContext | null>();
  for (const id of sessionIds) {
    const read = readClaudeSnapshot(opts.statusLineDir, id);
    const snapshot = read ? {
      usedTokens: read.snapshot.usedTokens, windowTokens: read.snapshot.windowTokens,
      modelId: read.snapshot.modelId, mtimeMs: read.mtimeMs,
    } : null;
    out.set(id, sessionContext({ snapshot, turn: turns.get(id) ?? null }, opts.compactsAt));
  }
  return out;
}

/** Fills `context` on the open cards: Claude cards with a known session
 *  only. Codex has no context source here yet, and a card with no session
 *  (ambiguous or unmatched) must never borrow one. Same order, every other
 *  field untouched. */
export function withContext(db: Db, open: OpenSession[], opts: ContextOpts): OpenSession[] {
  const ids = [...new Set(open.flatMap(o => (o.provider === 'claude' && o.sessionId ? [o.sessionId] : [])))];
  if (ids.length === 0) return open.map(o => ({ ...o, context: null }));
  const byId = contextFor(db, ids, opts);
  return open.map(o => ({
    ...o,
    context: o.provider === 'claude' && o.sessionId ? byId.get(o.sessionId) ?? null : null,
  }));
}

// --- usage:get ---------------------------------------------------------

/** Account-wide rate limits for the Usage button. Called only when the
 *  popover asks, never on a push. Reads files only: the snapshot folder's
 *  listing, and a bounded tail of at most five rollouts (both cached). */
export function buildUsagePayload(
  paths: Pick<Paths, 'statusLineDir' | 'codexSessions'>, now: number = Date.now(),
): UsagePayload {
  return {
    claude: readClaudeRateLimits(paths.statusLineDir, now),
    codex: readCodexRateLimits(paths.codexSessions, now),
  };
}
