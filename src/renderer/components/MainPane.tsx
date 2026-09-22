import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { FileViewer, type ViewerFile, type ViewerMode } from './FileViewer.tsx';
import { FileLinkContext } from './FilePath.tsx';
import { abbreviateHome } from '../pathFormat.ts';
import { useFavourites, addFavourite, removeFavourite, MAX_FAVOURITES, lastSegment } from '../state/favourites.ts';
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

/** Where the side panel stops being usable, measured on the row that holds
 *  the conversation and the viewer -- NOT on the window, because the rail
 *  takes a variable amount of width and can sit on either side, so the same
 *  window gives the pane two different widths.
 *
 *  The number is the sum of the two floors, not a round guess:
 *    - The viewer needs ~360px. Below that its own header row (name, size,
 *      "Reveal in Finder", close) stops leaving room for a readable file
 *      name, and fenced code blocks -- which is most of what the app's own
 *      markdown contains -- scroll sideways on every line.
 *    - The conversation needs ~420px. Its text measure is 72ch
 *      (ConversationView.css) and its message row carries chips capped at
 *      260px plus the send control; below ~420 those start stacking.
 *    - Plus the 1px divider, and a little slack so the breakpoint is not
 *      exactly the point at which both halves are already at their floor.
 *
 *  At the app's minimum window (720px wide, src/main/index.ts) the pane is
 *  always narrower than this, so a small window always gets the sheet --
 *  which is the intended behaviour, not an accident of the number.
 *
 *  Exported so the test can assert against the same constant the component
 *  uses rather than a copy of it. */
