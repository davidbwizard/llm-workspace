export const SCHEMA_VERSION = 1;

/** Spec §6.1. Two tables with deliberately different durability:
 *  `events` is derived from provider files and is disposable;
 *  `signal_events` comes from hooks and has no other source, so a rebuild
 *  must never touch it. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT, run_id TEXT, control_handle_id TEXT, agent_id TEXT,
  prompt_id TEXT,
  tool_use_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_identity ON signal_events(event_id);
CREATE INDEX IF NOT EXISTS signal_session ON signal_events(session_id, occurred_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT,
  agent_id TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  native_id TEXT,
  source_file TEXT NOT NULL,
  source_offset INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  -- One source record can emit several events (e.g. an assistant record
  -- emits prose, one tool.used per tool block, and turn.completed), all
  -- sharing source_offset and content_hash. sub_index is the event's
  -- ordinal within that record's emission, assigned deterministically by
  -- the parser, so it disambiguates siblings without weakening dedup.
  sub_index INTEGER NOT NULL,
  parser_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_identity
  ON events(source_file, source_offset, content_hash, sub_index);
CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_source ON events(source_file);

CREATE TABLE IF NOT EXISTS ingest_files (
  path TEXT PRIMARY KEY,
  inode INTEGER,
  size INTEGER,
  mtime TEXT,
  bytes_consumed INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  provider_cli_version TEXT,
  last_ok_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  source TEXT NOT NULL,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, started_at);
`;
