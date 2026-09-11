import { useEffect, useState } from 'react';
import { SessionCard } from './SessionCard.tsx';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import type { SessionState, OpenSession } from '../../fleet/state.ts';
import type { FleetPayload } from '../../main/ipc.ts';
import './FleetView.css';

// History cards render in batches once the group is opened: against a real
// index the history group is in the hundreds, and mounting all of them the
// moment the group expands just moves the "873 components on screen"
// problem one click later. 60 is a starting point, not a tuned constant.
const HISTORY_BATCH = 60;

export function FleetView() {
  // The two independent enumerations, per the model correction: "ALL OPEN
  // SESSIONS should show. And the source." Open sessions come from live
  // PROCESSES (discovery, spec S7.1a), not from transcript recency -- a
  // session opened nine days ago and never touched since is still open,
  // and process discovery, not `sessions`, is the only source that knows
  // that. `sessions` (transcripts) remains independently complete: History
  // below is every transcript session, unfiltered, so nothing is ever
  // lost even though most open processes will also appear there.
  const [payload, setPayload] = useState<FleetPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default: history is the common case (a handful of open
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
      p => { if (alive) { setPayload(p); setError(null); } },
      err => { if (alive) setError(err instanceof Error ? err.message : String(err)); },
    );
    const unsub = fleet.onFleet(p => { if (alive) { setPayload(p); setError(null); } });
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

  if (payload === null) return <p className="empty">Reading the index…</p>;
  // Both empty, not just `sessions`: a process can be open before its
  // first transcript event is ingested (a brief window, but a real one --
  // spec S7.1a's "never lost" promise has to hold from the moment a
  // process starts, not from its first indexed event). Checking `sessions`
  // alone would hide a genuinely open session behind this message.
  if (payload.sessions.length === 0 && payload.openSessions.length === 0)
    return <p className="empty">No sessions indexed yet. Run a Claude Code or Codex
      session, or run <code>npm run cli -- ingest</code> to index existing transcripts.</p>;

  const sessions: SessionState[] = payload.sessions;
  const openSessions: OpenSession[] = payload.openSessions;
  // History is every transcript session, full stop -- not filtered by
  // lifecycle, and NOT filtered against openSessions either. The same
  // session legitimately appears in both: an open card answers "this is
  // running right now"; a History entry answers "this conversation
  // exists". Confirmed intentional (David's model correction, relayed by
  // the team lead): "the duplication you identified is intentional... The
  // same session legitimately appears in both, and subtracting one from
  // the other would require precisely the attribution we do not have -- so
  // attempting it would reintroduce the cwd-matching bug that caused this
  // whole rework." Do not attempt to de-duplicate.
  const history = sessions;
  const needing = openSessions.filter(
    o => o.activity === 'waiting_permission' || o.activity === 'waiting_input').length;

  return (
    <div className="fleetwrap">
      <header className="fleetbar">
        <h1>Fleet</h1>
        <span className="chip">{openSessions.length} open</span>
        {needing > 0 && <span className="chip attn">{needing} need you</span>}
      </header>

      {openSessions.length > 0 ? (
        <div className="fleet">
          {openSessions.map(o => <OpenSessionCard key={o.pid} state={o} onOpen={() => {}} />)}
        </div>
      ) : (
        <p className="empty">No open sessions right now.</p>
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
