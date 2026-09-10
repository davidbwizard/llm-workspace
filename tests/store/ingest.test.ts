import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents, countEvents } from '../../src/store/ingest.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

function ev(offset: number, hash = 'h' + offset): NormalizedEvent {
  return {
    provider: 'claude', sessionId: 's1', runId: null, agentId: null,
    ts: '2026-09-10T00:00:00Z', kind: 'prose', payload: { text: 'hi' },
    nativeId: null, sourceFile: '/f.jsonl', sourceOffset: offset,
    contentHash: hash, parserVersion: 1,
  };
}

describe('insertEvents', () => {
  it('inserts new events and reports the count written', () => {
    const db = openDb(':memory:');
    expect(insertEvents(db, [ev(0), ev(10)])).toBe(2);
    expect(countEvents(db)).toBe(2);
  });

  it('is idempotent — re-ingesting the same records writes nothing', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0), ev(10)]);
    expect(insertEvents(db, [ev(0), ev(10)])).toBe(0);
    expect(countEvents(db)).toBe(2);
  });

  it('re-ingests a record whose content changed at the same offset', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0, 'original')]);
    expect(insertEvents(db, [ev(0, 'rewritten')])).toBe(1);
    expect(countEvents(db)).toBe(2);
  });

  it('writes all-or-nothing within one call', () => {
    const db = openDb(':memory:');
    const bad = { ...ev(0), sessionId: null as unknown as string };
    expect(() => insertEvents(db, [ev(0), bad])).toThrow();
    expect(countEvents(db)).toBe(0);
  });

  it('counts per source file', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0), { ...ev(0), sourceFile: '/other.jsonl' }]);
    expect(countEvents(db, '/f.jsonl')).toBe(1);
  });
});
