import { useEffect, useRef, useState } from 'react';
import type { ConversationPage } from '../../store/conversation.ts';
import type { MatchQuality } from '../../discovery/match.ts';
import './ConversationView.css';

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

/** How close (in px) to the bottom of the scroll container counts as "close
 *  enough to fetch the next page" -- a little slack so the fetch is already
 *  in flight by the time the reader actually reaches the end, rather than
 *  starting only once they hit bottom and have to wait staring at nothing. */
const LOAD_MORE_THRESHOLD_PX = 150;

/** Newest-first layout (this task's own earlier ruling): the OLDEST loaded
 *  turn sits at the BOTTOM of the scrollable pane, not the top -- reading
 *  further back in time means scrolling DOWN. "Running low on loaded
 *  history" therefore means nearing the bottom, which is what this checks.
 *
 *  (The brief for this feature described the trigger as "scrolling near
 *  the top (older end)" -- that phrasing fits an oldest-at-bottom layout,
 *  the opposite of the newest-first one this task explicitly mandated
 *  earlier, where the top is the NEWEST end. Implemented against the
 *  actual layout rather than the literal wording; flagged in the report
 *  rather than silently reconciled.)
 *
 *  Exported as a plain function over plain numbers, rather than inlined
 *  against a live element, because jsdom does not compute real layout:
 *  scrollHeight/clientHeight are hardcoded getters there with no setter
 *  (assigning either throws) -- verified directly against this project's
 *  jsdom. Testing the threshold math this way needs no jsdom workaround at
 *  all; only the one integration test that fires a real scroll event
 *  needs Object.defineProperty to stub those two. */
export function nearOlderEdge(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx = LOAD_MORE_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < thresholdPx;
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
export function ConversationView({ sessionId, match }: { sessionId: string | null; match?: MatchQuality }) {
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A ref, not just the `loadingMore` state, guards the actual fetch:
  // scroll fires far faster than React re-renders commit, so a handler
  // that only checked state could read a stale "not loading" on two scroll
  // events back to back and fire two fetches. A ref is read and written
  // synchronously, with no render in between, so it is the guard that
  // actually holds under a real burst of scroll events, not just in a
  // test that calls the handler once.
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    if (sessionId === null) return; // nothing to fetch -- see the doc comment above.
    let alive = true;
    setPage(null);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    void window.fleet?.conversation(sessionId).then(p => {
      if (alive) setPage(p);
    });
    return () => { alive = false; };
  }, [sessionId]);

  if (sessionId === null) {
    if (match === 'ambiguous') {
      return (
        <div className="conv unknown">
          This working directory has several recorded sessions, so the app
          can't tell which transcript belongs to this process.
        </div>
      );
    }
    if (match === 'unknown') {
      return (
        <div className="conv unknown">
          No transcript has been found for this process yet -- which is also
          what a session looks like right after it launches, before its
          first events are written and ingested.
        </div>
      );
    }
    return (
      <div className="conv unknown">
        This process's transcript can't be identified.
      </div>
    );
  }

  if (page === null) return <div className="conv loading">Loading…</div>;
  const { turns, nextCursor } = page;
  if (turns.length === 0) return <div className="conv empty">No conversation recorded for this session.</div>;

  // Fetches the next OLDER page and appends it -- appends, never prepends,
  // because newest-first puts the oldest-loaded turn at the bottom, so
  // continuing the timeline further back means adding on there. That is
  // also why this needs no scroll-position bookkeeping: content added
  // below the visible viewport never moves what the reader is currently
  // looking at (the classic "jump" only happens when content is inserted
  // ABOVE the viewport, i.e. a prepend -- not the case here).
  function loadMore() {
    if (sessionId === null || nextCursor === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void window.fleet?.conversation(sessionId, nextCursor).then(next => {
      setPage(current => current === null
        ? current
        : { turns: [...current.turns, ...next.turns], nextCursor: next.nextCursor });
    }).finally(() => {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    });
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (nearOlderEdge(e.currentTarget)) loadMore();
  }

  // Newest-first, per the team-lead ruling on this task: this is a catch-up
  // review surface, not a live chat transcript, so "what happened most
  // recently" belongs at the top rather than requiring a scroll to the
  // bottom. conversationFor already returns turns in this order (ts DESC),
  // so no re-sort here -- and the date-repeat check below walks the same
  // top-to-bottom order the reader sees, newest date first.
  let prevDate = '';
  return (
    <div className="conv" onScroll={handleScroll}>
      {turns.map(t => {
        const date = formatDate(t.ts);
        const showDate = date !== prevDate;
        prevDate = date;
        return (
          <article key={t.id} className={`turn ${t.role}`}>
            <div className="meta">
              <span className="who">{t.role === 'user' ? 'you' : 'agent'}</span>
              <span className="when">{showDate ? `${date} ${formatTime(t.ts)}` : formatTime(t.ts)}</span>
            </div>
            <p className="said">{t.text}</p>
          </article>
        );
      })}
      {loadingMore && <p className="conv-loading-more">Loading more…</p>}
      {!loadingMore && nextCursor === null && (
        // A genuine end-of-history fact, not an apology -- unlike the old
        // truncation notice this replaces, nothing here is hidden; older
        // turns just have not been fetched yet, and now there are none left.
        <p className="conv-end">Beginning of this session's recorded conversation.</p>
      )}
    </div>
  );
}
