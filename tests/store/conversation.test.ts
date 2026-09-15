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

  it('returns a null nextCursor only once the session is exhausted, non-null while more remain', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'a'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'b'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'c'),
    ]);

    expect(conversationFor(db, 's1', 2).nextCursor).not.toBeNull();
    expect(conversationFor(db, 's1', 3).nextCursor).toBeNull();
    expect(conversationFor(db, 's1', 10).nextCursor).toBeNull();
  });

  it('does not leak the nextCursor lookahead row into turns', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'a'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'b'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'c'),
    ]);

    const { turns, nextCursor } = conversationFor(db, 's1', 2);

    expect(nextCursor).not.toBeNull();
    expect(turns).toHaveLength(2);
  });

  // Keyset paging, not OFFSET (the brief's own rationale: the events table
  // is appended to while the user reads, so OFFSET would skip or repeat
  // rows as new events land between fetches -- a cursor names a specific
  // row instead of a position). This walks the whole session two turns at
  // a time and checks the pages tile exactly: every turn appears in
  // exactly one page, in the same order conversationFor would return them
  // in one call, with the last page correctly reporting exhaustion.
  it('a cursor page returns the turns immediately older than it, with no overlap and no gap', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'turn 0'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'turn 1'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'turn 2'),
      turnEvent('s1', '2026-09-01T00:03:00Z', 'prose', 'turn 3'),
      turnEvent('s1', '2026-09-01T00:04:00Z', 'prompt.submitted', 'turn 4 (newest)'),
    ]);

    const page1 = conversationFor(db, 's1', 2);
    expect(page1.turns.map(t => t.text)).toEqual(['turn 4 (newest)', 'turn 3']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = conversationFor(db, 's1', 2, page1.nextCursor!);
    expect(page2.turns.map(t => t.text)).toEqual(['turn 2', 'turn 1']);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = conversationFor(db, 's1', 2, page2.nextCursor!);
    expect(page3.turns.map(t => t.text)).toEqual(['turn 0']);
    // Exhausting history is handled: the session has nothing older than
    // "turn 0", and the page says so rather than returning an empty page
    // that looks the same as "try again".
    expect(page3.nextCursor).toBeNull();
  });

  // Mutation target named in the brief: dropping `id` from the cursor's
  // tie-break (comparing on `ts` alone) either skips or duplicates a row
  // whenever two events share a timestamp -- which happens on the real
  // index (verified: two rows share a millisecond in one real session) --
  // but is invisible on fixtures where every ts is unique. This fixture
  // puts the page boundary AT a shared timestamp on purpose, walking the
  // whole session one turn at a time so every tie is a page boundary.
  it("breaks a timestamp tie by id, so paging through a shared timestamp neither skips nor repeats a row", () => {
    const db = openDb(':memory:');
    const TIE = '2026-09-01T00:01:00Z';
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'a (oldest)'),
      turnEvent('s1', TIE, 'prose', 'b (older half of the tie)'),
      turnEvent('s1', TIE, 'prompt.submitted', 'c (newer half of the tie)'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prose', 'd (newest)'),
    ]);

    const seen: string[] = [];
    let cursor = undefined as Parameters<typeof conversationFor>[3];
    for (let i = 0; i < 10; i++) {
      const page = conversationFor(db, 's1', 1, cursor);
      seen.push(...page.turns.map(t => t.text));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(['d (newest)', 'c (newer half of the tie)', 'b (older half of the tie)', 'a (oldest)']);
  });
});
