import type Database from 'better-sqlite3';
import type { Db } from './db.ts';
import type { NormalizedEvent } from '../core/types.ts';

const INSERT = `
INSERT INTO events
  (provider, session_id, run_id, agent_id, ts, kind, payload, native_id,
   source_file, source_offset, content_hash, sub_index, parser_version)
VALUES
  (@provider, @sessionId, @runId, @agentId, @ts, @kind, @payload, @nativeId,
   @sourceFile, @sourceOffset, @contentHash, @subIndex, @parserVersion)`;

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

interface Statements {
  insertEvent: Database.Statement;
  deleteBySource: Database.Statement;
  upsertIngest: Database.Statement;
  countAll: Database.Statement;
  countBySource: Database.Statement;
  getIngestState: Database.Statement;
}

/** A prepared Statement is a native handle that must eventually be
 *  finalized; preparing one fresh on every call — as every function below
 *  used to do — piles up finalizable natives faster than GC reaps them.
 *  Under Node 24 + better-sqlite3, that finalization can race environment
 *  teardown and abort the whole process (SIGABRT, "Assertion failed:
 *  (env) != nullptr" in Statement::~Statement — reproduced against real,
 *  long-running ingestion, see task-13-14 report). better-sqlite3's own
 *  performance model assumes a statement is prepared once and reused, so
 *  this caches each one per Db instance instead of re-preparing per call.
 *
 *  Keyed by a WeakMap, not a plain Map: when a Db is closed and dropped,
 *  its cached statements should be collected with it, not pinned forever
 *  by this module. Populated lazily on first use per database — never at
 *  module load — because a prepared statement belongs to one specific
 *  database handle, and :memory: databases in tests are a new handle every
 *  time. */
const statementCache = new WeakMap<Db, Statements>();

function statementsFor(db: Db): Statements {
  let s = statementCache.get(db);
  if (!s) {
    s = {
      insertEvent: db.prepare(INSERT),
      deleteBySource: db.prepare('DELETE FROM events WHERE source_file = ?'),
      upsertIngest: db.prepare(UPSERT_INGEST),
      countAll: db.prepare('SELECT COUNT(*) c FROM events'),
      countBySource: db.prepare('SELECT COUNT(*) c FROM events WHERE source_file = ?'),
      getIngestState: db.prepare('SELECT * FROM ingest_files WHERE path = ?'),
    };
    statementCache.set(db, s);
  }
  return s;
}

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
  const { insertEvent } = statementsFor(db);
  const run = db.transaction((batch: NormalizedEvent[]) => {
    let written = 0;
    for (const e of batch) {
      try {
        insertEvent.run({ ...e, payload: JSON.stringify(e.payload) });
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
  const { countAll, countBySource } = statementsFor(db);
  const row = sourceFile ? countBySource.get(sourceFile) : countAll.get();
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

export function getIngestState(db: Db, path: string): IngestState | undefined {
  return statementsFor(db).getIngestState.get(path) as IngestState | undefined;
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
  const { deleteBySource, insertEvent, upsertIngest } = statementsFor(db);

  const run = db.transaction(() => {
    deleteBySource.run(path);
    for (const e of parse()) {
      insertEvent.run({ ...e, payload: JSON.stringify(e.payload) });
    }
    upsertIngest.run({ path, ...meta, lastOkAt: new Date().toISOString() });
  });
  run();
}

export function recordIngest(db: Db, path: string, meta: IngestMeta): void {
  statementsFor(db).upsertIngest.run({ path, ...meta, lastOkAt: new Date().toISOString() });
}
