import type { Db } from './db.ts';

export const CONVERSATION_LIMIT = 500;

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

export type Conversation = {
  turns: ConversationTurn[];
  /** True when the session has more matching events than `limit` -- the SQL
   *  cap cut the window short and older turns exist but are not in `turns`.
   *  The UI must say so rather than silently dropping them (that silence is
   *  the whole bug this type exists to fix). */
  truncated: boolean;
};

/** Served entirely by events_session_ts(session_id, ts) -- src/store/schema.ts:50.
 *  Bug fix: this used to be ORDER BY ts, id (oldest-first) with a LIMIT, which
 *  takes the FIRST `limit` turns of a session -- for the 53 real sessions
 *  over 500 turns (largest: 2,812), the user saw the opening of a
 *  conversation from days ago with the recent part unreachable. Ordering
 *  DESC takes the NEWEST `limit` turns instead, which is also the order the
 *  UI wants to render them in (newest first), so no re-reversal is needed
 *  here.
 *  Over-fetches by one row (limit + 1) purely to detect truncation without a
 *  second COUNT query; the extra row, if present, is sliced off below and
 *  never reaches `turns`.
 *  Re-verified with EXPLAIN QUERY PLAN against the real index under DESC:
 *  still SEARCH events USING INDEX events_session_ts (session_id=?), not a
 *  SCAN, and ~4ms on the busiest session (2,812 matching events) -- same as
 *  the original ASC query. The kind filter does not force a scan because
 *  session_id leads the index, so the missing events.kind index costs
 *  nothing here. Do not add one. */
export function conversationFor(db: Db, sessionId: string, limit = CONVERSATION_LIMIT): Conversation {
  const rows = db.prepare(`
    SELECT id, ts, kind, agent_id, json_extract(payload,'$.text') AS text
    FROM events
    WHERE session_id = ? AND kind IN ('prompt.submitted','prose')
    ORDER BY ts DESC, id DESC
    LIMIT ?
  `).all(sessionId, limit + 1) as Array<{
    id: number; ts: string; kind: string; agent_id: string | null; text: string | null;
  }>;

  const truncated = rows.length > limit;
  const windowRows = truncated ? rows.slice(0, limit) : rows;

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
  return { turns, truncated };
}
