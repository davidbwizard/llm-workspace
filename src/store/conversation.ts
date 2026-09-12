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

/** Served entirely by events_session_ts(session_id, ts) -- src/store/schema.ts:50.
 *  Verified with EXPLAIN QUERY PLAN against the real index: SEARCH, not SCAN,
 *  and 3ms on the busiest session (18,683 events). The kind filter does not
 *  force a scan because session_id leads the index, so the missing
 *  events.kind index costs nothing here. Do not add one. */
export function conversationFor(db: Db, sessionId: string, limit = CONVERSATION_LIMIT): ConversationTurn[] {
  const rows = db.prepare(`
    SELECT id, ts, kind, agent_id, json_extract(payload,'$.text') AS text
    FROM events
    WHERE session_id = ? AND kind IN ('prompt.submitted','prose')
    ORDER BY ts, id
    LIMIT ?
  `).all(sessionId, limit) as Array<{
    id: number; ts: string; kind: string; agent_id: string | null; text: string | null;
  }>;

  const turns: ConversationTurn[] = [];
  for (const r of rows) {
    if (r.text === null) continue;
    // prompt.submitted = user, prose = assistant, in BOTH parsers. This is the
    // provider-agnostic backbone; richer detail (tokens, tool payloads) is not.
    const role = r.kind === 'prompt.submitted' ? 'user' as const : 'assistant' as const;
    const text = role === 'user' ? unwrapSlashCommand(r.text) : r.text;
    if (text === '') continue;
    turns.push({ id: r.id, ts: r.ts, role, text, agentId: r.agent_id });
  }
  return turns;
}
