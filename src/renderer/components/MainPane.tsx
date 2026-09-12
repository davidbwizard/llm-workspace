import type { OpenSession } from '../../fleet/state.ts';
import type { PaneView, Selection } from '../state/useFleet.ts';
import type { KillResult } from '../../main/ipc.ts';
import { FleetView } from './FleetView.tsx';
import { SessionRail } from './SessionRail.tsx';
import { ConversationView } from './ConversationView.tsx';
import { TerminalView } from './TerminalView.tsx';
import './MainPane.css';

/** Falls back to a closed refusal rather than throwing when the bridge is
 *  unavailable -- OpenSessionCard's onKill contract always resolves to a
 *  KillResult, never rejects (its own doc comment), and this keeps that true
 *  even in the one case main.tsx's preload guard doesn't cover here: App.tsx
 *  only mounts MainPane once window.fleet has already answered fleet:list
 *  successfully, but the bridge disappearing between then and a Close click
 *  is not something to assume can't happen. */
function killSession(pid: number): Promise<KillResult> {
  return window.fleet?.killSession(pid) ?? Promise.resolve({ status: 'refused', reason: 'signal_failed' });
}

/** The pluggable pane. Fleet and the session views today; Graph (Phase 4) and
 *  Game (spec section 14) are additional cases here, not rewrites -- which is
 *  why the grid is one branch rather than the frame everything hangs off.
 *
 *  Deliberately takes `sessions: OpenSession[]`, not the raw fleet payload/
 *  error -- App.tsx owns the "is the index even loaded yet" gate (bridge
 *  missing, still loading, load failed) and only ever mounts this once that
 *  has already resolved, the same way it always gated FleetView before this
 *  task. Wrapping `sessions` back into a payload for FleetView below is
 *  therefore never lossy: by the time this file runs, that payload IS just
 *  these sessions. */
export function MainPane({ selection, sessions, onSelect, onSetView, onClear, railSide }: {
  selection: Selection;
  sessions: OpenSession[];
  onSelect: (pid: number) => void;
  onSetView: (v: PaneView) => void;
  onClear: () => void;
  railSide: 'left' | 'right';
}) {
  if (selection === null) {
    return (
      <div className="mainpane">
        <FleetView
          payload={{ version: 1, generatedAt: new Date().toISOString(), openSessions: sessions }}
          error={null}
          onSelect={onSelect}
        />
      </div>
    );
  }

  const session = sessions.find(s => s.pid === selection.pid) ?? null;

  return (
    <div className="mainpane split">
      <SessionRail sessions={sessions} selectedPid={selection.pid} onSelect={onSelect} onKill={killSession} side={railSide} />
      <section className="pane">
        <header className="panehead">
          <button type="button" className="paneback" onClick={onClear}>All sessions</button>
          <span className="panetitle">{session?.project ?? 'session'}</span>
          <span className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={selection.view === 'conversation'}
              onClick={() => onSetView('conversation')}>Conversation</button>
            <button type="button" aria-pressed={selection.view === 'terminal'}
              onClick={() => onSetView('terminal')}>Terminal</button>
          </span>
        </header>
        {selection.view === 'terminal'
          ? <TerminalView pid={selection.pid} />
          // sessionId is `string | null` -- NOT coerced to '' here. Null is
          // the common case on a real workspace (many sessions can share one
          // cwd, which makes the match ambiguous), not an edge case, and
          // ConversationView already renders a distinct, honest message for
          // it rather than the misleading "no conversation recorded".
          : <ConversationView sessionId={session?.sessionId ?? null} />}
      </section>
    </div>
  );
}
