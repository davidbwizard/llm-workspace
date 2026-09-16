import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationPage, ConversationStep, ConversationTurn } from '../../store/conversation.ts';
import type { MatchQuality } from '../../discovery/match.ts';
import type { Provider } from '../../core/types.ts';
import type { KeysResult } from '../../main/ipc.ts';
import { ProviderMark } from './ProviderMark.tsx';
import { REFUSAL_TEXT } from './ReplyPopover.tsx';
import './ConversationView.css';

/** Transcript text is untrusted, so markdown rendering is locked down:
 *  - No rehype-raw. react-markdown turns raw HTML into plain text, so it
 *    shows escaped and never becomes an element.
 *  - Links get target=_blank. A click then goes through the main process's
 *    setWindowOpenHandler (src/main/index.ts), which opens only https links in
 *    the browser and denies everything else; will-navigate is blocked there
 *    too. The app window itself never navigates. react-markdown's default
 *    urlTransform already blanks javascript: and other unsafe schemes.
 *  - Images never load (no remote fetch, no tracking pixel). The alt text
 *    stands in for them. */
/** The word "agent" is gone from the meta line (spec §2): the agent is
 *  marked with its provider's own glyph, in the accent colour. The glyph is
 *  aria-hidden (ProviderMark.tsx), so the provider's NAME rides along in a
 *  visually-hidden span -- a screen reader hears "Claude", a reader sees the
 *  mark, and neither hears nor sees the word "agent". */
const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ alt }) => <span className="md-image">{alt || 'image'}</span>,
};

