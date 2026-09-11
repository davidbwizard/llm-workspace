import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import type { RunRef } from '../core/types.ts';

/** Deterministic so re-deriving the same run from the same events produces the
 *  same id — the store must stay idempotent. Truncated to 16 hex chars: this
 *  is a local index key, not a security boundary. */
export function deriveRunId(sessionId: string, startedAt: string): string {
  return createHash('sha256').update(`${sessionId}:${startedAt}`).digest('hex').slice(0, 16);
}

const INSERT_RUN = `
INSERT OR IGNORE INTO runs (run_id, session_id, started_at, ended_at, source, end_reason)
VALUES (?, ?, ?, NULL, ?, NULL)`;

/** Records a run if it is not already present, and returns its id.
 *
 *  `source` is 'derived' because hooks are opt-in and not installed: without
 *  SessionStart we cannot see a resume, so one run per session is the honest
 *  approximation. The model is correct and the granularity is coarse; once the
 *  hook helper is installed, finer boundaries arrive without any consumer
 *  changing. */
export function ensureRun(db: Db, sessionId: string, startedAt: string): string {
  const runId = deriveRunId(sessionId, startedAt);
  db.prepare(INSERT_RUN).run(runId, sessionId, startedAt, 'derived');
  return runId;
}

export function runsForSession(db: Db, sessionId: string): RunRef[] {
  const rows = db.prepare(
    'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at').all(sessionId) as any[];
  return rows.map(r => ({
    runId: r.run_id, sessionId: r.session_id, startedAt: r.started_at,
    endedAt: r.ended_at ?? null, source: r.source, endReason: r.end_reason ?? null,
  }));
}

/** The start of a session's earliest known run, so a later tail joins the run
 *  it belongs to rather than opening a new one. */
export function getRunStart(db: Db, sessionId: string): string | null {
  const row = db.prepare(
    'SELECT started_at FROM runs WHERE session_id = ? ORDER BY started_at LIMIT 1'
  ).get(sessionId) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}
