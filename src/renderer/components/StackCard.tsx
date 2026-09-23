import type { CSSProperties, ReactNode } from 'react';
import type { OpenSession } from '../../fleet/state.ts';
import { lastSegment } from '../state/favourites.ts';
import { Icon } from './Icon.tsx';
import './StackCard.css';

function isWaiting(s: OpenSession): boolean {
  return s.activity === 'waiting_permission' || s.activity === 'waiting_input';
}

/** What the folded face says its members are doing. Waiting comes FIRST and
 *  is named in the app's own words ("waiting on you"), because folding must
 *  never be the reason David misses the one thing this app exists to show
 *  him. States with no members are omitted rather than printed as "0 idle". */
export function stackSummary(members: OpenSession[]): string {
  const waiting = members.filter(isWaiting).length;
  const working = members.filter(s => s.activity === 'working').length;
  const rest = members.length - waiting - working;
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} waiting on you`);
  if (working > 0) parts.push(`${working} working`);
  if (rest > 0) parts.push(`${rest} idle`);
  return parts.join(', ');
}

/** Several sessions sharing a folder, as one rail row that opens in place
 *  (the mechanic David chose on 2026-09-22 over a flyout and over an
 *  always-open header list).
 *
 *  Members are rendered by the CALLER via `renderMember` rather than by this
 *  component: the rail already wires each OpenSessionCard to seven handlers
 *  plus its unread and cmdIndex state, and threading all of that through here
 *  would duplicate that wiring in a second place that could drift from it. */
export function StackCard({
  cwd, members, open, onToggle, selectedPid, renderMember, onAnswer, onMoveUp, onMoveDown, unread,
}: {
  cwd: string;
  members: OpenSession[];
  open: boolean;
  onToggle: (cwd: string) => void;
  selectedPid: number | null;
  renderMember: (s: OpenSession) => ReactNode;
  /** Optional so tests that never click Answer need not wire it, matching
   *  SessionRail's own onAnswer convention. */
  onAnswer?: (pid: number) => void;
  /** The keyboard half of dragging, exactly as OpenSessionCard's own pair.
   *  Rendered as two small buttons on the face rather than behind a "..."
   *  popover of their own: a two-item popover would need its own Escape and
   *  click-outside handling -- machinery this app writes once per popover,
   *  not a shared component -- to reach two controls that fit on the face as
   *  they are. Absent when the row is at that end of its section. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** True when ANY member has unread output. Passed in rather than computed
   *  here because unread-ness is a per-viewer fact only the rail tracks (its
   *  `seenEvents` baseline), exactly as it is for a loose card.
   *
   *  A folded stack hides its members, so without this an arriving update is
   *  invisible until you happen to open the folder -- which defeats the one
   *  thing this app exists to do. Shown whether folded or open: when open the
   *  member carries its own dot too, but repeating it on the face costs
   *  nothing and means the signal never depends on where you are looking. */
  unread?: boolean;
}): JSX.Element {
  const waiting = members.filter(isWaiting);
  const label = lastSegment(cwd);
  const holdsSelection = members.some(m => m.pid === selectedPid);

  // Exactly one waiting member gets an Answer button on the FACE. Two or more
  // and there is no honest answer to "which session would this answer", so
  // the count stands on its own and the stack must be opened -- deliberately
  // not a button that silently picks the first one.
  const answerable = waiting.length === 1 ? waiting[0] : undefined;

  // attn beats unread, the same priority OpenSessionCard's own classname
  // picks (attn/unread/live, in that order): a stack that is BOTH waiting on
  // you and unread must read as waiting, and showing two differently-meant
  // marks at once would make a third, ambiguous state.
  const showUnread = unread === true && waiting.length === 0;

  const cls = ['stack'];
  // Two sheets behind the card for three or more sessions, one for exactly
  // two -- the deck's depth says roughly how many are in there before the
  // count pill is read, the way a stacked notification does. It does not keep
  // growing past two: a third sliver adds no information and starts to look
  // like a shadow bug.
  if (members.length >= 3) cls.push('deep');
  if (waiting.length > 0) cls.push('attn');
  if (open) cls.push('open');
  if (holdsSelection) cls.push('sel');

  return (
    <div className={cls.join(' ')}>
      <div className="stackface">
        <button
          type="button"
          className="stacktoggle"
          aria-expanded={open}
          onClick={() => onToggle(cwd)}
        >
          {/* The dot rides WITH the count rather than in the card's own
              top-right corner, because on a stack that corner already holds
              the Move up/down pair -- an absolutely-placed dot would sit on
              top of them. Same 8px --signal circle as OpenSessionCard's
              .unread-dot, so the two read as one signal in two places. */}
          <span className="stacktop">
            <span className="stackcount">{members.length} sessions</span>
            {showUnread && <span className="stackunread" aria-label="Unread output" role="img" />}
          </span>
          {/* Decorative: aria-expanded on this button already tells a screen
              reader which way the stack is, so naming the chevron too would
              say the same thing twice. */}
          <span className="stackchev" aria-hidden="true">
            <Icon name="chevron-down" size={12} />
          </span>
          <span className="stackname">{label}</span>
          <span className="stackpath">{cwd}</span>
          <span className="stacksummary">{stackSummary(members)}</span>
        </button>
        {answerable && (
          // Named with project and pid, matching the rail's own Answer button
          // convention (SessionRail.tsx) -- with two stacks each offering one,
          // a bare "Answer" would put indistinguishable buttons in the
          // accessibility tree.
          <button
            type="button"
            className="stackreply"
            aria-label={`Answer ${answerable.project}, pid ${answerable.pid}`}
            onClick={() => onAnswer?.(answerable.pid)}
          >
            Answer
          </button>
        )}
        {(onMoveUp || onMoveDown) && (
          <div className="stackmove">
            {onMoveUp && (
              <button type="button" aria-label={`Move ${label} up`} onClick={onMoveUp}>Up</button>
            )}
            {onMoveDown && (
              <button type="button" aria-label={`Move ${label} down`} onClick={onMoveDown}>Down</button>
            )}
          </div>
        )}
      </div>
      {/* ALWAYS rendered, never `{open && ...}`: a node that does not exist
          cannot transition from anything, and the height animation is the
          whole point. The `open` class on the root drives it, and the
          stylesheet's visibility rule is what keeps the folded subtree out
          of the accessibility tree and the tab order in the meantime. */}
      <div className="stackmembers">
        <div className="stackmembers-inner">
          {members.map((m, i) => (
            // One slot per member carrying its index, so the stagger works
            // at any depth. An nth-child list would have to guess a maximum
            // and silently stop staggering past it.
            <div className="stackmember" key={m.pid} style={{ '--i': i } as CSSProperties}>
              {renderMember(m)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
