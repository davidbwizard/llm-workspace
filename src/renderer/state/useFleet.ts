import { useCallback, useEffect, useState } from 'react';
// FleetListPayload lives in main/ipc.ts, not fleet/state.ts -- OpenSession
// (which state.ts does export) is the payload's element type, not the
// payload itself. FleetView.tsx already imports it from here; matched for
// consistency rather than introducing a second import path for one type.
import type { FleetListPayload } from '../../main/ipc.ts';

export type PaneView = 'conversation' | 'terminal';
export type Selection = { pid: number; view: PaneView } | null;

/** One source of fleet state, consumed by every pane. The grid used to own
 *  this privately (FleetView.tsx:47-68); the Game view needs exactly the same
 *  data and the same "select this session" callback, so it lives here instead.
 *  Defaulting to 'conversation' is what keeps the raw terminal opt-in. */
export function useFleet() {
  const [payload, setPayload] = useState<FleetListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  useEffect(() => {
    let alive = true;
    const api = window.fleet;
    if (!api) { setError('bridge unavailable'); return; }
    // Two-arg .then, not a bare .then/chained .catch: FleetView's own
    // former subscription (moved here by this task) called this out
    // explicitly -- ipcRenderer.invoke rejects, rather than hanging, when
    // main has no handler for the channel, and a rejection with no handler
    // here becomes an unhandled promise rejection, not a state update:
    // `payload` stays null forever, indistinguishable on screen from a
    // slow load. A specific message says why instead.
    void api.listFleet().then(
      p => { if (alive) { setPayload(p); setError(null); } },
      err => { if (alive) setError(err instanceof Error ? err.message : String(err)); },
    );
    const unsub = api.onFleet(p => { if (alive) { setPayload(p); setError(null); } });
    return () => { alive = false; unsub(); };
  }, []);

  const select = useCallback((pid: number) => setSelection({ pid, view: 'conversation' }), []);
  const setView = useCallback((view: PaneView) => {
    setSelection(s => (s === null ? s : { ...s, view }));
  }, []);
  const clear = useCallback(() => setSelection(null), []);

  return { payload, error, selection, select, setView, clear };
}
