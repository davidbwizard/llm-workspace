import { readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Db } from '../store/db.ts';

const INSERT = `
INSERT OR IGNORE INTO signal_events
  (event_id, occurred_at, ingested_at, provider, session_id, run_id,
   control_handle_id, agent_id, prompt_id, tool_use_id, kind, payload)
VALUES
  (@eventId, @occurredAt, @ingestedAt, @provider, @sessionId, @runId,
   @controlHandleId, @agentId, @promptId, @toolUseId, @kind, @payload)`;

/** ingestSpool runs on a timer for the life of the watcher process, so a
 *  fresh db.prepare() on every call has the same exposure as store/ingest.ts
 *  had: native Statement handles piling up faster than GC reaps them, which
 *  under Node 24 + better-sqlite3 can abort the process during finalization
 *  (see store/ingest.ts's statementsFor for the full account). Cache the one
 *  statement this module needs per Db instance, the same way. */
const statementCache = new WeakMap<Db, Database.Statement>();

function insertStatement(db: Db): Database.Statement {
  let stmt = statementCache.get(db);
  if (!stmt) {
    stmt = db.prepare(INSERT);
    statementCache.set(db, stmt);
  }
  return stmt;
}

/** Spec §5.4 / §6.1. The helper stamps a unique event_id, so ingestion is
 *  idempotent and a re-read of the spool cannot duplicate events.
 *  `occurred_at` (when the hook fired) is kept distinct from `ingested_at`
 *  (when we read it) — a spooled event may be ingested hours later, so
 *  ordering by ingestion time would be wrong. */
export function ingestSpool(db: Db, spoolDir: string, provider = 'claude'): number {
  if (!existsSync(spoolDir)) return 0;
  const stmt = insertStatement(db);
  const ingestedAt = new Date().toISOString();
  let written = 0;

  for (const name of readdirSync(spoolDir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = join(spoolDir, name);

    let rec: any;
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // half-written or corrupt; leave it for rotation to reap
    }
    if (!rec?.event_id) continue;

    const p = rec.payload ?? {};
    const info = stmt.run({
      eventId: String(rec.event_id),
      occurredAt: String(rec.occurred_at ?? ingestedAt),
      ingestedAt,
      provider,
      sessionId: p.session_id ?? null,
      runId: null,
      controlHandleId: null,
      agentId: p.agent_id ?? null,
      promptId: p.prompt_id ?? null,
      toolUseId: p.tool_use_id ?? null,
      kind: String(p.hook_event_name ?? 'unknown'),
      payload: JSON.stringify({ ...p, _ppid: rec.ppid ?? null }),
    });
    written += info.changes;
    rmSync(file, { force: true });
  }
  return written;
}

export interface RotateOpts { maxAgeDays: number; maxFiles: number }

/** Spec §5.4: the spool is capped and rotated. Six months with the app
 *  closed must not turn it into an accidental log archive. */
export function rotateSpool(spoolDir: string, opts: RotateOpts): number {
  if (!existsSync(spoolDir)) return 0;
  const cutoff = Date.now() - opts.maxAgeDays * 86400_000;
  const files = readdirSync(spoolDir)
    .filter(f => !f.startsWith('.'))
    .map(f => ({ f, path: join(spoolDir, f), mtime: statSync(join(spoolDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  let removed = 0;
  for (const entry of files) {
    if (entry.mtime < cutoff) { rmSync(entry.path, { force: true }); removed++; }
  }
  const remaining = files.filter(e => e.mtime >= cutoff);
  const excess = remaining.length - opts.maxFiles;
  for (let i = 0; i < excess; i++) {
    rmSync(remaining[i]!.path, { force: true });
    removed++;
  }
  return removed;
}
