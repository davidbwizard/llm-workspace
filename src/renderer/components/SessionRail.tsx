import { useEffect, useState } from 'react';
// TYPE-only from state.ts: that module imports node:os and reaches the
// database, neither of which exists in a sandboxed renderer. A type import is
// erased at build so it costs nothing; the comparator itself comes from
// order.ts, which is deliberately free of Node imports. Importing
// compareOpenSessions from state.ts threw at module load and rendered the
// whole window blank -- see order.ts's comment.
import type { OpenSession } from '../../fleet/state.ts';
import { compareOpenSessions, railSections, type RailRow } from '../../fleet/order.ts';
import type { KillResult } from '../../main/ipc.ts';
import type { LaunchResult } from '../../main/launch.ts';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import { StackCard } from './StackCard.tsx';
import { compactIn, useSettings } from '../state/settings.ts';
import {
  useGroups, isStackOpen, toggleStack, orderIndex, rememberKeys, categoryForRow, moveRow,
} from '../state/groups.ts';
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
 *  Also gives whichever card is currently waiting on you an Answer button
 *  that selects it and switches the main pane straight to the Conversation
 *  view (Task 5, quick-answers design §9) -- this is a SEPARATE trigger
 *  from the card's own onOpen (which still just selects it, per the
 *  existing, already-reviewed "reports the pid when a card is chosen"
 *  test): the two used to differ (Answer opened a reply popover in place,
 *  onOpen switched panes), but Task 5 replaced that popover with the same
 *  select-and-switch onOpen already does, plus the view flip -- so this
 *  component no longer keeps any popover state of its own; the pid and the
 *  routing decision (select this pid, show Conversation) both live in
 *  `onAnswer`, owned by the caller. */
