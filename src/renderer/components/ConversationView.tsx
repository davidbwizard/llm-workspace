import { useEffect, useState } from 'react';
import { CONVERSATION_LIMIT } from '../../store/conversation.ts';
import type { Conversation } from '../../store/conversation.ts';
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
  const [conversation, setConversation] = useState<Conversation | null>(null);

  useEffect(() => {
    if (sessionId === null) return; // nothing to fetch -- see the doc comment above.
    let alive = true;
    setConversation(null);
    void window.fleet?.conversation(sessionId).then(c => {
      if (alive) setConversation(c);
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

  if (conversation === null) return <div className="conv loading">Loading…</div>;
  const { turns, truncated } = conversation;
  if (turns.length === 0) return <div className="conv empty">No conversation recorded for this session.</div>;

  // Newest-first, per the team-lead ruling on this task: this is a catch-up
  // review surface, not a live chat transcript, so "what happened most
  // recently" belongs at the top rather than requiring a scroll to the
  // bottom. conversationFor already returns turns in this order (ts DESC),
  // so no re-sort here -- and the date-repeat check below walks the same
  // top-to-bottom order the reader sees, newest date first.
  let prevDate = '';
  return (
    <div className="conv">
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
      {truncated && (
        // Sits after the oldest turn shown, i.e. right at the point the cap
        // cut the session off -- silently dropping the rest is the exact bug
        // this notice exists to prevent.
        <p className="conv-truncated">
          Older turns aren't shown -- only the most recent {CONVERSATION_LIMIT} are loaded.
        </p>
      )}
    </div>
  );
}
