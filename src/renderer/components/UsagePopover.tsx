import { useEffect, useState } from 'react';
import type { UsagePayload, RateWindow, CodexRateWindow } from '../../core/usage.ts';
import { formatUpdatedAgo, resetTextFor, clampBarPct } from '../usageFormat.ts';
import './UsagePopover.css';

/** How often this refreshes while open (usage design, Part B: "Refresh
 *  usage when the popover opens and every 30 s while open"). The popover
 *  is only ever mounted while open (LaunchBar.tsx renders it conditionally),
 *  so "on open" is simply "on mount", and "stops when closed" is simply
 *  "the interval is cleared on unmount". */
const REFRESH_MS = 30_000;

/** Claude's two known windows have fixed, human names; Codex's are labelled
 *  from their own `windowMinutes` (Part A's own note: "label each bar from
 *  windowMinutes, not from the slot name" -- which window is `primary` vs.
 *  `secondary` is not guaranteed across accounts). Falls back to a plain
 *  duration for anything else, rather than a guessed name. */
function codexLabel(windowMinutes: number | null): string {
  if (windowMinutes === 300) return '5-hour';
  if (windowMinutes === 10_080) return 'Weekly';
  if (windowMinutes === null) return 'Usage';
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}-day`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour`;
  return `${windowMinutes}-minute`;
}

/** One rate-limit bar. `window.usedPct` is shown in TEXT uncapped (a
 *  spend-based limit can genuinely exceed 100%, Part A review note) but
 *  the bar's own width and its aria-valuenow are clamped to 0-100, since
 *  aria-valuemax is declared as 100 and a progressbar may never report a
 *  value past its own stated max. The reset line is omitted outright
 *  (resetTextFor) for a non-finite or already-past resetsAt, rather than
 *  showing a confusing negative duration. */
function UsageBar({ label, window, now }: { label: string; window: RateWindow; now: number }) {
  const pct = Math.max(0, Math.round(window.usedPct));
  const barPct = clampBarPct(pct);
  const resetText = resetTextFor(window.resetsAt, now);
  const name = `${label}: ${pct}% used${resetText ? `, ${resetText}` : ''}`;
  return (
    <div className="usagebar">
      <div className="usagebar-head">
        <span>{label}</span>
        <span>{pct}% used</span>
      </div>
      <div className="usagebar-track" role="progressbar" aria-label={name}
        aria-valuenow={barPct} aria-valuemin={0} aria-valuemax={100}>
        <div className="usagebar-fill" style={{ width: `${barPct}%` }} />
      </div>
      {resetText && <p className="usagebar-reset">{resetText}</p>}
    </div>
  );
}

/** The Usage button's popover (usage design, Part B): Claude's 5-hour and
 *  Weekly bars, Codex's primary (and secondary, if present), an
 *  "updated N min ago" per provider, and the design's own three empty
 *  states. Non-modal by contract -- LaunchBar.tsx is what handles Escape,
 *  outside-click and focus return (this component takes no onClose of its
 *  own: it never closes itself, only renders its content and manages its
 *  own data fetch). */
export function UsagePopover() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const api = window.fleet;
    if (api?.usageSwitchGet) {
      void api.usageSwitchGet().then(
        r => { if (alive) setInstalled(r.installed); },
        err => console.error('usage:switch:get failed:', err),
      );
    }
    function refresh() {
      if (!api?.usageGet) return;
      void api.usageGet().then(
        u => { if (alive) { setUsage(u); setNow(Date.now()); } },
        err => console.error('usage:get failed:', err),
      );
    }
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const claude = usage?.claude ?? null;
  const codex = usage?.codex ?? null;

  return (
    <div className="usagepop" role="dialog" aria-label="Usage and context">
      <section className="usagesection">
        <h3 className="usagesectitle">Claude</h3>
        {installed === false ? (
          <p className="usageempty">Turn on Usage and context in Settings</p>
        ) : claude === null ? (
          <p className="usageempty">No data yet</p>
        ) : (
          <>
            {claude.fiveHour && <UsageBar label="5-hour" window={claude.fiveHour} now={now} />}
            {claude.sevenDay && <UsageBar label="Weekly" window={claude.sevenDay} now={now} />}
            <p className="usageupdated">{formatUpdatedAgo(claude.updatedAt, now)}</p>
          </>
        )}
      </section>
      <section className="usagesection">
        <h3 className="usagesectitle">Codex</h3>
        {codex === null ? (
          <p className="usageempty">No Codex sessions yet</p>
        ) : (
          <>
            {codex.primary && <UsageBar label={codexLabel((codex.primary as CodexRateWindow).windowMinutes)} window={codex.primary} now={now} />}
            {codex.secondary && <UsageBar label={codexLabel((codex.secondary as CodexRateWindow).windowMinutes)} window={codex.secondary} now={now} />}
            <p className="usageupdated">{formatUpdatedAgo(codex.updatedAt, now)}</p>
          </>
        )}
      </section>
    </div>
  );
}
