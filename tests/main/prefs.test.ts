import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openPrefs, readAllPrefs, writePref, migratePrefs, isPrefKey, MAX_PREF_BYTES, type PrefsDb,
} from '../../src/main/prefs.ts';

let db: PrefsDb;
beforeEach(() => { db = openPrefs(':memory:'); });
afterEach(() => { db.close(); });

describe('which keys are storable', () => {
  // The renderer names the key over IPC, so an open list would let a buggy
  // or compromised renderer fill the disk with rows nothing reads.
  it('accepts exactly the keys the renderer stores already use', () => {
    for (const k of ['llmws:settings', 'llmws:groups', 'llmws:rail-width',
      'llmws.favourites', 'llmws.firstRunSeen']) expect(isPrefKey(k)).toBe(true);
  });

  it('refuses anything else, including near misses', () => {
    for (const k of ['llmws:settings ', 'settings', 'llmws:Settings', '', null, 42, {}]) {
      expect(isPrefKey(k)).toBe(false);
    }
    expect(writePref(db, 'llmws:unknown', '{}')).toEqual({ ok: false, reason: 'invalid_key' });
  });
});

describe('writing and reading back', () => {
  it('returns the raw string, byte for byte, as localStorage did', () => {
    // Every store parses and validates this itself. Keeping the wire shape
    // identical is what lets those stay untouched.
    const raw = '{"appearance":"dark","textSize":15}';
    expect(writePref(db, 'llmws:settings', raw)).toEqual({ ok: true });
    expect(readAllPrefs(db)['llmws:settings']).toBe(raw);
  });

  it('replaces a value rather than accumulating rows', () => {
    writePref(db, 'llmws:rail-width', '200');
    writePref(db, 'llmws:rail-width', '320');
    expect(readAllPrefs(db)['llmws:rail-width']).toBe('320');
    expect(Object.keys(readAllPrefs(db))).toHaveLength(1);
  });

  it('refuses a value that cannot round-trip as JSON', () => {
    // A value that fails to parse would come back as a parse failure on
    // every future read, and the store would fall back to its defaults
    // forever. Refusing the write is the smaller loss.
    expect(writePref(db, 'llmws:settings', '{not json')).toEqual({ ok: false, reason: 'invalid_value' });
    expect(readAllPrefs(db)['llmws:settings']).toBeUndefined();
  });

  it('refuses a non-string value outright', () => {
    expect(writePref(db, 'llmws:settings', { appearance: 'dark' })).toEqual({ ok: false, reason: 'invalid_value' });
  });

  it('bounds one value', () => {
    const huge = JSON.stringify('x'.repeat(MAX_PREF_BYTES + 10));
    expect(writePref(db, 'llmws:groups', huge)).toEqual({ ok: false, reason: 'too_big' });
  });
});

describe('reading is never allowed to break the app', () => {
  it('reads an unreadable store as empty rather than throwing', () => {
    // This runs before the window opens. A preferences file that cannot be
    // read must cost the rail width, not the app.
    const broken = { prepare: () => { throw new Error('disk gone'); } } as unknown as PrefsDb;
    expect(readAllPrefs(broken)).toEqual({});
  });

  it('ignores a row whose key is no longer one this app stores', () => {
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('llmws:retired', '1');
    writePref(db, 'llmws:settings', '{}');
    expect(Object.keys(readAllPrefs(db))).toEqual(['llmws:settings']);
  });
});

describe('the one-time move off localStorage', () => {
  it('takes the keys it recognises and reports them', () => {
    const taken = migratePrefs(db, {
      'llmws.favourites': '["/a","/b"]',
      'llmws:rail-width': '280',
      'unrelated.key': 'x',
    });
    expect(taken.sort()).toEqual(['llmws.favourites', 'llmws:rail-width']);
    expect(readAllPrefs(db)['llmws.favourites']).toBe('["/a","/b"]');
  });

  it('NEVER overwrites a preference already stored here', () => {
    // Running an older build in between must not be able to undo newer
    // choices. Getting this wrong wipes favourites rather than failing.
    writePref(db, 'llmws.favourites', '["/kept"]');
    const taken = migratePrefs(db, { 'llmws.favourites': '["/stale"]' });
    expect(taken).toEqual([]);
    expect(readAllPrefs(db)['llmws.favourites']).toBe('["/kept"]');
  });

  it('skips a value it could not store and keeps going', () => {
    const taken = migratePrefs(db, {
      'llmws:settings': '{broken',
      'llmws.favourites': '["/ok"]',
    });
    expect(taken).toEqual(['llmws.favourites']);
    expect(readAllPrefs(db)['llmws:settings']).toBeUndefined();
  });

  it('tolerates anything that is not an object', () => {
    for (const bad of [null, undefined, 'x', 42, ['a']]) expect(migratePrefs(db, bad)).toEqual([]);
  });
});

describe('on disk', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llmw-prefs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('survives a reopen, which is the entire point of this module', () => {
    const path = join(dir, 'prefs.sqlite');
    const first = openPrefs(path);
    writePref(first, 'llmws:settings', '{"appearance":"dark"}');
    first.close();

    const second = openPrefs(path);
    expect(readAllPrefs(second)['llmws:settings']).toBe('{"appearance":"dark"}');
    second.close();
  });

  it('reports a failed write rather than throwing it at the caller', () => {
    const path = join(dir, 'ro.sqlite');
    const ro = openPrefs(path);
    writePref(ro, 'llmws:settings', '{}');
    ro.close();
    chmodSync(path, 0o400);
    const reopened = openPrefs(path);
    const result = writePref(reopened, 'llmws:settings', '{"appearance":"light"}');
    reopened.close();
    chmodSync(path, 0o600);
    expect(result.ok).toBe(false);
  });
});
