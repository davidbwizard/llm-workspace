import type { Db } from './db.ts';

/** Human prompts (exchanges) per page -- not rows. See conversationFor. */
export const CONVERSATION_PAGE_SIZE = 50;

/** Narration the agent wrote on its way to a reply (usually just before a
 *  tool call). Nothing is ever grouped into steps any more -- see the
 *  no-collapse decision on conversationFor below -- so this type is now
 *  only a shape, never populated. Kept because ConversationTurn.steps still
 *  exists (see that field's own comment). */
export type ConversationStep = { id: number; ts: string; text: string };

export type ConversationTurn = {
  id: number;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  /** Always []. Every prose row is now its own turn (conversationFor's
   *  no-collapse decision below), so there is never earlier prose to fold
   *  in here. The field, ConversationView.tsx's Steps component, and the
   *  .steps-toggle/.steps-list CSS rules are all unreachable as a result --
   *  left in place because removing dead UI is a separate decision from the
   *  bug this type change fixes. */
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
 *  before the first prompt) and the prose that followed it, oldest first.
 *  Every row in `prose` becomes its own assistant turn -- see the
 *  no-collapse decision on conversationFor below -- so, unlike the version
 *  of this type that shipped in af376c9, a stretch no longer needs a
 *  turn.completed boundary to separate one agent turn from the next; a
 *  human prompt is the only thing that ever closes one. */
type Stretch = { prompt: Row | null; prose: Row[] };

/** Served by events_session_ts(session_id, ts) -- src/store/schema.ts.
 *
 *  What counts as the conversation:
 *  - Main thread only (agent_id IS NULL). Measured on session 92b09bc5,
 *    82 of 246 prompt rows and 810 of 1,184 prose rows were subagents. Safe
 *    for Codex too: its parser sets agent_id only inside a subagent's own
 *    rollout (real index: 3,406 of 3,459 Codex prompts and 48,342 of 48,529
 *    Codex prose rows have agent_id NULL).
 *  - No collapsing, for any provider: every prose row renders as its own
 *    assistant turn, `steps` always []. This replaces af376c9's attempt to
 *    keep one stretch's prose to a single reply (the last row) plus
 *    `steps` (the earlier rows), split from the next reply at
 *    turn.completed. That fix was wrong: turn.completed does not mean "one
 *    agent turn ended" for every provider. Claude's parser
 *    (providers/claude/parse.ts) emits it after EVERY assistant record that
 *    carries usage -- in practice after nearly every prose row, not once
 *    per logical reply (measured against the real index: 56,130
 *    turn.completed events against 12,519 Claude prose rows). So for
 *    Claude, `steps` was already always [] and turn counts inflated
 *    roughly 4.5x on real sessions (one measured: 45 turns / 329 steps
 *    became 374 turns / 0 steps) -- while Codex's task_complete really
 *    does mark one genuine reply, so the exact same code collapsed Codex
 *    turns the old code meant to collapse. One boundary, two different
 *    meanings depending which provider wrote it. Rather than give each
 *    provider its own rule, the decision is to not collapse at all: a
 *    reply containing a large table that this bug once hid entirely
 *    (David's original report) is exactly as visible as every other reply,
 *    for both providers, with nothing left implicit in a shared marker.
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
 *  stretch's prose off mid-stream. So:
 *   1. find the newest `limit + 1` prompts older than `before` (the extra one
 *      only tells us whether more remain);
 *   2. if more remain, the page's lower bound is the oldest prompt it keeps,
 *      and that prompt becomes nextCursor; otherwise there is no lower bound,
 *      which also sweeps in any prose recorded before the first prompt;
 *   3. read every main-thread prompt/prose row in [lower, before) and group.
 *  The page's own cut point is always a prompt row (`lowest`, from the
 *  prompts-only query above), and a prompt row always starts a fresh
 *  stretch, so a bound placed there can never split one mid-stretch.
 *  `(ts, id)` row values break same-millisecond ties exactly.
 *
 *  Both reads run in one transaction so they see the same snapshot.
 *
 *  kind IN (...) below deliberately excludes turn.completed again (it was
 *  briefly widened to three kinds by af376c9 to serve the collapsing this
 *  comment now says was wrong) -- narrower is also the safer paging query:
 *  fewer kinds read per page means less that could shift between the two
 *  reads. EXPLAIN QUERY PLAN against the real index (session 92b09bc5,
 *  9,995 events) previously confirmed all six bound combinations read
 *  SEARCH events USING INDEX events_session_ts, keyed (session_id=?) plus
 *  whichever of ts<? / ts>? the bounds add, never a SCAN, with no temp
 *  B-tree for ORDER BY (the index is (session_id, ts) plus rowid = id) --
 *  narrowing the kind list further cannot make that worse, since kind was
 *  never itself indexed and session_id already leads. Do not add an index
 *  for kind or agent_id. */
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
      // Only thing that closes a stretch now -- see this type's own
      // comment for why turn.completed no longer does.
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
    // No collapsing: every prose row in the stretch is its own turn, oldest
    // first, `steps` always [] -- see the no-collapse decision above.
    for (const reply of prose) {
      turns.push({ id: reply.id, ts: reply.ts, role: 'assistant', text: reply.text!, steps: [] });
    }
  }
  return { turns, nextCursor };
}
