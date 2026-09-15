import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { conversationFor, unwrapSlashCommand } from '../../src/store/conversation.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

let nextOffset = 0;

/** One prompt.submitted/prose row, unique enough to pass the events_identity
 *  UNIQUE index (source_file, source_offset, content_hash, sub_index)
 *  without every test having to think about that. */
function turnEvent(sessionId: string, ts: string, kind: 'prompt.submitted' | 'prose', text: string): NormalizedEvent {
  const offset = nextOffset++;
  return {
    provider: 'claude',
    sessionId,
    runId: null,
    agentId: null,
    ts,
    kind,
    payload: { text },
    nativeId: null,
    sourceFile: '/fake/transcript.jsonl',
    sourceOffset: offset,
    contentHash: `hash-${offset}`,
    subIndex: 0,
    parserVersion: 1,
  };
}

describe('unwrapSlashCommand', () => {
  it('reduces a slash-command wrapper to the command the user actually typed', () => {
    const raw = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
    expect(unwrapSlashCommand(raw)).toBe('/clear');
  });

  it('keeps the arguments when there are some', () => {
    const raw = '<command-name>/loop</command-name><command-args>5m /foo</command-args>';
    expect(unwrapSlashCommand(raw)).toBe('/loop 5m /foo');
  });

  it('leaves ordinary prose completely alone', () => {
    expect(unwrapSlashCommand('run the farm tests')).toBe('run the farm tests');
    expect(unwrapSlashCommand('use <angle brackets> in prose')).toBe('use <angle brackets> in prose');
  });

  it('returns empty for a wrapper with no command name, rather than leaking markup', () => {
    expect(unwrapSlashCommand('<command-message>x</command-message>')).toBe('');
  });

  // The test above passes even without the `name === ''` guard, because its
  // input also has empty args -- the final ternary already falls back to
  // `name` (empty) in that case. The guard only matters when name is empty
  // but args is not; without it this would leak a leading-space fragment
  // instead of the required empty string.
  it('returns empty rather than a bare-args fragment when the name is missing', () => {
    expect(unwrapSlashCommand('<command-args>foo</command-args>')).toBe('');
  });
});

describe('conversationFor', () => {
  // Bug fix: this query used to be ORDER BY ts, id (ascending) with a LIMIT,
  // which takes the FIRST `limit` turns of a session -- on the real index,
  // 53 sessions exceed 500 turns (largest: 2,812), so the user saw the
  // opening of a days-old conversation with the recent part unreachable.
  // This test pins the fix hard: with a limit smaller than the session's
  // turn count, the NEWEST turns must come back, not the oldest. Flipping
  // the query's DESC back to ASC must fail this test by name.
  it('returns the newest turns, not the oldest, when a session exceeds the limit', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'turn 0 (oldest)'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'turn 1'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'turn 2'),
      turnEvent('s1', '2026-09-01T00:03:00Z', 'prose', 'turn 3 (newest)'),
    ]);

    const { turns } = conversationFor(db, 's1', 2);

    expect(turns.map(t => t.text)).toEqual(['turn 3 (newest)', 'turn 2']);
  });

  it('presents turns newest-first', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'earliest'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'middle'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'latest'),
    ]);

    const { turns } = conversationFor(db, 's1');

    expect(turns.map(t => t.text)).toEqual(['latest', 'middle', 'earliest']);
  });

  it('reports truncated only when the session has more turns than the limit', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'a'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'b'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'c'),
    ]);

    expect(conversationFor(db, 's1', 2).truncated).toBe(true);
    expect(conversationFor(db, 's1', 3).truncated).toBe(false);
    expect(conversationFor(db, 's1', 10).truncated).toBe(false);
  });

  it('does not leak the truncation lookahead row into turns', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'a'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'b'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'c'),
    ]);

    const { turns, truncated } = conversationFor(db, 's1', 2);

    expect(truncated).toBe(true);
    expect(turns).toHaveLength(2);
  });
});
