import { useEffect, useState } from 'react';
import { SessionCard } from './SessionCard.tsx';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import type { SessionState, OpenSession } from '../../fleet/state.ts';
import type { FleetListPayload } from '../../main/ipc.ts';
import './FleetView.css';

// One server-side page (src/main/ipc.ts's HISTORY_DEFAULT_LIMIT) fetched at
// a time -- expanding History fetches page one; "Show more" fetches the
// next. Never a client-side batch over an already-fetched whole array:
// David's correction to the original brief ("main should never build 878
// session objects") means there is no whole array to batch over any more.
const HISTORY_PAGE = 60;

export function FleetView() {
  // The two independent enumerations, per the model correction: "ALL OPEN
  // SESSIONS should show. And the source." Open sessions come from live
  // PROCESSES (discovery, spec S7.1a), not from transcript recency -- a
  // session opened nine days ago and never touched since is still open,
  // and process discovery, not History, is the only source that knows
  // that. History remains independently complete: every transcript
  // session, unfiltered, so nothing is ever lost even though most open
  // processes will also appear there once fetched.
  //
  // `payload` never carries anything history-related, not even a count
  // (FleetListPayload, src/main/ipc.ts) -- only openSessions. Per David's
  // correction, nothing about History is computed, sent, or held until a
  // person actually expands it: not deferred, not precomputed, not
  // sent-but-unused.
  const [payload, setPayload] = useState<FleetListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default: history is the common case (a handful of open
  // sessions, hundreds of history), and rendering history as the default
  // view is the noise this app exists to remove. See the history-group
  // block below for how "collapsed" also means "not mounted" -- and now
  // also "not fetched".
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [history, setHistory] = useState<SessionState[]>([]);
  // null until the first page of THIS expand has actually loaded -- the
  // signal that distinguishes "haven't asked yet" / "loading" from
  // "asked, and there are genuinely zero" (`total === 0`), which look
  // identical if all you have is `history.length`.
  const [historyTotal, setHistoryTotal] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

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

  // History is fetched only on the false->true transition, i.e. exactly
  // when a person actually opens the accordion -- not on every render, not
  // on every fleet:update push, and never more than page one here ("Show
  // more" below fetches subsequent pages on its own). Re-fires, from
  // scratch, each time the accordion is re-opened -- a fresh page one, not
  // whatever was left over from a previous expand.
  useEffect(() => {
    if (!window.fleet || !historyExpanded) return;
    const fleet = window.fleet;
    let alive = true;
    setHistory([]);
    setHistoryTotal(null);
    setHistoryError(null);
    void fleet.listHistory(0, HISTORY_PAGE).then(
      p => { if (alive) { setHistory(p.sessions); setHistoryTotal(p.total); } },
      err => { if (alive) setHistoryError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { alive = false; };
  }, [historyExpanded]);

  function loadMoreHistory(): void {
    if (!window.fleet) return;
    const fleet = window.fleet;
    setHistoryLoading(true);
    void fleet.listHistory(history.length, HISTORY_PAGE).then(
      p => { setHistory(h => [...h, ...p.sessions]); setHistoryTotal(p.total); setHistoryLoading(false); },
      err => { setHistoryError(err instanceof Error ? err.message : String(err)); setHistoryLoading(false); },
    );
  }

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

  // Captured once the guard above has ruled out undefined, rather than
  // re-reading window.fleet at each use below -- same reasoning as the
  // `fleet` locals captured inside the two effects above.
  const fleetApi = window.fleet;
  const openSessions: OpenSession[] = payload.openSessions;
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
          {openSessions.map(o => (
            <OpenSessionCard key={o.pid} state={o} onOpen={() => {}} onKill={fleetApi.killSession} />
          ))}
        </div>
      ) : (
        <p className="empty">No open sessions right now.</p>
      )}

      {/* Always present, collapsed by default: whether History has
          anything at all is itself something we only learn by asking, so
          -- unlike before this task -- this cannot be hidden behind a
          count. The heading shows a number only once fleet:history has
          actually answered. */}
      <h2 className="divider">
        <button
          type="button"
          className="btn history-toggle"
          aria-expanded={historyExpanded}
          aria-controls="history-group"
          onClick={() => setHistoryExpanded(v => !v)}
        >
          <span className="caret" aria-hidden="true" />
          History{historyTotal !== null && <span> {historyTotal}</span>}
        </button>
      </h2>
      {/* The wrapper always mounts so aria-controls resolves to a real
          element even while collapsed. What's conditional is the cards
          inside it: collapsed means History is never fetched at all, let
          alone constructing a component tree -- not that a fetched tree
          exists and is hidden by CSS, which would still pay the fetch
          cost and re-render on every fleet push. */}
      <div id="history-group" className="fleet dim">
        {historyExpanded && historyError && (
          <p className="empty error">History could not be loaded: {historyError}</p>
        )}
        {historyExpanded && !historyError && historyTotal === null && (
          <p className="empty">Loading history…</p>
        )}
        {historyExpanded && !historyError && historyTotal === 0 && (
          <p className="empty">No history yet.</p>
        )}
        {historyExpanded && !historyError && historyTotal !== null && historyTotal > 0 &&
          history.map(s => <SessionCard key={s.sessionId} state={s} onOpen={() => {}} />)}
      </div>
      {historyExpanded && !historyError && historyTotal !== null && history.length < historyTotal && (
        <button
          type="button"
          className="btn show-more"
          disabled={historyLoading}
          onClick={loadMoreHistory}
        >
          Show more ({historyTotal - history.length} remaining)
        </button>
      )}
    </div>
  );
}
