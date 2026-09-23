import type { OpenSession } from '../../fleet/state.ts';
import { compareOpenSessions, railSections, type RailRow, type RailSection } from '../../fleet/order.ts';
import { useGroups, categoryForRow, orderIndex } from './groups.ts';
import { useSettings } from './settings.ts';

/** Which member of a stack a Cmd+N chord lands on (App.tsx's own keydown
 *  handler): whichever most needs the user -- waiting on them -- else the
 *  first.
 *
 *  Pulled out as its own named, exported function rather than left inline
 *  in App.tsx's handler, and DELIBERATELY NOT trusted to `members[0]` alone
 *  even though, as things stand, it would give the same answer: the members
 *  of a stack are built by order.ts's groupByFolder from a list
 *  compareOpenSessions has ALREADY sorted blocked-first, so today a stack's
 *  own `members[0]` already happens to be its waiting member whenever
 *  exactly one exists. That is an EMERGENT property of two other modules'
 *  sort order, not a contract either of them documents or a test of theirs
 *  pins down -- App.tsx's own correctness must not depend on it silently
 *  continuing to hold. Explicit here, and independently tested against a
 *  members list where the waiting one is deliberately NOT first, in
 *  useRailSlots.test.tsx. */
export function mostUrgentMember(members: OpenSession[]): OpenSession | undefined {
  return members.find(m => m.activity === 'waiting_permission' || m.activity === 'waiting_input') ?? members[0];
}

/** What Cmd+1..9 addresses (David's own model, 2026-09-23): "card spots as
 *  slots... slot 1 is always slot 1. If a card in slot one moves, slot 1
 *  stays as slot 1. Or if card in slot one is closed, slot 1 stays as slot
 *  one, all cards would just shift up." A slot is one visible RAIL ROW, not
 *  one session -- a folded stack is one slot, an OPENED stack is STILL one
 *  slot (its members do not get their own numbers, and opening it must not
 *  renumber anything else), and a category section header consumes no slot
 *  at all. */
export interface RailSlots {
  /** The rail's full row layout, sections in display order, each section's
   *  rows in display order -- exactly what SessionRail renders. */
  sections: RailSection<OpenSession>[];
  /** `sections` flattened, with the section boundaries dropped -- what the
   *  fleet grid (FleetView, via MainPane) needs to lay its cards out in the
   *  same order the rail shows, stack members sitting adjacent under their
   *  stack's own number. Rendering the rail's actual STACK chrome in the
   *  grid is separate, larger, neglected-view work and out of scope here --
   *  this only makes the grid's existing per-session cards agree with the
   *  rail about ordering and numbering. */
  rows: RailRow<OpenSession>[];
  /** pid -> Cmd+1..9 slot number (1-9). Every member of a stack shares its
   *  stack's number, whether the stack is folded or open. Omits any pid past
   *  the ninth row, and every pid once the rail runs out of rows. */
  slotByPid: Map<number, number>;
}

/** The ONE shared computation behind both Cmd+1..9 (App.tsx's window keydown
 *  listener) and the small hotkey number every open-session card shows (the
 *  rail AND the grid) -- called from both places, rather than each deriving
 *  its own ranking, because two independent computations of "what order are
 *  the sessions in" is exactly how they drifted apart before this hook
 *  existed:
 *
 *  App used to rank sessions with useFleet.ts's own `orderedSessions` -- a
 *  plain compareOpenSessions sort with no persisted row order, no
 *  categories, and no folder stacking. SessionRail, meanwhile, had grown all
 *  three (Tasks 5 and 8 on this branch: categorised sections, David's own
 *  drag-to-reorder row order, and folder stacks), through a SEPARATE
 *  railSections computation App's ranking never saw. The two only ever
 *  agreed by coincidence -- a stack, a category, or a manual reorder could
 *  make a card show one number while sitting in a completely different
 *  position, and dragging a card carried its old number with it, because
 *  the old map was keyed by pid rather than by the row the rail actually
 *  drew. This hook is what makes that impossible: both callers read the
 *  exact same row layout, so a card's own number can never disagree with
 *  what pressing that chord actually selects.
 *
 *  ISUNREAD IS DELIBERATELY LEFT OUT of the ordering below, even though
 *  SessionRail's own former inline version of this computation fed it in as
 *  a promotion tier. That is not a behaviour change -- it was already
 *  inert, and dropping it is what makes this computation callable from App,
 *  which cannot see SessionRail's rail-local `seenEvents` state at all:
 *
 *    - A row's position is decided by TWO different mechanisms depending on
 *      whether groups.ts's stored `order` already knows its key.
 *      `applyStableOrder` (order.ts) sorts every row by `orderIndex(key)`,
 *      the row's STORED index -- for a key already remembered there, that
 *      index alone decides its position; this comparator's tiers (junk,
 *      blocked, unread, rank) never even get consulted for it again.
 *    - A row's key is remembered (SessionRail's own `rememberKeys` effect)
 *      on the render immediately after the row's own first appearance. So
 *      this comparator's ordering can only ever still be governing a row's
 *      position on ONE render: the very first one, before that row's key
 *      has a stored index yet.
 *    - On exactly that render, `isUnread` is false BY CONSTRUCTION for that
 *      row: SessionRail only records a pid's events baseline once it has
 *      already seen that pid (its own `seenEvents` effect), so an
 *      unbaselined pid's own check -- `s.events > (seenEvents.get(pid) ??
 *      s.events)` -- reduces to `s.events > s.events`, always false. A row
 *      cannot be marked unread on the one render where being marked unread
 *      could still move it.
 *
 *  So carrying isUnread here would change nothing about where any row
 *  lands, ever, while making the whole computation depend on state that
 *  only exists inside one of its two callers. `isUnread` is NOT going away
 *  as a concept -- SessionRail keeps its own copy for the one thing that
 *  still needs it: the unread DOT, and the `unread` prop a folded StackCard
 *  shows for a member you have not looked at, neither of which is about row
 *  order at all. */
export function useRailSlots(sessions: OpenSession[]): RailSlots {
  // Subscribed for its side effect alone -- a category change, a stack
  // toggle, or a newly-remembered key all live in this store, and any of
  // them must re-render every caller of this hook even though the values
  // below are read through the module functions (categoryForRow,
  // orderIndex), not off this return.
  useGroups();
  const grouping = useSettings().groupSessions === 'on';

  const rankByPid = new Map(sessions.map((s, i) => [s.pid, i]));
  const displaySessions = [...sessions].sort(compareOpenSessions(
    // Sent across on OpenSession, not recomputed here: the check needs
    // tmpdir(), which does not exist in a sandboxed renderer.
    s => s.junk,
    s => rankByPid.get(s.pid) ?? 0,
    () => 0, // no ties possible on the rank above (pid-unique indices)
  ));

  const sections = railSections(displaySessions, categoryForRow, orderIndex, grouping);
  const rows = sections.flatMap(sec => sec.rows);

  const slotByPid = new Map<number, number>();
  for (const [i, row] of rows.entries()) {
    if (i >= 9) break;
    const slot = i + 1;
    if (row.kind === 'session') slotByPid.set(row.session.pid, slot);
    // Every member shares the stack's own slot -- opening it does not grow
    // the number of things a chord can address, and folding three sessions
    // into one row means two of them have no direct chord of their own.
    // That is the accepted price of "slot 1 is always slot 1", not a bug.
    else for (const m of row.members) slotByPid.set(m.pid, slot);
  }

  return { sections, rows, slotByPid };
}
