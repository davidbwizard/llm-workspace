import { useState } from 'react';
import type { OpenSession } from '../../fleet/state.ts';
import type { PaneView, Selection } from '../state/useFleet.ts';
import type { KillResult, RevealResult } from '../../main/ipc.ts';
import type { LaunchResult } from '../../main/launch.ts';
import type { SessionContext } from '../../core/usage.ts';
import { FleetView } from './FleetView.tsx';
import { SessionRail } from './SessionRail.tsx';
import { ConversationView } from './ConversationView.tsx';
import { TerminalView } from './TerminalView.tsx';
import { ContextChip } from './ContextChip.tsx';
import { abbreviateHome } from '../pathFormat.ts';
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

// Same "bridge might be gone" reasoning as killSession above, for the two
// reattach channels OpenSessionCard (via SessionRail) needs.
function reattachSession(pid: number, cols: number, rows: number): Promise<LaunchResult> {
  return window.fleet?.reattach(pid, cols, rows)
    ?? Promise.resolve({ status: 'failed', reason: 'Could not reach the app.' });
}
function resumeSession(sessionId: string, cwd: string, cols: number, rows: number): Promise<LaunchResult> {
  return window.fleet?.resume(sessionId, cwd, cols, rows)
    ?? Promise.resolve({ status: 'failed', reason: 'Could not reach the app.' });
}
// Same reasoning again, for the host label's "bring that terminal forward"
// click -- FleetView wires this for the grid; the rail needs it too.
function revealSession(pid: number): Promise<RevealResult> {
  return window.fleet?.revealSession(pid) ?? Promise.resolve({ status: 'refused', reason: 'signal_failed' });
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
  // Usage design, Part B: the conversation header's context chip. Fed by
  // ConversationView's onContext callback (its own doc comment explains why
  // a callback, not a second useSessionLive call -- main's live watch is a
  // single slot). Reset on every pid change so a reading left behind by the
  // session just departed is never shown as if it belonged to the new one;
  // NOT reset on a view change alone, since ConversationView unmounts under
  // the Terminal view and a slightly stale-but-still-correct-for-this-pid
  // reading is preferable there to blanking the chip until Conversation is
  // reopened. Declared before the early return below -- hooks must run
  // unconditionally on every render, selection===null or not.
  //
  // Reset in the render body, not a useEffect keyed on the pid (React's own
  // "adjust state when a prop changes" idiom, same as useSessionLive.ts):
  // an effect only fires after this render has already committed and
  // painted, so for one frame the previous session's reading would still
  // be on screen under the new session's title. Comparing against a
  // tracked `prevPid` and calling setState synchronously during render
  // makes React discard that stale render before it ever paints; the
  // ternary covers the one render where the setState calls have been made
  // but `liveContext`/`prevPid` themselves have not yet updated.
  const [liveContext, setLiveContext] = useState<SessionContext | null>(null);
  const [prevPid, setPrevPid] = useState<number | null>(selection?.pid ?? null);
  if ((selection?.pid ?? null) !== prevPid) {
    setPrevPid(selection?.pid ?? null);
    setLiveContext(null);
  }
  const currentLiveContext = (selection?.pid ?? null) !== prevPid ? null : liveContext;

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
  // The freshest known reading: ConversationView's own callback once it has
  // reported one for this pid, else the 5s-swept OpenSession.context --
  // same fold ConversationView performs internally against `live`, applied
  // here so the chip is not blank for however long it takes the first
  // report to arrive (mount order: this render happens before that effect
  // fires).
  const headerContext = currentLiveContext ?? session?.context ?? null;

  return (
    <div className="mainpane split">
      <SessionRail sessions={sessions} selectedPid={selection.pid} onSelect={onSelect} onKill={killSession}
        onReveal={revealSession} onReattach={reattachSession} onResume={resumeSession}
        // Task 5 (quick-answers design §9): Answer on a waiting session
        // selects this pid, then switches to the Conversation view -- the
        // same select-then-switch pairing App.tsx's own openInTerminal uses
        // for LaunchBar (see its doc comment there), just to the
        // Conversation view instead of the Terminal one, since that's
        // where the prompt card (or its waiting-card fallback) lives.
        onAnswer={pid => { onSelect(pid); onSetView('conversation'); }}
        side={railSide} />
      <section className="pane">
        <header className="panehead">
          <button type="button" className="paneback" onClick={onClear}>All sessions</button>
          {/* The rail already names the project, so this carries the thing
              the rail cannot fit: the session's full working directory
              (spec §3.7). `title` keeps the untruncated, un-abbreviated
              value reachable on hover and to assistive tech once the CSS
              ellipsis bites -- only the VISIBLE text is shortened, with
              abbreviateHome's own "~" and the CSS start-truncation below. */}
          <span className="panetitle" title={session?.cwd ?? undefined}>
            {session?.cwd ? abbreviateHome(session.cwd) : 'session'}
          </span>
          {/* Usage design, Part B: the context chip, hidden entirely (its
              own null check) until some source has a count for this
              session. */}
          <ContextChip context={headerContext} />
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
          // it rather than the misleading "no conversation recorded". `match`
          // rides along so ConversationView can say WHY sessionId is null
          // (ambiguous vs. unknown) instead of one generic claim.
          : <ConversationView sessionId={session?.sessionId ?? null} match={session?.match}
              // Falls back to 'claude' only when the selected pid has left
              // the fleet entirely -- the pane is then showing a stale
              // selection and the glyph is cosmetic.
              provider={session?.provider ?? 'claude'}
              // The refresh signal (spec §3.3). Null whenever this process
              // matches no session uniquely -- there is nothing to refresh.
              events={session?.events ?? null}
              // null once the selected pid has left the fleet -- the box is
              // then disabled with a reason rather than removed (spec §7.1).
              pid={session ? selection.pid : null}
              tmux={session?.tmux ?? false}
              // Usage design, Part B: the swept fallback and the report-
              // upward callback that keeps headerContext current -- see
              // their own doc comments on ConversationView's props.
              context={session?.context ?? null}
              onContext={setLiveContext}
              // The pid is already the selection, so this only has to flip
              // the view -- unlike the rail's Answer, which must select
              // first (see onOpenTerminal on SessionRail above).
              onOpenTerminal={() => onSetView('terminal')} />}
      </section>
    </div>
  );
}
