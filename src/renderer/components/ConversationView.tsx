import { useEffect, useState } from 'react';
import type { ConversationTurn } from '../../store/conversation.ts';
import type { MatchQuality } from '../../discovery/match.ts';
import './ConversationView.css';

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
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);

  useEffect(() => {
    if (sessionId === null) return; // nothing to fetch -- see the doc comment above.
    let alive = true;
    setTurns(null);
    void window.fleet?.conversation(sessionId).then(t => {
      if (alive) setTurns(t);
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

  if (turns === null) return <div className="conv loading">Loading…</div>;
  if (turns.length === 0) return <div className="conv empty">No conversation recorded for this session.</div>;

  return (
    <div className="conv">
      {turns.map(t => (
        <article key={t.id} className={`turn ${t.role}`}>
          <span className="who">{t.role === 'user' ? 'you' : 'agent'}</span>
          <p className="said">{t.text}</p>
        </article>
      ))}
    </div>
  );
}
