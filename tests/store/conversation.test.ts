import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { conversationFor, unwrapSlashCommand, type ConversationTurn } from '../../src/store/conversation.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

let nextOffset = 0;

/** One prompt.submitted/prose row, unique enough to pass the events_identity
 *  UNIQUE index (source_file, source_offset, content_hash, sub_index)
 *  without every test having to think about that. */
function turnEvent(
  sessionId: string, ts: string, kind: 'prompt.submitted' | 'prose', text: string,
  agentId: string | null = null,
): NormalizedEvent {
  const offset = nextOffset++;
  return {
    provider: 'claude',
    sessionId,
    runId: null,
    agentId,
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

/** A turn.completed boundary row. It carries no text of its own in the real
 *  index -- only its position between prose rows matters -- so unlike
 *  turnEvent above it takes no text argument. */
function turnCompletedEvent(sessionId: string, ts: string, agentId: string | null = null): NormalizedEvent {
  const offset = nextOffset++;
  return {
    provider: 'claude',
    sessionId,
    runId: null,
    agentId,
    ts,
    kind: 'turn.completed',
    payload: {},
    nativeId: null,
    sourceFile: '/fake/transcript.jsonl',
    sourceOffset: offset,
    contentHash: `hash-${offset}`,
    subIndex: 0,
    parserVersion: 1,
  };
}

/** Compact view of a page: "you: x" / "agent: y [a|b]" (steps in brackets). */
function view(turns: ConversationTurn[]): string[] {
  return turns.map(t => t.role === 'user'
    ? `you: ${t.text}`
    : `agent: ${t.text}${t.steps.length ? ` [${t.steps.map(s => s.text).join('|')}]` : ''}`);
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
  // Measured on session 92b09bc5: 82 of 246 "you" rows and 810 of 1,184
  // "agent" rows came from subagents. They are not the conversation. A
  // subagent's own turn.completed rows are excluded the same way, by the
  // same agent_id filter -- worth pinning now that the query selects that
  // kind too, so a subagent's turn boundary can never split the main
  // thread's stretch.
  it('leaves out subagent prompts, prose, and turn boundaries', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'fix the bug'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prompt.submitted', 'You are a reviewer...', 'agent-1'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prose', 'Reviewing now.', 'agent-1'),
      turnCompletedEvent('s1', '2026-09-01T00:00:02Z', 'agent-1'),
      turnEvent('s1', '2026-09-01T00:00:03Z', 'prose', 'Fixed.'),
      turnCompletedEvent('s1', '2026-09-01T00:00:04Z'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual(['you: fix the bug', 'agent: Fixed.']);
  });

  // The reply is the last prose before the next boundary (a human prompt or
  // a turn.completed); everything the agent said earlier in that stretch
  // was narration around tool calls. No turn.completed appears in this
  // session at all, which is itself a real case (some recorded sessions
  // predate that event, or never emitted one) -- the old whole-stretch
  // grouping must still be exactly what a session with no turn boundaries
  // gets.
  it('groups narration under the reply it led up to, oldest step first', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'first ask'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'Reading the file.'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prose', 'Running tests.'),
      turnEvent('s1', '2026-09-01T00:00:03Z', 'prose', 'All green.'),
      turnEvent('s1', '2026-09-01T00:00:04Z', 'prompt.submitted', 'second ask'),
      turnEvent('s1', '2026-09-01T00:00:05Z', 'prose', 'Done.'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'you: first ask',
      'agent: All green. [Reading the file.|Running tests.]',
      'you: second ask',
      'agent: Done.',
    ]);
  });

  it('shows a prompt with no reply yet on its own', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'a'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'b'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prompt.submitted', 'still thinking about this one'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'you: a', 'agent: b', 'you: still thinking about this one',
    ]);
  });

  it('keeps prose recorded before the first prompt, grouped the same way', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prose', 'resumed narration'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'resumed reply'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prompt.submitted', 'thanks'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'agent: resumed reply [resumed narration]', 'you: thanks',
    ]);
  });

  it('shows a slash command as the command typed, and drops a wrapper that names none', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', '<command-name>/clear</command-name><command-args></command-args>'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prompt.submitted', '<command-message>x</command-message>'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prose', 'ok'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual(['you: /clear', 'agent: ok']);
  });

  // Bug fix (kept from the row-paged version): the page is the NEWEST
  // exchanges, not the opening of a days-old conversation. Paging is by
  // human prompt, so `limit` counts exchanges; the page's own contents are
  // ordered oldest-first, prompt before reply, which is the order the pane
  // renders top to bottom.
  it('returns the newest exchanges, not the oldest, when a session exceeds the limit', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'turn 0 (oldest)'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'turn 1'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'turn 2'),
      turnEvent('s1', '2026-09-01T00:03:00Z', 'prose', 'turn 3 (newest)'),
    ]);

    expect(view(conversationFor(db, 's1', 1).turns)).toEqual(['you: turn 2', 'agent: turn 3 (newest)']);
  });

  it('returns a null nextCursor only once the session is exhausted, non-null while more remain', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'a'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prose', 'b'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prompt.submitted', 'c'),
    ]);

    expect(conversationFor(db, 's1', 1).nextCursor).not.toBeNull();
    expect(conversationFor(db, 's1', 2).nextCursor).toBeNull();
    expect(conversationFor(db, 's1', 10).nextCursor).toBeNull();
  });

  // The rule the brief called out: a page boundary never separates a reply
  // from its steps. With one exchange per page, every page must carry its
  // whole stretch of narration, however long.
  it('never splits a reply from its steps across a page boundary', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'p1'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 's1'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prose', 's2'),
      turnEvent('s1', '2026-09-01T00:00:03Z', 'prose', 's3'),
      turnEvent('s1', '2026-09-01T00:00:04Z', 'prose', 'r1'),
      turnEvent('s1', '2026-09-01T00:00:05Z', 'prompt.submitted', 'p2'),
      turnEvent('s1', '2026-09-01T00:00:06Z', 'prose', 's4'),
      turnEvent('s1', '2026-09-01T00:00:07Z', 'prose', 'r2'),
    ]);

    const page1 = conversationFor(db, 's1', 1);
    expect(view(page1.turns)).toEqual(['you: p2', 'agent: r2 [s4]']);
    const page2 = conversationFor(db, 's1', 1, page1.nextCursor!);
    expect(view(page2.turns)).toEqual(['you: p1', 'agent: r1 [s1|s2|s3]']);
    expect(page2.nextCursor).toBeNull();
  });

  // The bug this task fixes: an agent turn ends at turn.completed, not only
  // at the next human prompt. An agent can reply many times between two
  // prompts -- background task notifications, subagent reports, other
  // wake-ups -- and each of those replies is its own turn. Before this fix,
  // every reply but the last between two prompts was silently collapsed
  // into "+ N steps" and never shown as a message (reported by David: a
  // reply containing a large table was invisible in the app though present
  // in the underlying transcript).
  it('shows every agent turn between two prompts, not just the last one', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'kick off the background task'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'Started it, checking back shortly.'),
      turnCompletedEvent('s1', '2026-09-01T00:00:02Z'),
      turnEvent('s1', '2026-09-01T00:05:00Z', 'prose', 'Background task finished: all green.'),
      turnCompletedEvent('s1', '2026-09-01T00:05:01Z'),
      turnEvent('s1', '2026-09-01T00:10:00Z', 'prompt.submitted', 'thanks, ship it'),
      turnEvent('s1', '2026-09-01T00:10:01Z', 'prose', 'Shipped.'),
      turnCompletedEvent('s1', '2026-09-01T00:10:02Z'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'you: kick off the background task',
      'agent: Started it, checking back shortly.',
      'agent: Background task finished: all green.',
      'you: thanks, ship it',
      'agent: Shipped.',
    ]);
  });

  // The other half of the same fix: turn.completed splits BETWEEN turns, and
  // must not also split WITHIN one. Narration ahead of a turn's own final
  // reply still collapses into that turn's steps exactly as before.
  it('still collapses narration within one agent turn into steps, with turn.completed marking only where the turn ends', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'first ask'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'Reading the file.'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prose', 'Running tests.'),
      turnEvent('s1', '2026-09-01T00:00:03Z', 'prose', 'All green.'),
      turnCompletedEvent('s1', '2026-09-01T00:00:04Z'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'you: first ask',
      'agent: All green. [Reading the file.|Running tests.]',
    ]);
  });

  // turn.completed is a pure boundary marker with no text of its own. One
  // with nothing after it -- or a stray duplicate, which real transcripts do
  // produce -- must not manufacture an empty assistant turn.
  it('does not produce an empty turn for a turn.completed with no prose after it', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'ask'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'reply'),
      turnCompletedEvent('s1', '2026-09-01T00:00:02Z'),
      turnCompletedEvent('s1', '2026-09-01T00:00:03Z'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual(['you: ask', 'agent: reply']);
  });

  // Extends the "never splits a reply from its steps" case above to several
  // agent turns inside one stretch: a page boundary (always cut at a prompt
  // row -- see the doc comment on conversationFor) must still carry every
  // reply the stretch produced, however many turn.completed boundaries fall
  // inside it, and none of them may leak onto the neighbouring page.
  it('keeps every reply from a stretch on the same page as its prompt, across multiple turn.completed boundaries', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'p1'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'r1a'),
      turnCompletedEvent('s1', '2026-09-01T00:00:02Z'),
      turnEvent('s1', '2026-09-01T00:00:03Z', 'prose', 'r1b'),
      turnCompletedEvent('s1', '2026-09-01T00:00:04Z'),
      turnEvent('s1', '2026-09-01T00:00:05Z', 'prompt.submitted', 'p2'),
      turnEvent('s1', '2026-09-01T00:00:06Z', 'prose', 'r2'),
      turnCompletedEvent('s1', '2026-09-01T00:00:07Z'),
    ]);

    const page1 = conversationFor(db, 's1', 1);
    expect(view(page1.turns)).toEqual(['you: p2', 'agent: r2']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = conversationFor(db, 's1', 1, page1.nextCursor!);
    expect(view(page2.turns)).toEqual(['you: p1', 'agent: r1a', 'agent: r1b']);
    expect(page2.nextCursor).toBeNull();
  });

  // Keyset paging, not OFFSET: the events table is appended to while the
  // user reads. Walks the whole session one exchange at a time and checks
  // the pages tile exactly.
  it('a cursor page returns the exchanges immediately older than it, with no overlap and no gap', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prose', 'pre-prompt reply'),
      turnEvent('s1', '2026-09-01T00:01:00Z', 'prompt.submitted', 'turn 1'),
      turnEvent('s1', '2026-09-01T00:02:00Z', 'prose', 'turn 2'),
      turnEvent('s1', '2026-09-01T00:03:00Z', 'prompt.submitted', 'turn 3'),
      turnEvent('s1', '2026-09-01T00:04:00Z', 'prose', 'turn 4'),
      turnEvent('s1', '2026-09-01T00:05:00Z', 'prompt.submitted', 'turn 5 (newest)'),
    ]);

    const page1 = conversationFor(db, 's1', 2);
    expect(view(page1.turns)).toEqual(['you: turn 3', 'agent: turn 4', 'you: turn 5 (newest)']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = conversationFor(db, 's1', 2, page1.nextCursor!);
    // Fewer than `limit` prompts remain, so this page also takes the prose
    // recorded before the first prompt and reports exhaustion.
    expect(view(page2.turns)).toEqual(['agent: pre-prompt reply', 'you: turn 1', 'agent: turn 2']);
    expect(page2.nextCursor).toBeNull();
  });

  // Dropping `id` from the cursor's tie-break (comparing on `ts` alone)
  // skips or duplicates a row whenever two events share a timestamp, which
  // happens on the real index. The page boundary sits AT the shared
  // timestamp on purpose.
  it('breaks a timestamp tie by id, so paging through a shared timestamp neither skips nor repeats a row', () => {
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
      seen.push(...view(page.turns));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual([
      'you: c (newer half of the tie)', 'agent: d (newest)',
      'you: a (oldest)', 'agent: b (older half of the tie)',
    ]);
  });
});
