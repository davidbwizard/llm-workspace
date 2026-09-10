import type { Db } from './db.ts';
import type { NormalizedEvent } from '../core/types.ts';

const INSERT = `
INSERT INTO events
  (provider, session_id, run_id, agent_id, ts, kind, payload, native_id,
   source_file, source_offset, content_hash, parser_version)
VALUES
  (@provider, @sessionId, @runId, @agentId, @ts, @kind, @payload, @nativeId,
   @sourceFile, @sourceOffset, @contentHash, @parserVersion)`;

/** Insert events, skipping any whose identity triple is already present.
 *  Spec §6.1: watchers fire redundantly, so ingestion must be idempotent.
 *  Runs in one transaction — a bad record aborts the whole batch rather
 *  than leaving a half-ingested file behind. Returns rows actually written.
 *
 *  DEVIATION from the brief text: the brief's INSERT used `OR IGNORE`, but
 *  `OR IGNORE` suppresses every constraint failure SQLite can raise, not
 *  just the identity-triple UNIQUE conflict this function means to
 *  dedupe — including NOT NULL. That silently swallows genuinely bad
 *  records instead of failing the batch, which breaks the all-or-nothing
 *  guarantee this docstring (and the brief's own test) requires. A plain
 *  INSERT plus catching only SQLITE_CONSTRAINT_UNIQUE preserves idempotent
 *  dedup while letting any other constraint violation propagate and roll
 *  back the transaction. */
export function insertEvents(db: Db, events: NormalizedEvent[]): number {
  const stmt = db.prepare(INSERT);
  const run = db.transaction((batch: NormalizedEvent[]) => {
    let written = 0;
    for (const e of batch) {
      try {
        stmt.run({ ...e, payload: JSON.stringify(e.payload) });
        written += 1;
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
        throw err;
      }
    }
    return written;
  });
  return run(events);
}

export function countEvents(db: Db, sourceFile?: string): number {
  const row = sourceFile
    ? db.prepare('SELECT COUNT(*) c FROM events WHERE source_file = ?').get(sourceFile)
    : db.prepare('SELECT COUNT(*) c FROM events').get();
  return (row as { c: number }).c;
}
