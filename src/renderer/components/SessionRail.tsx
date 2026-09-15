import { useEffect, useState } from 'react';
import { compareOpenSessions, type OpenSession } from '../../fleet/state.ts';
import type { KillResult } from '../../main/ipc.ts';
import type { LaunchResult } from '../../main/launch.ts';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import { ReplyPopover } from './ReplyPopover.tsx';
import './SessionRail.css';

// Sensible bounds for a drag-resized rail: narrow enough to reclaim real
// space for the main pane, but never so narrow a card's own content (the
// Close/Reattach buttons, the project name) becomes unreadable or
// unclickable; never so wide it can swallow the pane, which has no minimum
// width of its own to defend itself with (MainPane.css's .pane is
// flex:1 min-width:0 -- it will shrink to nothing before the rail is
// stopped by anything but this cap).
const RAIL_MIN_WIDTH = 140;
const RAIL_MAX_WIDTH = 420;
const RAIL_DEFAULT_WIDTH = 180; // unchanged from the rail's old fixed width
// How far one arrow-key press moves the handle -- a keyboard-only user
// still needs many presses to span the min/max range, not one.
const RAIL_KEY_STEP = 12;
// A per-viewer UI preference (localStorage, not the store/db -- nothing
// here is fleet state), namespaced like this app's tmux session names
// ('llmws-<provider>-...') so it can't collide with some other key an
// unrelated part of the app might someday store on this same origin.
const RAIL_WIDTH_STORAGE_KEY = 'llmws:rail-width';

function clampRailWidth(w: number): number {
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, w));
}

/** Reads the persisted width, if any. Wrapped in try/catch -- same
 *  reasoning as every other "bridge might not be there" guard in this app
 *  (e.g. MainPane.tsx's killSession): localStorage can throw in a locked-
 *  down webview/private-mode context, and a UI preference is never worth
 *  taking the component down over. */
function readStoredRailWidth(): number | null {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampRailWidth(n) : null;
  } catch {
    return null;
  }
}

function writeStoredRailWidth(w: number): void {
  try { localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(w)); } catch { /* best-effort only */ }
}

/** The card grid, collapsed to one column. Deliberately reuses
 *  OpenSessionCard rather than a slimmer variant: the whole point is that the
 *  fleet stays readable while you work in one session, which means the cards
 *  keep their content and their attention state.
 *
 *  onKill is now a real prop (Task 12 ruling): a Close button reachable in
 *  the live UI that always answers `already_gone` lies to the user, which is
 *  worse than no button at all -- the stub was acceptable only while this
 *  component was unmounted (Task 8). The caller (MainPane) passes the real
 *  window.fleet.killSession through.
 *
 *  Also opens the reply popover for whichever card is currently waiting on
 *  you -- spec: "click shows the prompt". This is a SEPARATE trigger from
 *  the card's own onOpen (which still just selects it, per the existing,
 *  already-reviewed "reports the pid when a card is chosen" test): opening a
 *  waiting session's popover must never be confused with switching the main
 *  pane to it, since the entire point is answering it WITHOUT losing your
 *  place. ReplyPopover itself stays untouched -- keyed by pid, no rail-shaped
 *  prop -- this component owns only the "which pid, if any" state and the
 *  anchoring markup around it. */
