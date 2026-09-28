// Per-viewer preferences, kept where the window's origin cannot reach them.
//
// Settings, favourites, groups, the rail width and the first-run flag used
// to live in the renderer's localStorage. That storage is keyed by the
// window's ORIGIN, and this app has several: the dev app loads
// http://localhost:5173, the packaged app loads file://, and Vite's port
// drifts to 5174/5175 whenever a stale dev server is still holding the
// default. Measured on 2026-09-25 from the app's own Local Storage leveldb:
// four origins already held this app's keys. Each one is a separate, empty
// drawer, so preferences appeared to reset for reasons nothing surfaced.
//
// The theme never suffered from this, because it is the one preference main
// already owns (~/.llm-workspace/appearance.json). This is that idea, for
// the rest.
//
// ITS OWN FILE, not index.sqlite. src/renderer/state/favourites.ts records
// the standing ruling -- these are "a per-viewer UI convenience, never fleet
// state ... nothing here belongs in the store/db" -- and that stays true
// here. It also keeps a 600 MB transcript index from carrying the rail
// width, two things with nothing in common but a disk.
//
// Values are opaque JSON TEXT. This module validates that a value round-trips
// as JSON and nothing else: every store already validates its own shape on
// every read (normalizeSettings, normalizeFavourites, and so on), written
// for exactly this reason -- a value could always have been left by an older
// version or edited by hand. Duplicating those rules here would be a second
// place to keep them correct.
import Database from 'better-sqlite3';

/** One row per key. No schema version: a key/value table has no shape to
 *  migrate, and an unknown key is simply one nothing reads. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

export type PrefsDb = Database.Database;

/** A key this app is willing to store. A closed list, because these keys
 *  arrive over IPC from the renderer: an open one would let a buggy or
 *  compromised renderer fill the user's disk with rows nothing ever reads.
 *  Matches the storage keys the renderer stores already use, so a migration
 *  copies across without renaming anything. */
export const PREF_KEYS = [
  'llmws:settings', 'llmws:groups', 'llmws:rail-width',
  'llmws.favourites', 'llmws.firstRunSeen',
] as const;
export type PrefKey = typeof PREF_KEYS[number];
const ALLOWED = new Set<string>(PREF_KEYS);

export function isPrefKey(key: unknown): key is PrefKey {
  return typeof key === 'string' && ALLOWED.has(key);
}

/** Bounds one value. Generous against the largest thing stored today (a
 *  groups map), finite against a renderer bug writing without end. */
export const MAX_PREF_BYTES = 256 * 1024;

export function openPrefs(path: string): PrefsDb {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Every stored preference, as the renderer's stores expect to read it:
 *  key -> the raw JSON string, exactly what localStorage.getItem returned.
 *  Keeping the wire shape identical is what lets each store keep its own
 *  parse and validation untouched.
 *
 *  Never throws. A preferences file that cannot be read must cost the person
 *  their rail width, not their app -- this is called before the window
 *  opens. */
export function readAllPrefs(db: PrefsDb): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const row of db.prepare('SELECT key, value FROM prefs').all() as { key: string; value: string }[]) {
      if (ALLOWED.has(row.key)) out[row.key] = row.value;
    }
  } catch {
    return {};
  }
  return out;
}

export type PrefWrite = { ok: true } | { ok: false; reason: 'invalid_key' | 'invalid_value' | 'too_big' | 'write_failed' };

/** One preference. `value` is the raw string the renderer would have handed
 *  localStorage, so it is checked as JSON here rather than trusted: a value
 *  that cannot round-trip would come back as a parse failure on every future
 *  read, and the store would silently fall back to its defaults forever.
 *  Better to refuse the write than to accept a value that can never be read. */
export function writePref(db: PrefsDb, key: unknown, value: unknown): PrefWrite {
  if (!isPrefKey(key)) return { ok: false, reason: 'invalid_key' };
  if (typeof value !== 'string') return { ok: false, reason: 'invalid_value' };
  if (Buffer.byteLength(value, 'utf8') > MAX_PREF_BYTES) return { ok: false, reason: 'too_big' };
  try { JSON.parse(value); } catch { return { ok: false, reason: 'invalid_value' }; }
  try {
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true };
}

/** The one-time move off localStorage. Writes only keys that are ABSENT
 *  here, so a preference already set in the database always wins and running
 *  an older build in between cannot overwrite newer choices. Returns the keys
 *  actually taken, so the renderer can stop offering them.
 *
 *  Getting this wrong wipes someone's favourites rather than merely failing,
 *  which is why it never deletes from localStorage and never overwrites. */
export function migratePrefs(db: PrefsDb, incoming: unknown): PrefKey[] {
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) return [];
  const existing = readAllPrefs(db);
  const taken: PrefKey[] = [];
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (!isPrefKey(key) || key in existing) continue;
    if (writePref(db, key, value).ok) taken.push(key);
  }
  return taken;
}
