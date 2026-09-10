import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { ingestSpool, rotateSpool } from '../../src/hooks/spool.ts';

let spool: string;
beforeEach(() => { spool = mkdtempSync(join(tmpdir(), 'sp-')); });
afterEach(() => rmSync(spool, { recursive: true, force: true }));

function drop(id: string, payload: Record<string, unknown>, occurred = '2026-09-10T00:00:00Z') {
  writeFileSync(join(spool, `${id}.json`),
    JSON.stringify({ event_id: id, occurred_at: occurred, ppid: 123, payload }));
}

describe('ingestSpool', () => {
  it('ingests each spooled event once', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop', session_id: 's1' });
    drop('e2', { hook_event_name: 'PermissionRequest', session_id: 's1', tool_use_id: 't1' });
    expect(ingestSpool(db, spool)).toBe(2);
    const rows = db.prepare('SELECT * FROM signal_events ORDER BY event_id').all() as any[];
    expect(rows.map(r => r.kind)).toEqual(['Stop', 'PermissionRequest']);
  });

  it('is idempotent — re-reading the spool writes nothing new', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop', session_id: 's1' });
    ingestSpool(db, spool);
    expect(ingestSpool(db, spool)).toBe(0);
  });

  it('extracts the correlation ids the rail needs', () => {
    const db = openDb(':memory:');
    drop('e1', {
      hook_event_name: 'PermissionRequest', session_id: 's1',
      prompt_id: 'p1', tool_use_id: 't1', transcript_path: '/t.jsonl',
    });
    ingestSpool(db, spool);
    const row = db.prepare('SELECT * FROM signal_events').get() as any;
    expect(row).toMatchObject({ session_id: 's1', prompt_id: 'p1', tool_use_id: 't1' });
  });

  it('separates occurred_at from ingested_at', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop' }, '2026-01-01T00:00:00Z');
    ingestSpool(db, spool);
    const row = db.prepare('SELECT * FROM signal_events').get() as any;
    expect(row.occurred_at).toBe('2026-01-01T00:00:00Z');
    expect(row.ingested_at).not.toBe(row.occurred_at);
  });

  it('skips a malformed spool file without aborting the batch', () => {
    const db = openDb(':memory:');
    writeFileSync(join(spool, 'bad.json'), 'not json');
    drop('e1', { hook_event_name: 'Stop' });
    expect(ingestSpool(db, spool)).toBe(1);
  });

  it('ignores .tmp files still being written', () => {
    const db = openDb(':memory:');
    writeFileSync(join(spool, '.half.tmp'), '{"event_id":"x"');
    expect(ingestSpool(db, spool)).toBe(0);
  });

  it('deletes files it successfully ingested', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop' });
    ingestSpool(db, spool);
    expect(readdirSync(spool).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });
});

describe('rotateSpool', () => {
  it('removes files older than the age cap', () => {
    drop('old', { hook_event_name: 'Stop' });
    const old = join(spool, 'old.json');
    const past = new Date(Date.now() - 40 * 86400_000);
    utimesSync(old, past, past);
    drop('new', { hook_event_name: 'Stop' });
    expect(rotateSpool(spool, { maxAgeDays: 30, maxFiles: 1000 })).toBe(1);
    expect(readdirSync(spool)).toEqual(['new.json']);
  });

  it('trims the oldest when the file cap is exceeded', () => {
    for (let i = 0; i < 5; i++) drop(`e${i}`, { hook_event_name: 'Stop' });
    rotateSpool(spool, { maxAgeDays: 3650, maxFiles: 3 });
    expect(readdirSync(spool)).toHaveLength(3);
  });
});
