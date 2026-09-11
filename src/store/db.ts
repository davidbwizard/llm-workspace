import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  // WAL is meaningless for :memory: and better-sqlite3 ignores it there.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));
  return db;
}
