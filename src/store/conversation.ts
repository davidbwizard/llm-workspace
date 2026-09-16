import type { Db } from './db.ts';

/** Human prompts (exchanges) per page -- not rows. See conversationFor. */
export const CONVERSATION_PAGE_SIZE = 50;

/** Narration the agent wrote on its way to a reply (usually just before a
 *  tool call). */
export type ConversationStep = { id: number; ts: string; text: string };

export type ConversationTurn = {
  id: number;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  /** Assistant turns: the earlier prose in the same stretch, oldest first.
   *  Always empty for user turns. */
  steps: ConversationStep[];
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

type Row = { id: number; ts: string; kind: string; text: string | null };

/** One stretch of the main thread: a human prompt (absent for prose recorded
 *  before the first prompt) and the prose that followed it, oldest first. */
type Stretch = { prompt: Row | null; prose: Row[] };

/** Served by events_session_ts(session_id, ts) -- src/store/schema.ts.
 *
 *  What counts as the conversation:
 *  - Main thread only (agent_id IS NULL). Measured on session 92b09bc5,
 *    82 of 246 prompt rows and 810 of 1,184 prose rows were subagents. Safe
 *    for Codex too: its parser sets agent_id only inside a subagent's own
 *    rollout (real index: 3,406 of 3,459 Codex prompts and 48,342 of 48,529
 *    Codex prose rows have agent_id NULL).
 *  - Each stretch between human prompts collapses to ONE assistant turn: the
 *    last prose before the next prompt is the reply, earlier prose in that
 *    stretch becomes its `steps` (narration emitted before tool calls).
 *
 *  Order WITHIN a page: oldest first, prompt before reply -- the order the
 *  pane renders top to bottom (spec 2026-09-15-conversation-pane-design.md
 *  §3.1). Paging still walks BACKWARDS through history: `before` is the
 *  cursor for the next OLDER page and `nextCursor` still names the oldest
 *  prompt this page kept. The bug this once had (ASC with a LIMIT showed a
 *  days-old opening and hid the recent part) must not come back: the
 *  prompt query below is still ORDER BY ts DESC with a LIMIT, so the FIRST
 *  page is still the newest exchanges. Only the assembled array's order
 *  changed, not which exchanges a page contains.
 *
 *  Paging is keyset, by human prompt, not by row. OFFSET would skip or
 *  repeat as events land between fetches; a row-count LIMIT would cut a
 *  reply off from its steps. So:
 *   1. find the newest `limit + 1` prompts older than `before` (the extra one
 *      only tells us whether more remain);
 *   2. if more remain, the page's lower bound is the oldest prompt it keeps,
 *      and that prompt becomes nextCursor; otherwise there is no lower bound,
 *      which also sweeps in any prose recorded before the first prompt;
 *   3. read every main-thread prompt/prose row in [lower, before) and group.
 *  Every stretch starts at a prompt, so a bound placed on a prompt can never
 *  split one. `(ts, id)` row values break same-millisecond ties exactly.
 *
 *  Both reads run in one transaction so they see the same snapshot.
 *
 *  EXPLAIN QUERY PLAN re-run against the real index (session 92b09bc5,
 *  9,995 events), for all six bound combinations: every one reads SEARCH
 *  events USING INDEX events_session_ts, keyed (session_id=?) plus whichever
 *  of ts<? / ts>? the bounds add, never a SCAN, and none needs a temp
 *  B-tree for ORDER BY (the index is (session_id, ts) plus rowid = id). The
 *  kind and agent_id filters do not force a scan because session_id leads
 *  the index. Do not add an index for them. */
export function conversationFor(
  db: Db,
  sessionId: string,
  limit = CONVERSATION_PAGE_SIZE,
  before?: ConversationCursor,
): ConversationPage {
  const upper = before ? 'AND (ts, id) < (@ts, @id)' : '';
  const read = db.transaction((): { rows: Row[]; nextCursor: ConversationCursor | null } => {
    const prompts = db.prepare(
      `SELECT id, ts FROM events
       WHERE session_id = @sessionId AND kind = 'prompt.submitted' AND agent_id IS NULL ${upper}
       ORDER BY ts DESC, id DESC
       LIMIT @fetchLimit`,
    ).all({ sessionId, ts: before?.ts ?? null, id: before?.id ?? null, fetchLimit: limit + 1 }) as Array<{ id: number; ts: string }>;

    const lowest = prompts.length > limit ? prompts[limit - 1] : undefined;
    const lower = lowest ? 'AND (ts, id) >= (@lowTs, @lowId)' : '';
    const rows = db.prepare(
      `SELECT id, ts, kind, json_extract(payload,'$.text') AS text FROM events
       WHERE session_id = @sessionId AND kind IN ('prompt.submitted','prose') AND agent_id IS NULL
         ${lower} ${upper}
       ORDER BY ts ASC, id ASC`,
    ).all({
      sessionId, ts: before?.ts ?? null, id: before?.id ?? null,
      lowTs: lowest?.ts ?? null, lowId: lowest?.id ?? null,
    }) as Row[];

    return { rows, nextCursor: lowest ? { ts: lowest.ts, id: lowest.id } : null };
  });
  const { rows, nextCursor } = read();

  const stretches: Stretch[] = [];
  let current: Stretch = { prompt: null, prose: [] };
  for (const r of rows) {
    if (r.kind === 'prompt.submitted') {
      if (current.prompt !== null || current.prose.length > 0) stretches.push(current);
      current = { prompt: r, prose: [] };
    } else if (r.text !== null && r.text !== '') {
      current.prose.push(r);
    }
  }
  if (current.prompt !== null || current.prose.length > 0) stretches.push(current);

  // prompt.submitted = user, prose = assistant, in BOTH parsers. This is the
  // provider-agnostic backbone; richer detail (tokens, tool payloads) is not.
  //
  // Emitted here in conversation order rather than reversed downstream: the
  // stretch loop above already knows the prompt-to-reply pairing, so saying
  // it once here is smaller than re-deriving it in the view, and every
  // consumer wants the same order.
  const turns: ConversationTurn[] = [];
  for (const { prompt, prose } of stretches) {
    // A wrapper that names no command unwraps to '' and shows nothing, but
    // it still bounds its stretch -- that keeps paging and grouping agreed.
    const text = prompt?.text ? unwrapSlashCommand(prompt.text) : '';
    if (prompt && text !== '') {
      turns.push({ id: prompt.id, ts: prompt.ts, role: 'user', text, steps: [] });
    }
    const reply = prose[prose.length - 1];
    if (reply) {
      turns.push({
        id: reply.id, ts: reply.ts, role: 'assistant', text: reply.text!,
        steps: prose.slice(0, -1).map(s => ({ id: s.id, ts: s.ts, text: s.text! })),
      });
    }
  }
  return { turns, nextCursor };
}