export const SIDE_PANEL_MIN_PX = 820;

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
export function MainPane({ selection, sessions, onSelect, onSetView, onClear, railSide, cmdIndexByPid }: {
  selection: Selection;
  sessions: OpenSession[];
  onSelect: (pid: number) => void;
  onSetView: (v: PaneView) => void;
  onClear: () => void;
  railSide: 'left' | 'right';
  /** Cmd+1..9's own shared ranking (App.tsx, backed by useFleet.ts's
   *  orderedSessions) -- pid to hotkey number (1-9), for whichever open-
   *  session cards this pane renders (the grid below, or the rail further
   *  down). Optional so every existing direct render of this component
   *  (this file's own tests included) keeps working with no numbers shown,
   *  rather than every call site needing one. */
  cmdIndexByPid?: Map<number, number>;
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
  // The open file. Cleared on every pid change for the same reason
  // liveContext is: a document opened out of one session's folder must never
  // stay on screen under another session's title. Declared here, above the
  // reset block, because that block calls its setter during render.
  const [viewer, setViewer] = useState<ViewerFile | null>(null);
  const [prevPid, setPrevPid] = useState<number | null>(selection?.pid ?? null);
  if ((selection?.pid ?? null) !== prevPid) {
    setPrevPid(selection?.pid ?? null);
    setLiveContext(null);
    setViewer(null);
  }
  const currentLiveContext = (selection?.pid ?? null) !== prevPid ? null : liveContext;

  const currentViewer = (selection?.pid ?? null) !== prevPid ? null : viewer;

  // The pane chooses the placement by width, with no setting -- see
  // SIDE_PANEL_MIN_PX above. Measured on the element rather than assumed
  // from the window, and re-measured on every resize of it (the rail is
  // draggable, so this changes without the window changing at all).
  // A callback ref, not useRef: the element only exists in the split branch
  // below, so an effect keyed on a ref would never see it appear.
  const [paneBody, setPaneBody] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (!paneBody) return;
    const measure = () => {
      const w = paneBody.getBoundingClientRect().width;
      // A zero width means "not laid out yet", not "narrow" -- acting on it
      // would flash the sheet open on every mount.
      if (w > 0) setWide(w >= SIDE_PANEL_MIN_PX);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      // No ResizeObserver (jsdom): the window is still a signal, just a
      // coarser one. The app's real runtime always has the observer.
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(paneBody);
    return () => observer.disconnect();
  }, [paneBody]);
  const viewerMode: ViewerMode = wide ? 'side' : 'sheet';

  // A click on a path in the conversation. The renderer's entire
  // contribution is this string: main (src/main/files.ts) resolves it
  // against the session's own folder -- which it looks up itself, by pid --
  // and decides whether it is read, revealed, or refused. A refusal other
  // than "too large" is deliberately silent here: main has already logged
  // it, and the path is one an agent wrote, not one the person typed.
  const openFile = useCallback(async (candidate: string, reveal?: boolean) => {
    const pid = selection?.pid;
    const api = window.fleet;
    if (pid === undefined || !api?.fileOpen) return;
    try {
      const result = await api.fileOpen(pid, candidate, reveal);
      if (result.ok && result.action === 'markdown') {
        setViewer({ kind: 'file', candidate, name: result.name, size: result.size, path: result.path, text: result.text });
      } else if (!result.ok && result.reason === 'too_large') {
        setViewer({ kind: 'too_large', candidate, name: result.name ?? candidate, size: result.size ?? 0 });
      } else if (!result.ok && result.reason === 'permission_denied') {
        // The one other refusal the viewer SHOWS rather than swallows. A
        // denied read is not a broken link: the file is there and the app
        // simply has not been granted the folder (macOS gates ~/Documents,
        // ~/Desktop and ~/Downloads per application). Saying nothing here
        // would leave someone clicking a path that quietly does nothing.
        setViewer({
          kind: 'no_permission', candidate,
          name: result.name ?? candidate, size: result.size ?? 0, path: result.path,
        });
      }
      // 'revealed': Finder is already in front, and there is nothing for
      // this pane to show.
    } catch (err) {
      console.error('session:file:open failed:', err);
    }
  }, [selection?.pid]);

  // Memoised: a fresh object here would re-render every path control in
  // the conversation on every render of this pane, which is most of them.
  const pid = selection?.pid ?? null;
  const hasSession = sessions.some(s => s.pid === pid);
  const fileLink = useMemo(
    () => (pid !== null && hasSession ? { pid, onOpen: (c: string) => { void openFile(c); } } : null),
    [pid, hasSession, openFile],
  );

  // Favourite folders' header star (shared with LaunchBar and
  // OpenSessionCard's own menu item via state/favourites.ts's single
  // store) -- called unconditionally, before the no-selection early return
  // below, per the Rules of Hooks; only actually rendered in the split
  // view further down.
  const favourites = useFavourites();

  if (selection === null) {
    return (
      <div className="mainpane">
        <FleetView
          payload={{ version: 1, generatedAt: new Date().toISOString(), openSessions: sessions }}
          error={null}
          onSelect={onSelect}
          cmdIndexByPid={cmdIndexByPid}
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

  const paneCwd = session?.cwd ?? null;
  const paneFavName = paneCwd ? lastSegment(paneCwd) : null;
  const isPaneFav = paneCwd !== null && favourites.includes(paneCwd);
  const paneFavFull = !isPaneFav && favourites.length >= MAX_FAVOURITES;

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
        side={railSide} cmdIndexByPid={cmdIndexByPid} />
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
          {/* Favourite folders: the same star as LaunchBar's, on the same
              shared store (state/favourites.ts) -- adding or removing here
              shows up as a chip under the launch bar with no reload. `flex:
              none` in MainPane.css, same as every other control in this row:
              .panetitle above is the only one that ever shrinks. Disabled
              with no cwd at all (nothing to favourite) for this session. */}
          <button type="button" className="panefav"
            aria-label={paneFavName === null ? 'Add to favourites'
              : isPaneFav ? `Remove ${paneFavName} from favourites` : `Add ${paneFavName} to favourites`}
            aria-pressed={isPaneFav} disabled={paneCwd === null || paneFavFull}
            title={paneFavFull ? `You can save up to ${MAX_FAVOURITES} favourites.` : undefined}
            onClick={() => {
              if (paneCwd === null) return;
              if (isPaneFav) removeFavourite(paneCwd); else addFavourite(paneCwd);
            }}>
            <span aria-hidden="true">{isPaneFav ? '★' : '☆'}</span>
          </button>
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
        {/* The row the conversation and the side panel share, and the
            element the placement is measured on. position:relative
            (MainPane.css) is what the sheet's scrim is positioned against,
            so the sheet covers the conversation rather than the whole
            window. */}
        <div className="panebody" ref={setPaneBody}>
        {selection.view === 'terminal'
          ? <TerminalView pid={selection.pid} />
          // sessionId is `string | null` -- NOT coerced to '' here. Null is
          // the common case on a real workspace (many sessions can share one
          // cwd, which makes the match ambiguous), not an edge case, and
          // ConversationView already renders a distinct, honest message for
          // it rather than the misleading "no conversation recorded". `match`
          // rides along so ConversationView can say WHY sessionId is null
          // (ambiguous vs. unknown) instead of one generic claim.
          // The conversation's paths become clickable only when there is a
          // live pid to resolve them against -- FilePath.tsx renders every
          // path as plain text with a null context, which is exactly what
          // a stale selection should do.
          : <FileLinkContext.Provider value={fileLink}>
            <ConversationView sessionId={session?.sessionId ?? null} match={session?.match}
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
              onOpenTerminal={() => onSetView('terminal')} />
          </FileLinkContext.Provider>}
        {/* Only under the Conversation view: the viewer is opened from a
            path in a reply, and a sheet floating over a live terminal
            would cover the thing being typed into. Switching back to
            Conversation brings it straight back. */}
        {currentViewer && selection.view === 'conversation' && (
          <FileViewer
            file={currentViewer}
            mode={viewerMode}
            onClose={() => setViewer(null)}
            // The same candidate the click proposed goes back to main,
            // which re-runs every check on it. Nothing the renderer has
            // held on to is treated as already-validated.
            onReveal={() => { void openFile(currentViewer.candidate, true); }}
          />
        )}
        </div>
      </section>
    </div>
  );
}
