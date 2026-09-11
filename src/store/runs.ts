import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
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

interface Statements {
  insertRun: Database.Statement;
  runsForSession: Database.Statement;
  getRunStart: Database.Statement;
}

/** ensureRun is called once per event lacking a run_id -- close to once per
 *  event across a whole corpus (src/watch/watcher.ts's ingestFileOnce) -- so
 *  preparing a statement fresh on every call, as this module used to do,
 *  piles up finalizable native Statement handles faster than GC reaps them.
 *  Under Node 24 + better-sqlite3, that finalization can race environment
 *  teardown and abort the whole process (SIGABRT, "Assertion failed: (env)
 *  != nullptr" in Statement::~Statement — reproduced against the real index
 *  and a synthetic fixture, see task-11 report). Same fix as
 *  src/store/ingest.ts's statementsFor and src/hooks/spool.ts's
 *  insertStatement: cache each prepared statement per Db instance instead of
 *  re-preparing per call.
 *
 *  Keyed by a WeakMap, not a plain Map: when a Db is closed and dropped, its
 *  cached statements should be collected with it, not pinned forever by this
 *  module. */
const statementCache = new WeakMap<Db, Statements>();

function statementsFor(db: Db): Statements {
  let s = statementCache.get(db);
  if (!s) {
    s = {
      insertRun: db.prepare(INSERT_RUN),
      runsForSession: db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY started_at'),
      getRunStart: db.prepare(
        'SELECT started_at FROM runs WHERE session_id = ? ORDER BY started_at LIMIT 1'),
    };
    statementCache.set(db, s);
  }
  return s;
}

/** Records a run if it is not already present, and returns its id.
 *
 *  `source` is 'derived' because hooks are opt-in and not installed: without
 *  SessionStart we cannot see a resume, so one run per session is the honest
 *  approximation. The model is correct and the granularity is coarse; once the
 *  hook helper is installed, finer boundaries arrive without any consumer
 *  changing. */
export function ensureRun(db: Db, sessionId: string, startedAt: string): string {
  const runId = deriveRunId(sessionId, startedAt);
  statementsFor(db).insertRun.run(runId, sessionId, startedAt, 'derived');
  return runId;
}

export function runsForSession(db: Db, sessionId: string): RunRef[] {
  const rows = statementsFor(db).runsForSession.all(sessionId) as any[];
  return rows.map(r => ({
    runId: r.run_id, sessionId: r.session_id, startedAt: r.started_at,
    endedAt: r.ended_at ?? null, source: r.source, endReason: r.end_reason ?? null,
  }));
}

/** The start of a session's earliest known run, so a later tail joins the run
 *  it belongs to rather than opening a new one. */
export function getRunStart(db: Db, sessionId: string): string | null {
  const row = statementsFor(db).getRunStart.get(sessionId) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}
