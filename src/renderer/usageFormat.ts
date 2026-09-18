/** Pure formatting for the usage/context feature (usage design, Part B).
 *  No node imports -- shared by ContextChip.tsx and UsagePopover.tsx, and
 *  safe to import from anywhere in src/renderer/**. */

/** The context chip's short form (usage design: "462k · 44% left"):
 *  <1000 -> the exact number; <1,000,000 -> whole thousands with a "k"
 *  suffix, no decimals (rounded, not truncated -- 462,600 reads as 463k,
 *  not 462k); >=1,000,000 -> one decimal with an "M" suffix. */
export function formatContextShort(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Which colour tier the context chip renders in (usage design, Part B):
 *  critical below 10% left, signal from 10 up to (not including) 20,
 *  otherwise null -- the chip's own default muted tone, no modifier
 *  class. */
export function contextTone(leftPct: number): 'critical' | 'signal' | null {
  if (leftPct < 10) return 'critical';
  if (leftPct < 20) return 'signal';
  return null;
}

/** Shared duration-bucket scale for "resets in" and "updated ago" alike:
 *  days+hours at 24h and up ("5d 15h"), hours+minutes from 1h up to a day
 *  ("2h 35m"), bare minutes below that ("12m"). The days tier always shows
 *  its hour part, even "0h" ("1d 0h"), so a duration that just crossed a
 *  day boundary never silently drops a whole unit; the hours tier keeps
 *  this file's older rule of dropping a genuinely-zero minute remainder
 *  (a bare "3h", not "3h 0m"). `totalMin` must already be a non-negative
 *  integer number of minutes -- callers decide whether to ceil (a
 *  still-future countdown, formatResetIn) or floor (elapsed time,
 *  formatUpdatedAgo). */
function formatDuration(totalMin: number): string {
  if (totalMin >= 1440) {
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    return `${d}d ${h}h`;
  }
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${totalMin}m`;
}

/** "resets in 2h 10m" for a strictly positive duration, using the shared
 *  scale above. A sub-minute remainder rounds UP to "1m" rather than down
 *  to "0m" -- ceil, not round, since a still-future reset must never read
 *  as already due. Callers check the duration is finite and positive first
 *  (resetTextFor below) -- this function assumes that and does no checking
 *  of its own. */
export function formatResetIn(deltaMs: number): string {
  const totalMin = Math.ceil(deltaMs / 60_000);
  return `resets in ${formatDuration(totalMin)}`;
}

/** The reset line for one rate-limit window, or null when there is nothing
 *  honest to say: no resetsAt at all, a non-finite one (main's own
 *  RateWindow.resetsAt is not range-checked at the source -- Part A review
 *  note), or one that is not strictly in the future. A confusing "resets
 *  in -3m" or a NaN must never reach the screen -- omitting the line
 *  entirely is the honest answer, not a fallback string. */
export function resetTextFor(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const delta = resetsAt - now;
  return delta > 0 ? formatResetIn(delta) : null;
}

/** "updated 4h 38m ago", using the same day/hour/minute scale as
 *  formatResetIn above -- floored, not ceiled, since this is elapsed time:
 *  "12.9m ago" honestly reads as "12m ago", not "13m ago". Anything under a
 *  minute -- including clock skew between main's updatedAt and the
 *  renderer's own Date.now(), clamped to zero rather than a nonsensical
 *  negative count -- reads as "updated just now" rather than "updated 0m
 *  ago". */
export function formatUpdatedAgo(updatedAt: number, now: number): string {
  const totalMin = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (totalMin < 1) return 'updated just now';
  return `updated ${formatDuration(totalMin)} ago`;
}

/** Clamps a rate-limit percentage to what a bar can actually draw (0-100)
 *  and what aria-valuenow may report against a declared aria-valuemax of
 *  100. usedPct itself is NOT clamped at the source (Part A review note:
 *  a spend-based limit can exceed 100%) -- callers that also show the raw
 *  number as text should use the unclamped value there, and this only for
 *  the bar's own width/aria-valuenow. */
export function clampBarPct(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}