export function SessionRail({
  sessions, selectedPid, onSelect, onKill, onReveal, onReattach, onResume, onAnswer, side, cmdIndexByPid,
}: {
  sessions: OpenSession[];
  selectedPid: number | null;
  onSelect: (pid: number) => void;
  onKill: (pid: number) => Promise<KillResult>;
  onReveal?: (pid: number) => Promise<unknown>;
  onReattach: (pid: number, cols: number, rows: number) => Promise<LaunchResult>;
  onResume: (sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>;
  /** A waiting session's Answer button calls this with its pid -- the
   *  caller (MainPane) selects it and switches to the Conversation view.
   *  Optional so this component's own tests that never click Answer need
   *  not wire it. */
  onAnswer?: (pid: number) => void;
  side: 'left' | 'right';
  /** Cmd+1..9's own shared ranking (App.tsx/useFleet.ts) -- pid to hotkey
   *  number (1-9), the SAME map FleetView's own cards read, so a number
   *  never disagrees with what Cmd+N actually selects even though this
   *  component's own displaySessions (below) can reorder a card away from
   *  that rank for the unread-promotion tier alone. Optional so this
   *  component's own tests keep rendering exactly as they did before. */
  cmdIndexByPid?: Map<number, number>;
}) {
  // Which places use compact cards is one setting with four values, so
  // "Both on but Fleet off" is not a state that can exist -- the rail reads
  // its own half of it and nothing more.
  const compact = compactIn(useSettings(), 'sidebar');

  const [width, setWidth] = useState<number>(() => readStoredRailWidth() ?? RAIL_DEFAULT_WIDTH);
  useEffect(() => { writeStoredRailWidth(width); }, [width]);

  // Which row is currently being dragged. Component state, not the store:
  // it lasts for the length of one gesture and nothing outside this rail has
  // any use for it.
  const [dragKey, setDragKey] = useState<string | null>(null);

  // Unread tracking: `events` is the one counter OpenSession always grows
  // monotonically as new agent output arrives for a uniquely-matched
  // session (see fleet/state.ts's own doc comment on OpenSession --
  // lastProse/events/activity are enrichment attached together, so events
  // changing is exactly as reliable a "something new happened" signal as
  // lastProse changing, and simpler to compare). Keyed by pid, in memory
  // only for this run of the app -- it resets on restart.
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
    // Sent across on OpenSession, not recomputed here: the check needs
    // tmpdir() and this is a sandboxed renderer. It cannot be skipped either
    // -- the unread tier below is checked before the rank tiers, so without
    // it an unread junk card would be promoted above a real session.
    s => s.junk,
    s => rankByPid.get(s.pid) ?? 0,
    () => 0, // no ties possible on the rank above (pid-unique indices), so no secondary signal is needed
    isUnread,
  ));

  // Subscribed for its side effect alone -- a category change, a stack
  // toggle or a newly-remembered key all live in this store, and any of them
  // must re-render the rail even though the values below are read through
  // the module functions (isStackOpen, orderIndex, ...), not off this
  // return, since those are the same functions StackCard and the row-order
  // sort below need to call directly.
  useGroups();
  const grouping = useSettings().groupSessions === 'on';

  // Renders one session's card, identical whether it sits loose in the rail
  // or inside an opened StackCard -- this rail wires each OpenSessionCard to
  // seven handlers plus its own unread and cmdIndex state, and a second copy
  // of that wiring (one here, one in StackCard) could only ever drift from
  // this one.
  //
  // `move` is the keyboard half of dragging (Task 9): absent for a member
  // rendered INSIDE a stack (StackCard's own renderMember callback below
  // takes one argument, so a member always gets undefined here) -- a
  // session inside a stack cannot be reordered on its own, because the drag
  // unit is the whole row, never a member of it. No `key` here any more:
  // the row wrapper added by the caller below now owns it, since that
  // wrapper -- not this div -- is what the drag handlers attach to.
  function renderSession(
    s: OpenSession,
    move?: { up?: () => void; down?: () => void },
  ): JSX.Element {
    const waiting = s.activity === 'waiting_permission' || s.activity === 'waiting_input';
    const unread = isUnread(s);
    return (
      <div className={s.pid === selectedPid ? 'railitem sel' : 'railitem'}>
        <OpenSessionCard state={s} onOpen={onSelect} onKill={onKill} onReveal={onReveal}
          onReattach={onReattach} onResume={onResume} unread={unread} compact={compact}
          cmdIndex={cmdIndexByPid?.get(s.pid)} onMoveUp={move?.up} onMoveDown={move?.down} />
        {waiting && (
          // Named with project and pid, matching the neighbouring Close
          // button's own convention (OpenSessionCard.tsx's
          // `Close, pid ${pid}`) -- with two waiting sessions in the rail, a
          // bare "Answer" would put two indistinguishable buttons in the
          // accessibility tree, defeating the rail's whole point of telling
          // sessions apart. Task 5: selects this pid and switches to the
          // Conversation view, where the prompt card (or its waiting-card
          // fallback) lives -- no popover opens here any more.
          <button type="button" className="railreply"
            aria-label={`Answer ${s.project}, pid ${s.pid}`}
            onClick={() => onAnswer?.(s.pid)}>
            Answer
          </button>
        )}
      </div>
    );
  }

  // The transform ALWAYS runs. `grouping` is folder stacking and nothing
  // else -- sections and David's own row order apply either way, because
  // "not auto movement for the cards" was stated unconditionally and a
  // category he set must not vanish because he turned stacking off. This
  // replaces Task 5's `rows === null` branch, which switched off too much.
  const sections = railSections(displaySessions, categoryForRow, orderIndex, grouping);

  // Pruning a dead assignment is NOT done here. It belongs on the fleet push
  // itself, which useFleet owns (Task 8) -- this component is not mounted in
  // every view, and an assignment's lifetime must not depend on which pane
  // happens to be on screen. Until Task 8 lands, an assignment simply
  // outlives its session; nothing renders for it, because rows are built
  // from the live sessions, not from the map.
  //
  // The join/split below is how a string dependency stands in for an array
  // one: useEffect compares deps by identity, and a fresh array each render
  // would fire it forever. NUL (\0), not \n: a row key can be a raw
  // filesystem cwd, and a newline is a legal byte inside a POSIX path -- two
  // different key sets could then join to the same string and the effect
  // would skip remembering the new one. NUL is the one byte a path can never
  // contain, so it is the only separator this join can use safely.
  const rowKeys = sections.flatMap(sec => sec.rows.map(r => r.key)).join('\0');
  useEffect(() => {
    if (rowKeys !== '') rememberKeys(rowKeys.split('\0'));
  }, [rowKeys]);

  // Which section each row is in, so a drop can be refused across a section
  // boundary. Built from the sections that were just computed rather than by
  // asking the store again, so the map and the render can never disagree.
  const sectionOfKey = new Map<string, string | null>();
  for (const section of sections) {
    for (const row of section.rows) sectionOfKey.set(row.key, section.name);
  }

  /** Moves `key` one place within its OWN section, using the neighbour as it
   *  is rendered rather than the neighbour in storage -- the stored order
   *  outlives the rows in it, so an adjacent stored key may be a folder with
   *  nothing running in it and stepping onto that would look like a skip. */
  function moveWithinSection(rows: RailRow<OpenSession>[], key: string, delta: -1 | 1): void {
    const i = rows.findIndex(r => r.key === key);
    const target = rows[i + delta];
    if (target === undefined) return;
    moveRow(key, target.key);
  }

  function dragProps(key: string): React.HTMLAttributes<HTMLDivElement> & { draggable: true } {
    return {
      draggable: true,
      onDragStart: e => {
        setDragKey(key);
        // Chromium and Firefox both refuse to start a drag with nothing on
        // the transfer, so this is required even though the payload is
        // never read back -- dragKey above is the real handle.
        e.dataTransfer.setData('text/plain', key);
        e.dataTransfer.effectAllowed = 'move';
      },
      // preventDefault on dragover is what marks an element as a valid drop
      // target. NOT calling it is therefore how a drop is refused, and the
      // browser shows the "no drop" cursor for free.
      onDragOver: e => {
        if (dragKey === null || dragKey === key) return;
        if (sectionOfKey.get(dragKey) !== sectionOfKey.get(key)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDrop: e => {
        e.preventDefault();
        if (dragKey !== null && dragKey !== key
          && sectionOfKey.get(dragKey) === sectionOfKey.get(key)) {
          // The ONE function the menu items call too, so drag and keyboard
          // can never drift into two different notions of "one place up".
          moveRow(dragKey, key);
        }
        setDragKey(null);
      },
      // Fires whether the drag landed or was abandoned, so the handle is
      // always cleared -- a stale dragKey would make the next click-drag
      // start from the wrong row.
      onDragEnd: () => setDragKey(null),
    };
  }

  return (
    <nav className={`rail ${side}`} style={{ width }} aria-label="Open sessions">
      {side === 'right' && handle}
      <div className="railcards">
        {sections.map(section => (
          // The key for the unnamed section cannot collide with a real name,
          // which normalizeGroups guarantees is trimmed and non-empty -- a
          // leading space is therefore unreachable.
          <div className="railsection" key={section.name ?? ' uncategorised'}>
            {section.name !== null && <h2 className="railsectionname">{section.name}</h2>}
            {section.rows.map((row, i) => {
              // Absent at each end of the section rather than present and
              // disabled: a menu item that is always there and sometimes does
              // nothing is worse than one that is only offered when it can act.
              const move = {
                up: i > 0 ? () => moveWithinSection(section.rows, row.key, -1) : undefined,
                down: i < section.rows.length - 1
                  ? () => moveWithinSection(section.rows, row.key, 1) : undefined,
              };
              return (
                <div className={`railrow${dragKey === row.key ? ' dragging' : ''}`}
                  key={row.key} {...dragProps(row.key)}>
                  {row.kind === 'session'
                    ? renderSession(row.session, move)
                    : <StackCard cwd={row.cwd} members={row.members}
                        open={isStackOpen(row.cwd)} onToggle={toggleStack}
                        selectedPid={selectedPid} renderMember={renderSession}
                        onAnswer={onAnswer} onMoveUp={move.up} onMoveDown={move.down} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {side === 'left' && handle}
    </nav>
  );
}
