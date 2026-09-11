import { useEffect, useState } from 'react';
import { SessionCard } from './SessionCard.tsx';
import type { SessionState } from '../../fleet/state.ts';
import './FleetView.css';

// Lifecycle and activity are the two separate axes spec S9.2 draws
// (reachable-or-not vs. what it is doing), and the fleet view's grouping
// has to respect both rather than collapsing them into one. "Needs you
// right now" means: it's reachable (lifecycle active) AND either working
// or waiting on the user. Unchanged by the three-way split below --
// everything in this group is still governed only by lifecycle/activity,
// not by process liveness. Disconnected/ended sessions are unconditional
// here because their `activity` is LAST KNOWN, not current (see the
// Activity comment in src/fleet/state.ts): a disconnected session
// reporting `working` was working before it dropped off, not now, so it
// cannot sit in the same group as a session that is reachable and actually
// working this second.
function needsAttention(s: SessionState): boolean {
  return s.lifecycle === 'active' &&
    (s.activity === 'working' || s.activity === 'waiting_permission' || s.activity === 'waiting_input');
}

// The middle tier: reachable (lifecycle active), same as needsAttention,
// but at a turn boundary rather than working or blocked. Deliberately keyed
// on transcript recency (lifecycle/activity), NOT on `alive` (process
// liveness, discovery -- spec S7.1a): `cwd` resolves to a directory, not a
// specific session, so whenever more than one session shares a repo --
// the common case on a real workspace -- a single live process there makes
// EVERY session sharing that cwd report `alive: true`, which used to put
// all of them here regardless of whether they were actually in use (see
// src/fleet/state.ts's `alive` doc comment). Transcript recency has no such
// ambiguity: it is measured per session, from that session's own events.
// Checked after needsAttention, so a blocked-or-working session is never
// double-counted here.
function waitingForYou(s: SessionState): boolean {
  return !needsAttention(s) && s.lifecycle === 'active';
}

// History cards render in batches once the group is opened: against a real
// index the history group is in the hundreds, and mounting all of them the
// moment the group expands just moves the "873 components on screen"
// problem one click later. 60 is a starting point, not a tuned constant.
const HISTORY_BATCH = 60;

export function FleetView() {
  const [sessions, setSessions] = useState<SessionState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default: history is the common case (a handful of live
  // sessions, hundreds of history), and rendering history as the default
  // view is the noise this app exists to remove. See the history-group
  // block below for how "collapsed" also means "not mounted."
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyShown, setHistoryShown] = useState(HISTORY_BATCH);

  useEffect(() => {
    // window.fleet is absent if the preload script failed to load (see the
    // render-time guard below). Nothing to subscribe to in that case.
    if (!window.fleet) return;
    const fleet = window.fleet;
    let alive = true;
    // Two-arg .then, not a chained .catch: a chained .catch would also
    // swallow a bug thrown from the fulfilled branch below, which is a
    // different failure than "the IPC call failed" and shouldn't be
    // reported as one. `ipcRenderer.invoke` rejects (not hangs) when main
    // has no handler for the channel -- e.g. right now, since Task 11
    // hasn't wired `registerIpc` into src/main/index.ts yet -- and an
    // unhandled rejection here previously left `sessions` null forever,
    // which looks identical on screen to a slow load. Nobody investigates
    // a spinner that never resolves; a specific message says why.
    void fleet.listFleet().then(
      p => { if (alive) { setSessions(p.sessions); setError(null); } },
      err => { if (alive) setError(err instanceof Error ? err.message : String(err)); },
    );
    const unsub = fleet.onFleet(p => { if (alive) { setSessions(p.sessions); setError(null); } });
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

  if (error) {
    return <p className="empty error">The session index could not be loaded: {error}</p>;
  }

  if (sessions === null) return <p className="empty">Reading the index…</p>;
  if (sessions.length === 0)
    return <p className="empty">No sessions indexed yet. Run a Claude Code or Codex
      session, or run <code>npm run cli -- ingest</code> to index existing transcripts.</p>;

  // Three tiers, not two: transcript recency (lifecycle/activity) is what
  // separates a session the user can act on right now from one that is
  // pure history, and lumping them together is exactly the complaint this
  // split fixes. `history` is "everything not in the other two" rather
  // than its own positive check, so no session is silently dropped -- a
  // fleet view that does that is the failure spec S7.1a warns about.
  const live = sessions.filter(needsAttention);
  const waiting = sessions.filter(waitingForYou);
  const history = sessions.filter(s => !needsAttention(s) && !waitingForYou(s));
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

      {waiting.length > 0 && (
        <>
          <h2 className="divider">Waiting for you <span>{waiting.length}</span></h2>
          {/* No .dim: unlike history, this tier is always shown, never
              collapsed -- its last transcript event is still within the
              active window (spec S9.2), even though there's nothing to
              act on right now. */}
          <div className="fleet waiting">
            {waiting.map(s =>
              <SessionCard key={s.sessionId} state={s} onOpen={() => {}} showProcessMeta />)}
          </div>
        </>
      )}

      {history.length > 0 && (
        <>
          <h2 className="divider">
            <button
              type="button"
              className="btn history-toggle"
              aria-expanded={historyExpanded}
              aria-controls="history-group"
              onClick={() => setHistoryExpanded(v => !v)}
            >
              <span className="caret" aria-hidden="true" />
              History <span>{history.length}</span>
            </button>
          </h2>
          {/* The wrapper always mounts so aria-controls resolves to a real
              element even while collapsed. What's conditional is the cards
              inside it: collapsed means the 873-ish history sessions never
              construct a component tree at all, not that one exists and is
              hidden by CSS -- a hidden tree still re-renders on every fleet
              push, which is the actual cost this is avoiding. */}
          <div id="history-group" className="fleet dim">
            {historyExpanded && history.slice(0, historyShown).map(s =>
              <SessionCard key={s.sessionId} state={s} onOpen={() => {}} />)}
          </div>
          {historyExpanded && historyShown < history.length && (
            <button
              type="button"
              className="btn show-more"
              onClick={() => setHistoryShown(n => Math.min(n + HISTORY_BATCH, history.length))}
            >
              Show more ({history.length - historyShown} remaining)
            </button>
          )}
        </>
      )}
    </div>
  );
}
