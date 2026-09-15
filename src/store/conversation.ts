import type { Db } from './db.ts';

export const CONVERSATION_PAGE_SIZE = 50;

export type ConversationTurn = {
  id: number;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  agentId: string | null;
};

const NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** prompt.submitted sometimes carries a slash-command wrapper as literal text
 *  -- 115 Claude rows and 83 Codex rows in the real index. Rendered verbatim
 *  it shows as XML. Both providers do it, so this is one rule, not two. */
export function unwrapSlashCommand(text: string): string {
  if (!text.includes('<command-')) return text;
  const name = NAME.exec(text)?.[1]?.trim() ?? '';
  if (name === '') return '';
  const args = ARGS.exec(text)?.[1]?.trim() ?? '';
  return args === '' ? name : `${name} ${args}`;
}

/** Identifies one event by its sort key (ts, id) -- the pair actually used
 *  for ordering and paging, not ts alone: real sessions have events sharing
 *  a millisecond (verified against the real index -- e.g. two rows at
 *  2026-09-11T13:08:39.278Z in one session), so ts alone cannot break a tie
 *  and id is what does. */
export type ConversationCursor = { ts: string; id: number };

export type ConversationPage = {
  turns: ConversationTurn[];
  /** The cursor to pass back in as `before` to fetch the next OLDER page,
   *  or null when this page reached the start of the session's recorded
   *  history -- there is nothing older left to load, which is a genuine
   *  end-of-history fact worth the UI stating, unlike the truncation this
   *  type used to carry (dropped now that paging replaces it: nothing is
   *  hidden any more, just not yet fetched). */
  nextCursor: ConversationCursor | null;
};

/** Served entirely by events_session_ts(session_id, ts) -- src/store/schema.ts:50.
 *  Bug fix (this function's history): it used to be ORDER BY ts, id
 *  (oldest-first) with a single LIMIT, which took the FIRST `limit` turns of
 *  a session -- for the 53 real sessions over 500 turns (largest: 2,812),
 *  the user saw the opening of a conversation from days ago with the recent
 *  part unreachable. Ordering DESC takes the NEWEST turns first, which is
 *  also the order the UI renders in, so no re-reversal is needed here.
 *
 *  Paging (keyset, not OFFSET): `before`, when given, asks for the `limit`
 *  turns strictly older than that cursor. OFFSET would be wrong here even
 *  though the query is otherwise identical -- the events table is appended
 *  to continuously while a session is read, so an OFFSET-based "page 2"
 *  would skip or repeat rows as new events land between fetches. The
 *  `(ts, id) < (@ts, @id)` row-value comparison is exact regardless of
 *  concurrent inserts, because it names a specific row, not a position.
 *
 *  Over-fetches by one row (limit + 1) purely to compute `nextCursor`
 *  without a second COUNT query; the extra row, if present, is sliced off
 *  below and never reaches `turns`.
 *
 *  Re-verified with EXPLAIN QUERY PLAN against the real index, both without
 *  and with a cursor (including one at a real duplicate-ts boundary, to
 *  prove the tie-break neither skips nor repeats a row): both forms still
 *  read SEARCH events USING INDEX events_session_ts (session_id=? AND
 *  ts<?), not a SCAN, sub-millisecond on the busiest session (2,812
 *  matching events). The kind filter does not force a scan because
 *  session_id leads the index, so the missing events.kind index costs
 *  nothing here. Do not add one. */
export function conversationFor(
  db: Db,
  sessionId: string,
  limit = CONVERSATION_PAGE_SIZE,
  before?: ConversationCursor,
): ConversationPage {
  const query = before
    ? `SELECT id, ts, kind, agent_id, json_extract(payload,'$.text') AS text
       FROM events
       WHERE session_id = @sessionId AND kind IN ('prompt.submitted','prose')
         AND (ts, id) < (@ts, @id)
       ORDER BY ts DESC, id DESC
       LIMIT @fetchLimit`
    : `SELECT id, ts, kind, agent_id, json_extract(payload,'$.text') AS text
       FROM events
       WHERE session_id = @sessionId AND kind IN ('prompt.submitted','prose')
       ORDER BY ts DESC, id DESC
       LIMIT @fetchLimit`;

  const rows = db.prepare(query).all({
    sessionId, ts: before?.ts ?? null, id: before?.id ?? null, fetchLimit: limit + 1,
  }) as Array<{
    id: number; ts: string; kind: string; agent_id: string | null; text: string | null;
  }>;

  const hasMore = rows.length > limit;
  const windowRows = hasMore ? rows.slice(0, limit) : rows;
  const oldestInWindow = windowRows[windowRows.length - 1];
  const nextCursor = hasMore && oldestInWindow ? { ts: oldestInWindow.ts, id: oldestInWindow.id } : null;

  const turns: ConversationTurn[] = [];
  for (const r of windowRows) {
    if (r.text === null) continue;
    // prompt.submitted = user, prose = assistant, in BOTH parsers. This is the
    // provider-agnostic backbone; richer detail (tokens, tool payloads) is not.
    const role = r.kind === 'prompt.submitted' ? 'user' as const : 'assistant' as const;
    const text = role === 'user' ? unwrapSlashCommand(r.text) : r.text;
    if (text === '') continue;
    turns.push({ id: r.id, ts: r.ts, role, text, agentId: r.agent_id });
  }
  return { turns, nextCursor };
}
