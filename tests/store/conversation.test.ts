import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { conversationFor, unwrapSlashCommand, unwrapPastedContent, turnSource, type ConversationTurn } from '../../src/store/conversation.ts';
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

/** A note-flagged `prose` row -- parse.ts's shape for a reply Claude Code
 *  saved only as a thinking summary (CLAUDE_PARSER_VERSION 4). Same identity
 *  scheme as turnEvent above. */
function noteEvent(sessionId: string, ts: string, text: string, agentId: string | null = null): NormalizedEvent {
  const offset = nextOffset++;
  return {
    provider: 'claude',
    sessionId,
    runId: null,
    agentId,
    ts,
    kind: 'prose',
    payload: { text, role: 'assistant', note: true },
    nativeId: null,
    sourceFile: '/fake/transcript.jsonl',
    sourceOffset: offset,
    contentHash: `hash-${offset}`,
    subIndex: 0,
    parserVersion: 1,
  };
}

/** A turn.completed row. conversationFor's query no longer selects this kind
 *  at all (see conversation.ts's no-collapse comment) -- every use below
 *  exists only to prove that inserting one, however many, and wherever it
 *  falls, has zero effect on what the conversation shows. */
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

/** Compact view of a page: "you: x" / "agent: y". */
function view(turns: ConversationTurn[]): string[] {
  return turns.map(t => (t.role === 'user' ? `you: ${t.text}` : `agent: ${t.text}`));
}

