import { useEffect, useState } from 'react';
import type { Provider } from '../../core/types.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './WorkingStrip.css';

const AGENT_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

/** Formats elapsed work time the way a glance at a stopwatch reads it:
 *  seconds alone under a minute, then minutes-and-seconds, then
 *  hours-and-minutes -- never more than two units, and seconds drop out
 *  once minutes show at all (a strip you glance at mid-task doesn't need
 *  sub-minute precision an hour in). */
export function elapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/** The strip above the message box while the open session's agent is
 *  working -- design option C from live-feedback-options.html, the one
 *  David picked after seeing it beside the terminal's line (A) and a
 *  written-reply placeholder (B). `since` is the live push's own timestamp
 *  for when the CURRENT run of work started (useSessionLive's
 *  SessionLive.since); `null` means main hasn't reported one yet, in which
 *  case the strip still names the agent but shows no timer, rather than a
 *  "0s" that isn't actually counting from anything real.
 *
 *  `now`, when a caller supplies it, replaces this component's own clock
 *  for computing the elapsed text, and also skips starting the interval
 *  below -- a caller that hands in its own `now` has already taken on
 *  re-rendering this on whatever schedule it wants (a fixed value in a
 *  test, say), so a second, internal clock ticking underneath it would
 *  only fight that caller for control of what's on screen. Left
 *  undefined -- the ordinary case, ConversationView's own usage -- this
 *  component runs its own one-second ticker off Date.now(). */
export function WorkingStrip({ provider, since, now }: { provider: Provider; since: number | null; now?: number }) {
  // Forces a re-render once a second so the elapsed text below -- always
  // computed fresh from Date.now(), never itself carried in state -- has a
  // reason to catch up with the real clock. Only the setter is used; the
  // count itself has no meaning of its own.
  const [, retick] = useState(0);
  useEffect(() => {
    // Nothing to count, or the caller already owns re-rendering this (see
    // the `now` doc above) -- either way, starting an interval here would
    // tick for no reason, and would be one more timer this pane leaks if a
    // future edit ever forgot to clear it.
    if (since === null || now !== undefined) return;
    const id = setInterval(() => retick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [since, now]);

  const secs = since === null ? null : elapsed((now ?? Date.now()) - since);

  return (
    <div className="strip">
      <span className="dot" aria-hidden="true" />
      <ProviderMark provider={provider} size={13} />
      {/* role="status" is a polite live region -- it only needs to announce
          once, when the strip appears or the provider changes, since this
          text never itself changes while mounted. The ticking count lives
          OUTSIDE this span on purpose, so it never re-triggers the
          announcement every second (it is also aria-hidden below, for the
          same reason twice over). */}
      <span role="status">{`${AGENT_NAME[provider]} is working`}</span>
      {secs !== null && <span className="secs" aria-hidden="true">{secs}</span>}
    </div>
  );
}
