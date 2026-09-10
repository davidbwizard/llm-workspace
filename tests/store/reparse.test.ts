import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents, countEvents, reparseFile, getIngestState } from '../../src/store/ingest.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

function ev(offset: number, kind: NormalizedEvent['kind'] = 'prose'): NormalizedEvent {
  return {
    provider: 'claude', sessionId: 's1', runId: null, agentId: null,
    ts: '2026-09-10T00:00:00Z', kind, payload: {}, nativeId: null,
    sourceFile: '/f.jsonl', sourceOffset: offset, contentHash: 'h' + offset,
    parserVersion: 1,
  };
}

describe('reparseFile', () => {
  it('replaces a file\'s derived events rather than colliding with them', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0, 'prose'), ev(10, 'prose')]);

    // A fixed parser produces the SAME identity triple but a different kind.
    // Plain insert would be ignored by the unique index; reparse must replace.
    reparseFile(db, '/f.jsonl', () => [ev(0, 'tool.used'), ev(10, 'tool.used')], {
      inode: 1, size: 100, mtime: 'm', bytesConsumed: 100,
      parserVersion: 2, providerCliVersion: '2.1.267',
    });

    expect(countEvents(db, '/f.jsonl')).toBe(2);
    const kinds = db.prepare('SELECT kind FROM events ORDER BY source_offset')
      .all().map((r: any) => r.kind);
    expect(kinds).toEqual(['tool.used', 'tool.used']);
  });

  it('leaves other files untouched', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0), { ...ev(0), sourceFile: '/other.jsonl' }]);
    reparseFile(db, '/f.jsonl', () => [], {
      inode: 1, size: 0, mtime: 'm', bytesConsumed: 0, parserVersion: 1,
      providerCliVersion: null,
    });
    expect(countEvents(db, '/other.jsonl')).toBe(1);
    expect(countEvents(db, '/f.jsonl')).toBe(0);
  });

  it('never touches signal_events', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO signal_events
      (event_id, occurred_at, ingested_at, provider, kind, payload)
      VALUES (?,?,?,?,?,?)`).run('e1', 'a', 'b', 'claude', 'Stop', '{}');
    reparseFile(db, '/f.jsonl', () => [], {
      inode: 1, size: 0, mtime: 'm', bytesConsumed: 0, parserVersion: 1,
      providerCliVersion: null,
    });
    const c = db.prepare('SELECT COUNT(*) c FROM signal_events').get() as any;
    expect(c.c).toBe(1);
  });

  it('records ingest bookkeeping so truncation can be detected later', () => {
    const db = openDb(':memory:');
    reparseFile(db, '/f.jsonl', () => [ev(0)], {
      inode: 42, size: 500, mtime: '2026-09-10T00:00:00Z', bytesConsumed: 500,
      parserVersion: 1, providerCliVersion: '2.1.267',
    });
    const st = getIngestState(db, '/f.jsonl');
    expect(st).toMatchObject({ inode: 42, size: 500, bytes_consumed: 500, parser_version: 1 });
  });

  it('rolls back entirely if the parser throws', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0)]);
    expect(() => reparseFile(db, '/f.jsonl', () => { throw new Error('bad parse'); }, {
      inode: 1, size: 0, mtime: 'm', bytesConsumed: 0, parserVersion: 2,
      providerCliVersion: null,
    })).toThrow('bad parse');
    expect(countEvents(db, '/f.jsonl')).toBe(1);
  });
});
