import type { Activity } from '../../fleet/state.ts';

/** The session status, drawn as a shape (status row, variant A -- David's
 *  approved mockup). Replaces the colour-only dot in the RAIL's cards,
 *  where the status word is dropped at narrow widths and the icon is then
 *  the only thing left carrying the state.
 *
 *  Shape, not hue, is what separates these. A dot in four colours is
 *  unreadable to anyone who cannot tell the warm tones apart, and the rail
 *  narrows to where the word is gone -- so each state gets its own
 *  geometry, and the colour is a second, redundant channel rather than the
 *  only one:
 *
 *    working  broken ring   (a dashed stroke -- motion, arrested)
 *    idle     hollow ring   (the quietest mark in the set)
 *    waiting  FILLED disc   with an exclamation -- see below
 *    error    hollow ring   with an exclamation
 *
 *  Waiting on you is the ONE filled shape in the set, deliberately: it is
 *  the state that must never be missed, and a solid disc is the only mark
 *  here that still reads at a glance when the word beside it is gone.
 *  `error` therefore does NOT get a fill, even though it is also a
 *  the-user-should-look state -- it carries the same exclamation on a
 *  hollow ring instead, so "filled" keeps meaning exactly one thing. (The
 *  mockup drew three states; error is the fourth this component must
 *  actually handle, and this is the reading of "the only filled shape"
 *  that keeps that rule intact.)
 *
 *  aria-hidden throughout: OpenSessionCard renders the activity WORD
 *  beside this icon at every width and in every state -- visually hidden
 *  once the rail is too narrow to show it, never removed -- so the state
 *  already has an accessible name and this would only say it twice. */
export function StatusIcon({ activity, size = 11 }: { activity: Activity; size?: number }) {
  return (
    <svg className="stateicon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {SHAPES[activity]}
    </svg>
  );
}

// currentColor throughout, so .state.<activity> owns the hue in CSS and
// this file never names a colour -- same contract as ProviderMark. The one
// exception is the exclamation punched out of the filled disc, which has
// to be the card's own background to read as a hole rather than a mark.
const SHAPES: Record<Activity, React.ReactNode> = {
  working: (
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeDasharray="26 12" strokeLinecap="round" />
  ),
  idle: <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  waiting_permission: <WaitingShape />,
  waiting_input: <WaitingShape />,
  error: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 4.8v4M8 11.2v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
};

function WaitingShape() {
  return (
    <>
      <circle cx="8" cy="8" r="6.6" fill="currentColor" />
      <path d="M8 4.4v4.2M8 11.1v.1" stroke="var(--ground)" strokeWidth="1.9" strokeLinecap="round" />
    </>
  );
}