describe('unwrapPastedContent', () => {
  // Recorded 2026-09-18 (Claude Code 2.1.276, ShellShockers session): a message
  // sent from the app arrived wrapped in Claude Code's paste tags.
  it('shows only the pasted text, without the tags or the leading blank lines', () => {
    const raw = '\n\n<pasted_content id="f3fc">\nHow would the player get the QR code or/and pass on the code?\n</pasted_content id="f3fc">\n';
    expect(unwrapPastedContent(raw)).toBe('How would the player get the QR code or/and pass on the code?');
  });

  it('keeps text around a pasted block and unwraps every block', () => {
    const raw = 'Look at this:\n<pasted_content id="a1">\nfirst\n</pasted_content id="a1">\nand\n<pasted_content id="b2">\nsecond\n</pasted_content id="b2">';
    expect(unwrapPastedContent(raw)).toBe('Look at this:\nfirst\nand\nsecond');
  });

  it('leaves text without the tags untouched, including its whitespace', () => {
    expect(unwrapPastedContent('  plain text\n')).toBe('  plain text\n');
  });

  it('does not unwrap a block whose closing id does not match', () => {
    const raw = '<pasted_content id="a1">\nx\n</pasted_content id="zz">';
    expect(unwrapPastedContent(raw)).toBe(raw);
  });
});

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
  // "agent" rows came from subagents. They are not the conversation. The
  // turn.completed rows (one per agent, one on the main thread) are
  // included only to confirm they have no effect at all any more -- the
  // query does not select that kind, subagent or not.
  it('leaves out subagent prompts and prose, and ignores turn.completed rows entirely', () => {
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

  // No collapsing: every prose row between two prompts is its own assistant
  // turn, in the order it was recorded, whether it reads as narration ahead
  // of a reply or as the reply itself -- conversationFor no longer tries to
  // tell those apart.
  it('emits every prose row in a stretch as its own turn, oldest first', () => {
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
      'agent: Reading the file.',
      'agent: Running tests.',
      'agent: All green.',
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

  it('keeps prose recorded before the first prompt, each as its own turn', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prose', 'resumed narration'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'resumed reply'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prompt.submitted', 'thanks'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'agent: resumed narration', 'agent: resumed reply', 'you: thanks',
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

  // The rule the brief called out: a page boundary never splits a stretch.
  // With one exchange per page, every page must carry every prose row that
  // stretch produced, however many, each as its own turn.
  it('never splits a stretch across a page boundary', () => {
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
    expect(view(page1.turns)).toEqual(['you: p2', 'agent: s4', 'agent: r2']);
    const page2 = conversationFor(db, 's1', 1, page1.nextCursor!);
    expect(view(page2.turns)).toEqual(['you: p1', 'agent: s1', 'agent: s2', 'agent: s3', 'agent: r1']);
    expect(page2.nextCursor).toBeNull();
  });

  // The bug this task fixes: an agent can reply many times between two
  // prompts -- background task notifications, subagent reports, other
  // wake-ups -- and each of those replies must show as its own turn. The
  // original fix (af376c9) tried to detect this via turn.completed; that
  // depended on turn.completed meaning "one reply just ended", which does
  // not hold for Claude (see conversation.ts's no-collapse comment). The
  // real fix is unconditional: no turn.completed appears in this fixture at
  // all, and every prose row between the two prompts still shows as its own
  // message (reported by David: a reply containing a large table was
  // invisible in the app though present in the underlying transcript).
  it('shows every agent turn between two prompts, not just the last one', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'kick off the background task'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'Started it, checking back shortly.'),
      turnEvent('s1', '2026-09-01T00:05:00Z', 'prose', 'Background task finished: all green.'),
      turnEvent('s1', '2026-09-01T00:10:00Z', 'prompt.submitted', 'thanks, ship it'),
      turnEvent('s1', '2026-09-01T00:10:01Z', 'prose', 'Shipped.'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'you: kick off the background task',
      'agent: Started it, checking back shortly.',
      'agent: Background task finished: all green.',
      'you: thanks, ship it',
      'agent: Shipped.',
    ]);
  });

  // turn.completed rows are not part of this query at all any more (see
  // conversation.ts's no-collapse comment). A stray one -- or a duplicate,
  // which real transcripts do produce -- sitting after the last reply with
  // nothing following it must not surface as a turn of any kind.
  it('does not produce a turn for trailing turn.completed rows', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'ask'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'reply'),
      turnCompletedEvent('s1', '2026-09-01T00:00:02Z'),
      turnCompletedEvent('s1', '2026-09-01T00:00:03Z'),
    ]);

    expect(view(conversationFor(db, 's1').turns)).toEqual(['you: ask', 'agent: reply']);
  });

  // Extends the "never splits a stretch" case above: a page boundary
  // (always cut at a prompt row -- see the doc comment on conversationFor)
  // must still carry every reply a stretch produced, none leaking onto the
  // neighbouring page. The turn.completed rows interspersed here are
  // exactly the shape a real Claude transcript has -- one after nearly
  // every prose row -- kept to prove they change nothing about the
  // grouping or the paging, not because they still do anything.
  it('keeps every reply from a stretch on the same page as its prompt', () => {
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

// parse.ts's note-flagged prose event (CLAUDE_PARSER_VERSION 4, a reply
// Claude Code saved only as a thinking summary) must keep that flag through
// this assembly step so the renderer can still tell it apart, even though
// every prose row is already its own turn (no collapsing) -- see
// conversationFor's own doc comment.
describe('conversationFor -- note flag (thinking-only replies)', () => {
  it('carries note:true onto the assistant turn for a note-flagged prose row', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'go'),
      noteEvent('s1', '2026-09-01T00:00:01Z', 'Kicking off the measurement.'),
    ]);

    const turns = conversationFor(db, 's1').turns;
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'Kicking off the measurement.', note: true });
  });

  it('never sets note on an ordinary reply -- the field is absent, not false', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'go'),
      turnEvent('s1', '2026-09-01T00:00:01Z', 'prose', 'Done.'),
    ]);

    const reply = conversationFor(db, 's1').turns[1]!;
    expect(reply.text).toBe('Done.');
    expect('note' in reply).toBe(false);
  });

  it('keeps a note turn and a plain reply as two separate turns, in recorded order', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'go'),
      noteEvent('s1', '2026-09-01T00:00:01Z', 'Planning the fix.'),
      turnEvent('s1', '2026-09-01T00:00:02Z', 'prose', 'Applied the fix.'),
    ]);

    const turns = conversationFor(db, 's1').turns;
    expect(view(turns)).toEqual(['you: go', 'agent: Planning the fix.', 'agent: Applied the fix.']);
    expect(turns[1]!.note).toBe(true);
    expect('note' in turns[2]!).toBe(false);
  });

  it('never sets note on a user prompt turn', () => {
    const db = openDb(':memory:');
    insertEvents(db, [turnEvent('s1', '2026-09-01T00:00:00Z', 'prompt.submitted', 'go')]);
    expect('note' in conversationFor(db, 's1').turns[0]!).toBe(false);
  });
});

describe('turnSource', () => {
  it("returns a turn's provider, kind and transcript location, or null", () => {
    const db = openDb(':memory:');
    insertEvents(db, [{
      provider: 'claude', sessionId: 's1', runId: 'r1', agentId: null, ts: '2026-09-17T10:00:00Z',
      kind: 'prompt.submitted', payload: { text: '[Image #1] hi' }, nativeId: null,
      sourceFile: '/p/s1.jsonl', sourceOffset: 1234, contentHash: 'h', subIndex: 0, parserVersion: 1,
    } as NormalizedEvent]);
    const id = (db.prepare('SELECT id FROM events').get() as { id: number }).id;
    expect(turnSource(db, id)).toEqual({
      provider: 'claude', kind: 'prompt.submitted', agentId: null, sourceFile: '/p/s1.jsonl', sourceOffset: 1234,
    });
    expect(turnSource(db, id + 1)).toBeNull();
  });
});
