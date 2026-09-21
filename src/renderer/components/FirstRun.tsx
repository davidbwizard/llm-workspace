// The first-run surface: what is missing, and what to do about it.
//
// Design: docs/superpowers/specs/2026-09-21-first-run-checks-design.md §5.
//
// DELIBERATELY UNDESIGNED. The visual design for this screen is being mocked
// up separately; this is the mechanism with the least presentation that
// satisfies §5, and it is a thin shell around DependencyChecks so a designed
// screen replaces this file and that one without touching any probe logic.
//
// Two rules it follows, both from §4:
//
//   - It NEVER blocks the app. It sits above the fleet, and everything below
//     it still works as far as it can. A machine with no tmux opens
//     read-only rather than refusing to run.
//   - It appears only when it has something to say -- something is actually
//     missing or unhealthy. A machine where all three are installed sees
//     this once, never: there is no "welcome" step to click through.
//
// Dismissal is per-window and not remembered on disk. Hiding a real problem
// permanently on one click is a worse trade than showing it again next
// launch, and Settings ("What this app needs") is the durable route back.
import { useState } from 'react';
import { DependencyChecks } from './DependencyChecks.tsx';
import { useChecks } from '../state/useChecks.ts';
import './FirstRun.css';

export function FirstRun() {
  const checks = useChecks();
  const [dismissed, setDismissed] = useState(false);

  // Nothing to say until a sweep has finished. While it is still running
  // the app stays silent rather than flashing a panel that would vanish a
  // moment later -- a full sweep is ~11s, almost all of it `codex doctor`.
  if (dismissed || checks.readiness === null) return null;
  const problems = checks.readiness.checks.filter(c => c.state !== 'ok');
  if (problems.length === 0) return null;

  return (
    <section className="firstrun" aria-label="Setup">
      <header className="firstrunhead">
        <h2>
          {problems.length === 1
            ? `${problems[0]!.name} needs attention`
            : `${problems.length} things need attention`}
        </h2>
        <button type="button" className="firstrundismiss" onClick={() => setDismissed(true)}>
          Hide for now
        </button>
      </header>
      <DependencyChecks {...checks} />
      <p className="firstrunwhere">
        You can see this again any time under Settings &rsaquo; What this app needs.
      </p>
    </section>
  );
}
