import { useCallback, useEffect, useMemo, useState } from 'react';
// FleetListPayload lives in main/ipc.ts, not fleet/state.ts -- OpenSession
// (which state.ts does export) is the payload's element type, not the
// payload itself. FleetView.tsx already imports it from here; matched for
// consistency rather than introducing a second import path for one type.
import type { FleetListPayload } from '../../main/ipc.ts';
// TYPE-only from state.ts (same reasoning as SessionRail.tsx's own import of
// OpenSession -- that module reaches node:os and the database, which do not
// exist in a sandboxed renderer; a type import is erased at build and costs
// nothing). compareOpenSessions itself is order.ts's own pure, Node-free
// export -- see that file's doc comment on why the comparator was split out
// of state.ts in the first place.
import type { OpenSession } from '../../fleet/state.ts';
import { compareOpenSessions } from '../../fleet/order.ts';
// groups.ts imports nothing but react -- safe from the renderer, unlike
// fleet/state.ts, which reaches node:os and the database.
import { pruneAssignments, resolvePendingCategories } from './groups.ts';

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

  // NO LONGER what feeds Cmd+1..9 or the cards' own hotkey numbers -- David's
  // slot model ("slot 1 is always slot 1... a card moving must not move the
  // chord that reaches it") needs the rail's actual row layout (categories,
  // folder stacks, his own manual order), none of which this ranking knows
  // about; App.tsx now builds that from src/renderer/state/useRailSlots.ts
  // instead. `orderedSessions` below is otherwise unchanged and still
  // exercised directly by its own tests (tests/renderer/useFleet.test.tsx),
  // so it stays rather than being pulled out mid-task; flagged in this
  // branch's own report as a candidate for removal if nothing else comes to
  // need it.
  const [seenEvents, setSeenEvents] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    if (!payload) return;
    setSeenEvents(prev => {
      let next: Map<number, number> | null = null;
      for (const s of payload.openSessions) {
        if (s.events == null) continue;
        const shouldRecord = s.pid === selection?.pid || !prev.has(s.pid);
        if (shouldRecord && prev.get(s.pid) !== s.events) {
          if (!next) next = new Map(prev);
          next.set(s.pid, s.events);
        }
      }
      return next ?? prev;
    });
  }, [payload, selection?.pid]);

  // Category bookkeeping belongs on the fleet push, and this hook is the
  // single subscriber to fleet:update -- SessionRail is not mounted in every
  // view, and neither of these may depend on which pane is on screen.
  //
  // Resolve first, then prune: resolve only ever assigns a session id that
  // is in THIS push, so the prune below can never undo what it just did.
  useEffect(() => {
    if (!payload) return;
    const open = payload.openSessions;
    if (open.length === 0) return;
    resolvePendingCategories(open);
    pruneAssignments(
      open.map(s => s.sessionId).filter((id): id is string => id !== null && id !== ''),
    );
  }, [payload]);

  const orderedSessions = useMemo<OpenSession[]>(() => {
    if (!payload) return [];
    const sessions = payload.openSessions;
    const rankByPid = new Map(sessions.map((s, i) => [s.pid, i]));
    const isUnread = (s: OpenSession): boolean =>
      s.pid !== selection?.pid && s.events != null && s.events > (seenEvents.get(s.pid) ?? s.events);
    return [...sessions].sort(compareOpenSessions(
      s => s.junk,
      s => rankByPid.get(s.pid) ?? 0,
      () => 0, // no ties possible on the rank above (pid-unique indices)
      isUnread,
    ));
  }, [payload, seenEvents, selection?.pid]);

  return { payload, error, selection, select, setView, clear, orderedSessions };
}
