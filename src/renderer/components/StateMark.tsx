// The mark beside each dependency, ported from the approved mockup
// (claude.ai/artifact/JBHq1Sko5Sd7aaGpJj1Gyc, symbols #i-ok / #i-miss /
// #i-warn) rather than inferred from it.
//
// Three SHAPES, not three colours: a tick, a filled disc and an open ring.
// Colour carries the same information a second time, for people who read
// colour -- but it is never the only carrier, so the list still works in
// greyscale, at a glance, and for anyone who cannot tell the accent from
// the critical tone.
//
// Each mark has a real accessible name, because the shape is the only
// thing a sighted reader gets and a screen reader gets nothing from an SVG
// path. The names are the four states' own words, matching the text
// elsewhere in the row -- a reader hearing "Missing" and one seeing the
// filled disc are told the same thing.
//
// Inlined per mark rather than a <symbol> sprite with <use>: the mockup
// needs a sprite because it draws the same mark repeatedly in one static
// document, and React components compose without one.
import type { CheckState } from '../../main/checks.ts';

/** Which mark each state wears. `unhealthy` and `timeout` share the open
 *  ring deliberately: both mean "this is present and something is off",
 *  which is a different thing from absent. In particular a timeout must
 *  NOT wear the missing mark -- a probe that did not answer is not a tool
 *  that is not there, and the mark is the first thing anyone reads. */
const MARK: Record<CheckState, 'ok' | 'miss' | 'warn'> = {
  ok: 'ok', missing: 'miss', unhealthy: 'warn', timeout: 'warn',
};

/** The accessible name per state -- the same words the row's own label
 *  uses, so the two can never say different things. */
export const STATE_NAME: Record<CheckState, string> = {
  ok: 'Found',
  missing: 'Missing',
  unhealthy: 'Needs attention',
  timeout: 'No answer',
};

export function StateMark({ state }: { state: CheckState }) {
  const shape = MARK[state];
  return (
    <svg className={`mk ${shape}`} viewBox="0 0 16 16" role="img" aria-label={STATE_NAME[state]}>
      {shape === 'ok' && (
        <path d="m3 8.4 3.2 3.2L13 4.8" fill="none" stroke="currentColor"
          strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {shape === 'miss' && (
        <>
          <circle cx="8" cy="8" r="6.6" fill="currentColor" />
          {/* Knocked out in the page background, as the mockup does, so the
              stroke reads on the filled disc in either theme. */}
          <path d="M8 4.4v4.3M8 11.2v.1" stroke="var(--ground)" strokeWidth="1.9" strokeLinecap="round" />
        </>
      )}
      {shape === 'warn' && (
        <>
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path d="M8 4.6v4.2M8 11.3v.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
