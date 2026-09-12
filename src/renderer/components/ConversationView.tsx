import { useEffect, useState } from 'react';
import type { ConversationTurn } from '../../store/conversation.ts';
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
 *  nothing rather than guess" rule as OpenSessionCard's lastProse. */
export function ConversationView({ sessionId }: { sessionId: string | null }) {
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
    return (
      <div className="conv unknown">
        Several open sessions share this process's working directory, so its
        transcript can't be identified.
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
