import type { Db } from './db.ts';
import type { NormalizedEvent } from '../core/types.ts';

const INSERT = `
INSERT INTO events
  (provider, session_id, run_id, agent_id, ts, kind, payload, native_id,
   source_file, source_offset, content_hash, sub_index, parser_version)
VALUES
  (@provider, @sessionId, @runId, @agentId, @ts, @kind, @payload, @nativeId,
   @sourceFile, @sourceOffset, @contentHash, @subIndex, @parserVersion)`;

/** Insert events, skipping any whose identity key
 *  (source_file, source_offset, content_hash, sub_index) is already present.
 *  Spec §6.1: watchers fire redundantly, so ingestion must be idempotent.
 *  Runs in one transaction — a bad record aborts the whole batch rather
 *  than leaving a half-ingested file behind. Returns rows actually written.
 *
 *  DEVIATION from the brief text: the brief's INSERT used `OR IGNORE`, but
 *  `OR IGNORE` suppresses every constraint failure SQLite can raise, not
 *  just the identity-key UNIQUE conflict this function means to
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

export interface IngestMeta {
  inode: number | null;
  size: number;
  mtime: string;
  bytesConsumed: number;
  parserVersion: number;
  providerCliVersion: string | null;
}

export interface IngestState {
  path: string;
  inode: number | null;
  size: number;
  mtime: string;
  bytes_consumed: number;
  parser_version: number;
  provider_cli_version: string | null;
  last_ok_at: string | null;
}

// Shared by reparseFile and recordIngest — see task-4-5 report for why this
// was extracted (the brief duplicated this SQL verbatim in both functions).
const UPSERT_INGEST = `
INSERT INTO ingest_files
  (path, inode, size, mtime, bytes_consumed, parser_version,
   provider_cli_version, last_ok_at)
VALUES (@path, @inode, @size, @mtime, @bytesConsumed, @parserVersion,
        @providerCliVersion, @lastOkAt)
ON CONFLICT(path) DO UPDATE SET
  inode = excluded.inode, size = excluded.size, mtime = excluded.mtime,
  bytes_consumed = excluded.bytes_consumed,
  parser_version = excluded.parser_version,
  provider_cli_version = excluded.provider_cli_version,
  last_ok_at = excluded.last_ok_at`;

export function getIngestState(db: Db, path: string): IngestState | undefined {
  return db.prepare('SELECT * FROM ingest_files WHERE path = ?').get(path) as
    IngestState | undefined;
}

/** Spec §6.1. A parser fix produces byte-identical identity keys, so a
 *  plain re-insert is silently ignored by the unique index and the bad rows
 *  survive forever. Reparse therefore DELETES this file's derived events
 *  first, then parses, in one transaction.
 *
 *  `signal_events` is untouched by design: hook output has no other source. */
export function reparseFile(
  db: Db,
  path: string,
  parse: () => NormalizedEvent[],
  meta: IngestMeta,
): void {
  const del = db.prepare('DELETE FROM events WHERE source_file = ?');
  const insert = db.prepare(INSERT);
  const book = db.prepare(UPSERT_INGEST);

  const run = db.transaction(() => {
    del.run(path);
    for (const e of parse()) {
      insert.run({ ...e, payload: JSON.stringify(e.payload) });
    }
    book.run({ path, ...meta, lastOkAt: new Date().toISOString() });
  });
  run();
}

export function recordIngest(db: Db, path: string, meta: IngestMeta): void {
  db.prepare(UPSERT_INGEST)
    .run({ path, ...meta, lastOkAt: new Date().toISOString() });
}
