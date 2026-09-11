import { useEffect, useState } from 'react';
import { SessionCard } from './SessionCard.tsx';
import type { SessionState } from '../../fleet/state.ts';
import './FleetView.css';

// Lifecycle and activity are the two separate axes spec S9.2 draws
// (reachable-or-not vs. what it is doing), and the fleet view's grouping
// has to respect both rather than collapsing them into one. "Needs you
// right now" means: it's reachable (lifecycle active) AND either working
// or waiting on the user. Everything else -- an active-but-quiet session,
// and EVERY disconnected or ended session regardless of what its activity
// says -- goes below the "Idle" divider. Disconnected/ended sessions are
// unconditional here because their `activity` is LAST KNOWN, not current
// (see the Activity comment in src/fleet/state.ts): a disconnected session
// reporting `working` was working before it dropped off, not now, so it
// cannot sit in the same group as a session that is reachable and actually
// working this second.
function needsAttention(s: SessionState): boolean {
  return s.lifecycle === 'active' &&
    (s.activity === 'working' || s.activity === 'waiting_permission' || s.activity === 'waiting_input');
}

export function FleetView() {
  const [sessions, setSessions] = useState<SessionState[] | null>(null);

  useEffect(() => {
    // window.fleet is absent if the preload script failed to load (see the
    // render-time guard below). Nothing to subscribe to in that case.
    if (!window.fleet) return;
    const fleet = window.fleet;
    let alive = true;
    void fleet.listFleet().then(p => { if (alive) setSessions(p.sessions); });
    const unsub = fleet.onFleet(p => { if (alive) setSessions(p.sessions); });
    return () => { alive = false; unsub(); };
  }, []);

  // A blank window with the error only in devtools is exactly the failure
  // mode Task 5 found: a failed preload still renders a normal-looking
  // window. Say the actionable thing instead of leaving this stuck on
  // "Reading the index..." forever or throwing on the dereference above.
  if (!window.fleet) {
    return <p className="empty error">The preload script did not load, so this window
      has no connection to the session index. Restart the app; if this keeps happening,
      check the main process log for a preload error.</p>;
  }

  if (sessions === null) return <p className="empty">Reading the index…</p>;
  if (sessions.length === 0)
    return <p className="empty">No sessions indexed yet. Run a Claude Code or Codex
      session, or run <code>npm run cli -- ingest</code> to index existing transcripts.</p>;

  // Idle sessions are dimmed below a divider rather than hidden: a fleet
  // view that silently drops sessions is the failure spec S7.1a warns about.
  const live = sessions.filter(needsAttention);
  const idle = sessions.filter(s => !needsAttention(s));
  const needing = live.filter(s => s.blocker).length;

  return (
    <div className="fleetwrap">
      <header className="fleetbar">
        <h1>Fleet</h1>
        <span className="chip">{live.length} active</span>
        {needing > 0 && <span className="chip attn">{needing} need you</span>}
      </header>

      {live.length > 0 && (
        <div className="fleet">
          {live.map(s => <SessionCard key={s.sessionId} state={s} onOpen={() => {}} />)}
        </div>
      )}

      {idle.length > 0 && (
        <>
          <h2 className="divider">Idle <span>{idle.length}</span></h2>
          <div className="fleet dim">
            {idle.map(s => <SessionCard key={s.sessionId} state={s} onOpen={() => {}} />)}
          </div>
        </>
      )}
    </div>
  );
}
