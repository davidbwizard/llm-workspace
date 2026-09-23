import './RailAttentionBar.css';

/** Why this exists at all.
 *
 *  Rows in this rail no longer move on their own -- David's ruling, because
 *  cards shifting under the cursor was the original complaint. The cost of
 *  that decision is precisely this: a session that starts waiting on you no
 *  longer floats to the top, so it can be sitting below the fold in a long
 *  rail and nothing on screen says so. An app whose whole job is telling you
 *  which session needs you cannot have a "needs you" state you have to scroll
 *  to find.
 *
 *  So this bar is not decoration -- it is the half of the ordering change
 *  that makes the ordering change safe.
 *
 *  Deliberately dumb: it renders what it is told and calls back when clicked.
 *  Deciding WHICH row is off screen needs real layout, which jsdom does not
 *  compute, so that half lives in SessionRail where it can be kept in one
 *  place -- and is honestly untestable here. Keeping the two apart means the
 *  copy, the priority and the accessible name are all still covered. */
export function RailAttentionBar({ kind, label, direction, onGo }: {
  /** 'waiting' beats 'unread', the same priority OpenSessionCard's own
   *  classname picks and the same one StackCard's face uses. Two bars, or one
   *  bar that mixed the two colours, would turn two clear states into an
   *  ambiguous third. */
  kind: 'waiting' | 'unread';
  /** What is off screen, named. "Needs attention" tells you nothing you can
   *  act on; the project name tells you whether it is the one you care about
   *  without scrolling at all. */
  label: string;
  /** Which way to scroll. A bar pinned to the bottom while the row is ABOVE
   *  you would send you the wrong way, which is worse than no bar. */
  direction: 'up' | 'down';
  onGo: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`railattn ${kind} ${direction}`}
      onClick={onGo}
    >
      {/* The arrow is the direction, said twice: once in the glyph for a
          glance, once in the accessible name for a screen reader, which
          cannot see which edge of the rail this is pinned to. */}
      <span className="railattn-arrow" aria-hidden="true">{direction === 'up' ? '↑' : '↓'}</span>
      <span className="railattn-label">{label}</span>
    </button>
  );
}