function MarkdownText({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</Markdown>;
}

/** The narration an agent wrote on its way to a reply, collapsed by default
 *  so the reply is what a reader sees first. */
function Steps({ steps }: { steps: ConversationStep[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const label = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return (
    <div className="steps">
      <button
        type="button"
        className="steps-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(o => !o)}
      >
        {open ? `- ${label}` : `+ ${label}`}
      </button>
      {open && (
        <ol id={listId} className="steps-list">
          {steps.map(s => <li key={s.id} className="step"><MarkdownText text={s.text} /></li>)}
        </ol>
      )}
    </div>
  );
}

/** "Sep 12" -- no year, no weekday. Grouped with the time below rather than
 *  spelled out on every row (see showDate in the render loop). Pinned to
 *  en-US rather than the runtime's default locale so this renders the same
 *  format on every machine (and so tests can assert an exact string). */
function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** e.g. "10:32 AM" -- the one piece of every row's timestamp; the date above
 *  it only reappears when it changes. Same en-US pin as formatDate, for the
 *  same reason. */
function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** How close (in px) to the TOP of the scroll container counts as "close
 *  enough to fetch the next page" -- a little slack so the fetch is already
 *  in flight by the time the reader actually reaches the oldest loaded
 *  message, rather than starting only once they hit the top and have to
 *  wait staring at nothing. */
const LOAD_MORE_THRESHOLD_PX = 150;

/** How close to the bottom counts as "still following the conversation".
 *  Inside this, new messages scroll the pane down; outside it, the view
 *  stays where the reader put it and offers Jump to latest instead (spec
 *  §3.2). 80px is roughly one message of slack. */
const STICKY_BOTTOM_PX = 80;

/** Chat order (spec §3.1) puts the OLDEST loaded turn at the TOP, so
 *  reading further back in time means scrolling UP -- and "running low on
 *  loaded history" means nearing the top, which is what this checks. It
 *  used to mean the opposite, because the pane used to render newest-first;
 *  that is the single behaviour change here, not a new function.
 *
 *  Takes only `scrollTop`: the distance from the top IS scrollTop, with no
 *  height arithmetic to do, which is also why the tests for this need no
 *  jsdom geometry stub at all.
 *
 *  Exported as a plain function over plain numbers, rather than inlined
 *  against a live element, because jsdom does not compute real layout. */
export function nearOlderEdge(metrics: { scrollTop: number }, thresholdPx = LOAD_MORE_THRESHOLD_PX): boolean {
  return metrics.scrollTop < thresholdPx;
}

/** Whether the reader is still following the newest end. Same
 *  numbers-not-elements shape as nearOlderEdge, for the same jsdom reason.
 *  A pane with nothing to scroll (scrollHeight <= clientHeight) reads as
 *  at-the-bottom, which is correct: there is no "up" to have scrolled to. */
export function nearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx = STICKY_BOTTOM_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

/** Where scrollTop must land after a PREPEND so the reader's eye does not
 *  move. Content inserted above the viewport pushes everything down by
 *  exactly the height it added, so adding that same delta back cancels it
 *  out. Clamped at 0: a commit that made the pane shorter would otherwise
 *  produce a negative position, which a browser clamps silently and jsdom
 *  stores verbatim -- a difference no test would catch except this one. */
export function restoredScrollTop(
  scrollTopBefore: number, scrollHeightBefore: number, scrollHeightAfter: number,
): number {
  return Math.max(0, scrollTopBefore + (scrollHeightAfter - scrollHeightBefore));
}

/** Identity of the newest turn, including its length. A prepend never
 *  changes it; a brand-new turn does; and so does the last assistant turn
 *  growing as its reply streams, which is exactly what the sticky bottom
 *  needs to follow. */
function lastTurnKey(turns: ConversationTurn[]): string | null {
  const last = turns[turns.length - 1];
  return last ? `${last.id}:${last.text.length}` : null;
}

/** Folds a freshly-fetched NEWEST page into the turns already loaded.
 *
 *  Two rules, and they are different on purpose:
 *  - a turn whose id is already loaded is REPLACED in place, because the
 *    last assistant turn grows as its reply streams and keeps its row id;
 *  - anything genuinely new is appended at the bottom, in the incoming
 *    page's own (oldest-first) order.
 *
 *  Older pages the reader deliberately loaded sit above the newest page and
 *  are simply absent from it -- so they are carried through untouched
 *  rather than being treated as turns the server has forgotten. */
export function mergeNewest(current: ConversationTurn[], incoming: ConversationTurn[]): ConversationTurn[] {
  if (incoming.length === 0) return current;
  const byId = new Map(incoming.map(t => [t.id, t]));
  const merged = current.map(t => byId.get(t.id) ?? t);
  const seen = new Set(current.map(t => t.id));
  for (const t of incoming) if (!seen.has(t.id)) merged.push(t);
  return merged;
}

/** The message box under the conversation (spec §3.4). Never hidden, only
 *  ever disabled with a reason: a box that vanishes reads as a missing
 *  feature, a disabled one reads as a state (spec §7.1, David's own
 *  ruling).
 *
 *  Sends through the same session:keys channel the rail's popover uses, so
 *  every guard part 1 established still applies -- including the one that
 *  matters most: this box does not answer choices. A typed reply to a
 *  picker is ignored and Enter selects whatever option is highlighted
 *  (measured 2026-09-15, "blue" recorded as "Red"), so a prompt_open
 *  refusal offers the Terminal view instead of a retry. */
function MessageBox({ pid, tmux, onOpenTerminal }: {
  pid: number | null;
  tmux: boolean;
  onOpenTerminal: () => void;
}) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const disabledReason = pid === null
    ? 'This session is not running.'
    : !tmux ? REFUSAL_TEXT.not_tmux : null;

  async function send(): Promise<void> {
    if (pid === null || text.trim() === '' || sending) return;
    setSending(true);
    setMessage(null);
    setChoiceOpen(false);
    try {
      const r: KeysResult | undefined = await window.fleet?.sendKeys(pid, text);
      if (r?.status === 'sent') { setText(''); return; }
      // The text is deliberately KEPT on a refusal: the person can fix
      // whatever was wrong (answer the choice, reattach) and press Enter
      // again, rather than retyping what they already wrote.
      setMessage(r ? REFUSAL_TEXT[r.reason] : 'Could not reach the app.');
      setChoiceOpen(r?.status === 'refused' && r.reason === 'prompt_open');
    } catch (err) {
      // A rejected sendKeys means the message did NOT go out, and the one
      // thing that must never happen is the box looking like it did. Narrow
      // (it wraps a single await, so it cannot swallow a render error) and
      // never silent: the cause is logged, the person is told, and the text
      // is kept for a retry exactly as on a returned refusal above.
      console.error('Conversation message send failed:', err);
      setMessage('Could not reach the app.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="convbox">
      <textarea
        className="convinput"
        aria-label="Message this session"
        rows={2}
        value={text}
        disabled={disabledReason !== null || sending}
        placeholder={disabledReason ?? 'Message this session'}
        onChange={e => setText(e.target.value)}
        // Enter sends, with no confirmation, however long the message
        // (spec §7.2). Shift+Enter is the line break, which is what makes
        // a multi-line message typeable at all.
        onKeyDown={e => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          void send();
        }}
      />
      {disabledReason !== null && <p className="convmsg">{disabledReason}</p>}
      {message !== null && (
        <p className="convmsg" role="status">
          {message}
          {choiceOpen && tmux && (
            <button type="button" className="convsend" onClick={onOpenTerminal}>Open Terminal</button>
          )}
        </p>
      )}
    </div>
  );
}

/** The clean half of the toggle: what was said, not how it was rendered.
 *  This is the only view a non-tmux session can have, and it is still a real
 *  upgrade on the card -- the card shows one line.
 *
 *  sessionId is `string | null`, not `string` -- OpenSession.sessionId
 *  (src/fleet/state.ts) is null whenever the open process's cwd matches no
 *  transcript session, or matches several ambiguously. On a real workspace
 *  with many sessions sharing a directory, ambiguous is the COMMON case, not
 *  an edge case. Rendering the empty-conversation message for that would be
 *  a lie: "no conversation recorded" claims the session said nothing, when
 *  the truth is we don't know which session this process even is. Same "say
 *  nothing rather than guess" rule as OpenSessionCard's lastProse.
 *
 *  `match` (OpenSession.match) says WHY sessionId is null, and the three
 *  cases are genuinely different claims, not one message with a variable
 *  slotted in: 'ambiguous' means several RECORDED sessions share this
 *  process's cwd (contention against history, never "open sessions" --
 *  a user can hit this with exactly one session open); 'unknown' means no
 *  transcript has matched at all, which is also what a session looks like
 *  in the moment right after it launches, before its first events are
 *  written and ingested; and no match info at all (match omitted) falls
 *  back to a neutral message rather than asserting either specific claim. */
export function ConversationView({ sessionId, match, provider, events, pid, tmux, onOpenTerminal }: {
  sessionId: string | null;
  match?: MatchQuality;
  /** Which CLI this session is, so the agent's meta line carries that
   *  provider's own mark. MainPane always knows it (OpenSession.provider
   *  comes straight from the pgrep that found the process). */
  provider: Provider;
  /** The matched session's monotonic event count, straight off the
   *  fleet:update push MainPane already receives. Null when this process
   *  matches no session uniquely -- there is nothing to refresh then. */
  events: number | null;
  /** The live process behind this pane, or null when the selected pid has
   *  left the fleet. Null is what disables the box with "This session is
   *  not running." rather than removing it. */
  pid: number | null;
  /** Whether that process is tmux-backed. Only a tmux-backed session can be
   *  typed into at all (src/main/ipc.ts's sendKeysFor refuses not_tmux). */
  tmux: boolean;
  /** Switches the pane to the Terminal view -- the only way to answer a
   *  choice, which this box deliberately cannot do. */
  onOpenTerminal: () => void;
}) {
  const [page, setPage] = useState<ConversationPage | null>(null);
  /** True once the mount fetch (below) has rejected. This is the one call
   *  site whose failure the reader must be told about: page stays null on
   *  rejection, and the render's page===null branch reads that as still
   *  loading -- a lie once nothing is loading and nothing ever will. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** True once new content has landed at the bottom while the reader was
   *  scrolled away from it -- the Jump to latest button's whole condition
   *  (spec §3.2). Cleared by reaching the bottom, by the button itself, and
   *  by switching session. */
  const [missedLatest, setMissedLatest] = useState(false);
  // A ref, not just the `loadingMore` state, guards the actual fetch:
  // scroll fires far faster than React re-renders commit, so a handler
  // that only checked state could read a stale "not loading" on two scroll
  // events back to back and fire two fetches. A ref is read and written
  // synchronously, with no render in between, so it is the guard that
  // actually holds under a real burst of scroll events, not just in a
  // test that calls the handler once.
  const loadingMoreRef = useRef(false);
  /** The most recently committed sessionId, kept current by the mount
   *  effect below. loadMore's fetch closes over the sessionId it was
   *  issued for; comparing that against this ref at resolve time is what
   *  stops a stale older-page fetch -- for a session the reader has since
   *  left -- from landing on whatever session is open now. Mirrors the
   *  mount effect's own `alive` flag, but as a ref rather than a closure
   *  variable, because loadMore runs outside that effect and needs to
   *  check WHICH session is current, not merely whether one is alive. */
  const sessionIdRef = useRef<string | null>(sessionId);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Set by loadMore immediately before a prepend commits, consumed by the
   *  layout effect below. A ref rather than state because it must be read
   *  in the same commit that wrote it, with no render in between. */
  const pendingRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  /** Whether the reader was at the bottom at the last scroll event. Read in
   *  a layout effect, so it must be a ref, not state. */
  const stickyRef = useRef(true);
  /** Has this session's pane been scrolled to the bottom yet. */
  const landedRef = useRef(false);
  /** The last turn's identity AND length, so a reply that grows in place as
   *  it streams counts as new content just as a brand-new turn does. */
  const lastTurnKeyRef = useRef<string | null>(null);
  /** The events count this pane has already fetched for. Starts unset per
   *  session so the very first value is recorded, not acted on: the mount
   *  fetch has already covered it. */
  const seenEventsRef = useRef<number | null>(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    if (sessionId === null) return; // nothing to fetch -- see the doc comment above.
    let alive = true;
    setPage(null);
    setLoadFailed(false);
    setMissedLatest(false);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    pendingRestoreRef.current = null;
    stickyRef.current = true;
    landedRef.current = false;
    lastTurnKeyRef.current = null;
    seenEventsRef.current = null;
    void window.fleet?.conversation(sessionId).then(p => {
      if (alive) setPage(p);
    }).catch(err => {
      // Logged unconditionally -- an old fetch failing is real information
      // even once the reader has moved on and it can no longer act on the
      // screen. Only the state change below is scoped to `alive`, so a
      // slow rejection for a session the reader has since left cannot put
      // the NEW session's pane into an error state.
      console.error('Conversation mount fetch failed:', err);
      if (alive) setLoadFailed(true);
    });
    return () => { alive = false; };
  }, [sessionId]);

  /** Live updates (spec §3.3). No conversation data is pushed today --
   *  fleet:update carries open-session cards only -- but `events` on those
   *  cards is a per-session monotonic count that changes on exactly the
   *  transitions that matter. When it moves, fetch the NEWEST page (no
   *  cursor) and merge; pages the reader loaded above stay put, and so does
   *  the cursor they are paging from, which must not be replaced by the
   *  newest page's own or the next "load older" would walk history the
   *  reader already has. */
  useEffect(() => {
    if (sessionId === null || events === null) return;
    if (seenEventsRef.current === null) { seenEventsRef.current = events; return; }
    if (seenEventsRef.current === events) return;
    seenEventsRef.current = events;
    let alive = true;
    void window.fleet?.conversation(sessionId).then(next => {
      if (!alive) return;
      setPage(current => current === null
        ? current
        : { turns: mergeNewest(current.turns, next.turns), nextCursor: current.nextCursor });
    }).catch(err => {
      // A failed background refresh must never destroy content the reader
      // is looking at -- no error UI, no clearing the pane, and no retry
      // timer or seenEventsRef rollback: seenEventsRef was already updated
      // above, before the fetch, so if the session goes idle immediately
      // after this failure the pane stays stale until the next events
      // change. That is accepted, not a bug to engineer around. Logged
      // unconditionally, with no `alive` check: this catch never touches
      // state, so there is nothing here to scope to this effect
      // invocation -- and a refresh failing is real information even for a
      // session the reader has since left, same reasoning as the mount
      // fetch's catch above.
      console.error('Conversation refresh fetch failed:', err);
    });
    return () => { alive = false; };
  }, [sessionId, events]);

  /** All scroll bookkeeping, in a LAYOUT effect so it runs before the
   *  browser paints: landing at the bottom or restoring a prepend in a
   *  plain effect would show one frame at the wrong offset first.
   *
   *  jsdom computes no layout, so none of the arithmetic here is asserted
   *  through the DOM -- nearBottom and restoredScrollTop above carry the
   *  tests, and this effect is the (deliberately dull) wiring between them
   *  and a real element. */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null || page === null) return;

    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      pendingRestoreRef.current = null;
      el.scrollTop = restoredScrollTop(pending.scrollTop, pending.scrollHeight, el.scrollHeight);
      return;
    }

    if (!landedRef.current) {
      landedRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastTurnKeyRef.current = lastTurnKey(page.turns);
      return;
    }

    const key = lastTurnKey(page.turns);
    const grewAtBottom = key !== null && key !== lastTurnKeyRef.current;
    lastTurnKeyRef.current = key;
    if (!grewAtBottom) return;
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
    else setMissedLatest(true);
  }, [page]);

  const turns = page?.turns ?? [];
  const nextCursor = page?.nextCursor ?? null;

  // Fetches the next OLDER page and PREPENDS it, because chat order puts
  // the oldest loaded turn at the top, so continuing the timeline further
  // back means adding on there. A prepend moves every already-rendered
  // message down by the height it added, which is the classic scroll jump
  // -- pendingRestoreRef records the pre-commit geometry so the layout
  // effect above can cancel it out exactly.
  function loadMore() {
    if (sessionId === null || nextCursor === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void window.fleet?.conversation(sessionId, nextCursor).then(next => {
      // Stale: the reader left this session before the fetch resolved.
      // Without this check, a slow older-page fetch for the OLD session
      // can resolve after the NEW session's own page has already landed
      // and prepend the old session's turns onto it.
      if (sessionIdRef.current !== sessionId) return;
      const el = scrollerRef.current;
      if (el !== null) pendingRestoreRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      setPage(current => current === null
        ? current
        : { turns: [...next.turns, ...current.turns], nextCursor: next.nextCursor });
    }).catch(err => {
      // The pane still holds every turn it had; only the older page is
      // missing. No error UI, no clearing the pane, and no disabling
      // further attempts -- the .finally() below already clears
      // loadingMoreRef, so scrolling near the top again re-fires loadMore
      // and this self-heals on the reader's next scroll. Logged
      // unconditionally, unlike the `.then()` above: this catch never
      // touches state, so the sessionIdRef staleness check that guards the
      // `.then()` does not apply here.
      console.error('Conversation load-more fetch failed:', err);
    }).finally(() => {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    });
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const atBottom = nearBottom(e.currentTarget);
    stickyRef.current = atBottom;
    if (atBottom) setMissedLatest(false);
    if (nearOlderEdge(e.currentTarget)) loadMore();
  }

  function jumpToLatest() {
    const el = scrollerRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    stickyRef.current = true;
    setMissedLatest(false);
  }

  // One shape in every state (spec §7.1's reasoning, applied to the whole
  // pane): the scroller is always there, and what varies is what is inside
  // it. The three "we cannot identify this session" messages, the loading
  // state and the empty state used to be whole-component early returns --
  // which would have meant the message box below vanishing in exactly the
  // states a person most wants to see it.
  function note(text: string) {
    return <p className="convnote">{text}</p>;
  }
  let body: React.ReactNode;
  if (sessionId === null) {
    body = match === 'ambiguous'
      ? note(`This working directory has several recorded sessions, so the app can't tell which transcript belongs to this process.`)
      : match === 'unknown'
        ? note(`No transcript has been found for this process yet -- which is also what a session looks like right after it launches, before its first events are written and ingested.`)
        : note(`This process's transcript can't be identified.`);
  } else if (loadFailed) {
    body = note(`This session's conversation could not be loaded. Reopening the session will try again.`);
  } else if (page === null) {
    body = note('Loading…');
  } else if (page.turns.length === 0) {
    body = note('No conversation recorded for this session.');
  }

  let prevDate = '';
  return (
    <div className="convwrap">
      <div className="conv" data-style="a" ref={scrollerRef} onScroll={handleScroll}>
        {body ?? (
          // Chat order puts the oldest loaded turn at the top, so both
          // history markers sit ABOVE turns.map: the older page a
          // loading-more spinner announces prepends at the top, and the
          // end-of-history line describes the top edge of what's loaded.
          // Only this stack -- not the notes branch above -- gets
          // margin-top:auto (ConversationView.css), which is what pins a
          // conversation shorter than the pane to the bottom.
          <div className="convstack">
            {loadingMore && <p className="conv-loading-more">Loading more…</p>}
            {!loadingMore && nextCursor === null && turns.length > 0 && (
              // A genuine end-of-history fact, not an apology -- unlike the
              // old truncation notice this replaces, nothing here is hidden;
              // older turns just have not been fetched yet, and now there
              // are none left.
              <p className="conv-end">Beginning of this session's recorded conversation.</p>
            )}
            {turns.map(t => {
              const date = formatDate(t.ts);
              const showDate = date !== prevDate;
              prevDate = date;
              return (
                <article key={t.id} className={`turn ${t.role}`}>
                  <div className="meta">
                    {t.role === 'user'
                      ? <span className="who">you</span>
                      : (
                        <span className="who">
                          <ProviderMark provider={provider} size={13} />
                          <span className="wholabel">{PROVIDER_NAME[provider]}</span>
                        </span>
                      )}
                    <span className="when">{showDate ? `${date} ${formatTime(t.ts)}` : formatTime(t.ts)}</span>
                  </div>
                  {t.role === 'user'
                    ? <p className="turn-text">{t.text}</p>
                    : (
                      <div className="turn-body">
                        <div className="turn-text md"><MarkdownText text={t.text} /></div>
                        {t.steps.length > 0 && <Steps steps={t.steps} />}
                      </div>
                    )}
                </article>
              );
            })}
          </div>
        )}
      </div>
      {missedLatest && (
        <button type="button" className="convjump" onClick={jumpToLatest}>Jump to latest</button>
      )}
      <MessageBox pid={pid} tmux={tmux} onOpenTerminal={onOpenTerminal} />
    </div>
  );
}
