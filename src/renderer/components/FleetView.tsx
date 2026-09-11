import { useEffect, useState } from 'react';
import { SessionCard } from './SessionCard.tsx';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import type { SessionState, OpenSession } from '../../fleet/state.ts';
import type { FleetListPayload } from '../../main/ipc.ts';
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
  // and process discovery, not History, is the only source that knows
  // that. History remains independently complete: every transcript
  // session, unfiltered, so nothing is ever lost even though most open
  // processes will also appear there once fetched.
  //
  // `payload` never carries the history array itself (FleetListPayload,
  // src/main/ipc.ts) -- only openSessions and a count. The full session
  // list is fetched separately, via fleet:history, only once History is
  // actually expanded (see the effect below): that is the whole point of
  // this split -- a list nobody has opened should cost nothing to answer.
  const [payload, setPayload] = useState<FleetListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default: history is the common case (a handful of open
  // sessions, hundreds of history), and rendering history as the default
  // view is the noise this app exists to remove. See the history-group
  // block below for how "collapsed" also means "not mounted" -- and now
  // also "not fetched".
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyShown, setHistoryShown] = useState(HISTORY_BATCH);
  const [history, setHistory] = useState<SessionState[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

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
  // when a person actually opens the accordion -- not on every render, and
  // not on every fleet:update push (which would reintroduce the very cost
  // this split exists to avoid, just moved one click later). Re-fires each
  // time the accordion is re-opened, so a re-expand after some time picks
  // up whatever has changed since.
  useEffect(() => {
    if (!window.fleet || !historyExpanded) return;
    const fleet = window.fleet;
    let alive = true;
    setHistoryError(null);
    void fleet.listHistory().then(
      p => { if (alive) { setHistory(p.sessions); setHistoryError(null); } },
      err => { if (alive) setHistoryError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { alive = false; };
  }, [historyExpanded]);

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
  // Both empty, not just `historyCount`: a process can be open before its
  // first transcript event is ingested (a brief window, but a real one --
  // spec S7.1a's "never lost" promise has to hold from the moment a
  // process starts, not from its first indexed event). Checking
  // `historyCount` alone would hide a genuinely open session behind this
  // message.
  if (payload.historyCount === 0 && payload.openSessions.length === 0)
    return <p className="empty">No sessions indexed yet. Run a Claude Code or Codex
      session, or run <code>npm run cli -- ingest</code> to index existing transcripts.</p>;

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
          {openSessions.map(o => <OpenSessionCard key={o.pid} state={o} onOpen={() => {}} />)}
        </div>
      ) : (
        <p className="empty">No open sessions right now.</p>
      )}

      {payload.historyCount > 0 && (
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
              History <span>{payload.historyCount}</span>
            </button>
          </h2>
          {/* The wrapper always mounts so aria-controls resolves to a real
              element even while collapsed. What's conditional is the cards
              inside it: collapsed means History is never fetched at all,
              let alone constructing a component tree -- not that a fetched
              tree exists and is hidden by CSS, which would still pay the
              fetch cost and re-render on every fleet push. */}
          <div id="history-group" className="fleet dim">
            {historyExpanded && historyError && (
              <p className="empty error">History could not be loaded: {historyError}</p>
            )}
            {historyExpanded && !historyError && history === null && (
              <p className="empty">Loading history…</p>
            )}
            {historyExpanded && !historyError && history !== null &&
              history.slice(0, historyShown).map(s =>
                <SessionCard key={s.sessionId} state={s} onOpen={() => {}} />)}
          </div>
          {historyExpanded && history !== null && historyShown < history.length && (
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
