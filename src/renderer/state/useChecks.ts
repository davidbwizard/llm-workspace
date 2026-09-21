// The dependency checks, as the renderer sees them.
//
// Design: docs/superpowers/specs/2026-09-21-first-run-checks-design.md §3-§5.
//
// All of the deciding happens in main (src/main/checks.ts). This hook does
// three things and nothing else: read the cached sweep on mount, listen for
// the startup sweep landing, and re-run on demand. Keeping it this thin is
// what lets the presentation be replaced without touching any probe logic --
// a different screen calls the same hook and renders the same Readiness.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Readiness } from '../../main/checks.ts';

export type ChecksStatus = 'loading' | 'running' | 'ready' | 'unavailable';

export interface ChecksView {
  status: ChecksStatus;
  /** The last completed sweep. Null until one has finished. */
  readiness: Readiness | null;
  /** Check again (design §5): re-runs without a restart, so a person can
   *  fix something in a terminal and carry on. */
  recheck: () => void;
  /** True while a recheck this component asked for is in flight. */
  rechecking: boolean;
}

export function useChecks(): ChecksView {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [status, setStatus] = useState<ChecksStatus>('loading');
  const [rechecking, setRechecking] = useState(false);
  // Every async setState below is guarded on this, so a resolve that lands
  // after unmount updates nothing.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const api = window.fleet;
    // Guarded on the specific method, not just `api`: several tests
    // elsewhere in this app stub window.fleet with only the methods they
    // exercise, and this hook mounts inside them. Calling an absent
    // checksGet would throw and take an unrelated test's render down.
    if (!api?.checksGet) { setStatus('unavailable'); return; }

    // Two-arg .then, not a chained .catch: ipcRenderer.invoke REJECTS when
    // main has no handler, and an unhandled rejection here would leave the
    // panel stuck on "checking" with nothing to say why.
    void api.checksGet().then(
      r => {
        if (!alive.current) return;
        if (r.status === 'ready') { setReadiness(r.readiness); setStatus('ready'); }
        // Still running: the push below is what finishes the story. A full
        // sweep is ~11s (codex doctor), so this is the normal state for the
        // first few seconds of a launch, not an error.
        else setStatus('running');
      },
      () => { if (alive.current) setStatus('unavailable'); },
    );

    if (!api.onChecks) return;
    return api.onChecks(next => {
      if (!alive.current) return;
      setReadiness(next);
      setStatus('ready');
    });
  }, []);

  const recheck = useCallback(() => {
    const api = window.fleet;
    if (!api?.checksRun) return;
    setRechecking(true);
    setStatus('running');
    void api.checksRun().then(
      next => {
        if (!alive.current) return;
        setRechecking(false);
        // A null result means main could not probe at all. Whatever was
        // last known stays on screen rather than being blanked -- a stale
        // true answer beats no answer -- but the status says it failed, so
        // nothing on screen claims to be fresh.
        if (next) { setReadiness(next); setStatus('ready'); }
        else setStatus('unavailable');
      },
      () => {
        if (!alive.current) return;
        setRechecking(false);
        setStatus('unavailable');
      },
    );
  }, []);

  return { status, readiness, recheck, rechecking };
}