export function SessionRail({ sessions, selectedPid, onSelect, onKill, onReattach, onResume, side }: {
  sessions: OpenSession[];
  selectedPid: number | null;
  onSelect: (pid: number) => void;
  onKill: (pid: number) => Promise<KillResult>;
  onReattach: (pid: number, cols: number, rows: number) => Promise<LaunchResult>;
  onResume: (sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>;
  side: 'left' | 'right';
}) {
  const [replyPid, setReplyPid] = useState<number | null>(null);

  const [width, setWidth] = useState<number>(() => readStoredRailWidth() ?? RAIL_DEFAULT_WIDTH);
  useEffect(() => { writeStoredRailWidth(width); }, [width]);

  // Unread tracking: `events` is the one counter OpenSession always grows
  // monotonically as new agent output arrives for a uniquely-matched
  // session (see fleet/state.ts's own doc comment on OpenSession --
  // lastProse/events/activity are enrichment attached together, so events
  // changing is exactly as reliable a "something new happened" signal as
  // lastProse changing, and simpler to compare). Keyed by pid, in memory
  // only for this run of the app -- it resets on restart, same as every
  // other piece of "what have I already looked at" state this component
  // owns (replyPid above).
  //
  // A pid's baseline is set the first time this component ever sees it
  // (so a card's PRE-EXISTING event count is never reported as new -- only
  // events that arrive while the rail is actually watching), and again
  // every time that pid IS the current selection (so working in a session
  // never causes it to light itself up the moment you look away).
  const [seenEvents, setSeenEvents] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    setSeenEvents(prev => {
      let next: Map<number, number> | null = null;
      for (const s of sessions) {
        if (s.events == null) continue;
        const shouldRecord = s.pid === selectedPid || !prev.has(s.pid);
        if (shouldRecord && prev.get(s.pid) !== s.events) {
          if (!next) next = new Map(prev);
          next.set(s.pid, s.events);
        }
      }
      return next ?? prev;
    });
  }, [sessions, selectedPid]);

  // The handle sits on the rail's INNER edge (the border shared with the
  // main pane) -- which side that is depends on `side`, so both the drag
  // math and the arrow-key direction below are mirrored for 'right'.
  function onHandleMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    function onMove(ev: MouseEvent): void {
      const dx = ev.clientX - startX;
      setWidth(clampRailWidth(startWidth + (side === 'left' ? dx : -dx)));
    }
    function onUp(): void {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onHandleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const growKey = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrinkKey = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === growKey) { e.preventDefault(); setWidth(w => clampRailWidth(w + RAIL_KEY_STEP)); }
    else if (e.key === shrinkKey) { e.preventDefault(); setWidth(w => clampRailWidth(w - RAIL_KEY_STEP)); }
  }

  const handle = (
    <div
      className="railhandle"
      role="separator"
      aria-orientation="vertical"
      // State in the accessible name, same standard as OpenSessionCard's
      // own aria-label -- a screen-reader user learns the current width
      // from the name itself, not just from aria-valuenow (which many
      // screen readers do announce for role="separator", but the name is
      // what's guaranteed to be read).
      aria-label={`Resize open sessions rail, ${width} pixels wide`}
      aria-valuenow={width}
      aria-valuemin={RAIL_MIN_WIDTH}
      aria-valuemax={RAIL_MAX_WIDTH}
      tabIndex={0}
      onMouseDown={onHandleMouseDown}
      onKeyDown={onHandleKeyDown}
    />
  );

  // Unread is a per-viewer fact (has David actually looked at this card
  // yet) that only this component tracks -- src/fleet/state.ts's own
  // relevance sort (openSessions/openSessionsLive, run in the main
  // process before `sessions` ever reaches here) has no visibility into
  // it and so cannot rank by it. This layers that tier in on top of the
  // order already baked into `sessions` (blocked first, then recency,
  // junk last) by reusing the SAME comparator those two builders use,
  // rather than a second, hand-rolled reordering that could drift from
  // theirs: `isUnread` supplies the one signal only the rail has, and the
  // received array's own index stands in for the recency rank neither
  // builder exposes past this point (OpenSession carries no timestamp of
  // its own -- see compareOpenSessions' doc comment) -- it already
  // reflects that ordering correctly, so re-deriving it here would only
  // risk disagreeing with it.
  function isUnread(s: OpenSession): boolean {
    return s.pid !== selectedPid && s.events != null && s.events > (seenEvents.get(s.pid) ?? s.events);
  }
  const rankByPid = new Map(sessions.map((s, i) => [s.pid, i]));
  const displaySessions = [...sessions].sort(compareOpenSessions(
    s => rankByPid.get(s.pid) ?? 0,
    () => 0, // no ties possible on the rank above (pid-unique indices), so no secondary signal is needed
    isUnread,
  ));

  return (
    <nav className={`rail ${side}`} style={{ width }} aria-label="Open sessions">
      {side === 'right' && handle}
      <div className="railcards">
        {displaySessions.map(s => {
          const waiting = s.activity === 'waiting_permission' || s.activity === 'waiting_input';
          const unread = isUnread(s);
          return (
            <div key={s.pid} className={s.pid === selectedPid ? 'railitem sel' : 'railitem'}>
              <OpenSessionCard state={s} onOpen={onSelect} onKill={onKill}
                onReattach={onReattach} onResume={onResume} unread={unread} />
              {waiting && (
                // Named with project and pid, matching the neighbouring
                // Close button's own convention (OpenSessionCard.tsx's
                // `Close, pid ${pid}`) -- with two waiting sessions in the
                // rail, a bare "Reply" would put two indistinguishable
                // buttons in the accessibility tree, defeating the rail's
                // whole point of telling sessions apart.
                <button type="button" className="railreply"
                  aria-label={`Reply to ${s.project}, pid ${s.pid}`}
                  onClick={() => setReplyPid(s.pid)}>
                  Reply
                </button>
              )}
              {replyPid === s.pid && (
                <ReplyPopover pid={s.pid} prompt={s.lastProse} onClose={() => setReplyPid(null)} />
              )}
            </div>
          );
        })}
      </div>
      {side === 'left' && handle}
    </nav>
  );
}
