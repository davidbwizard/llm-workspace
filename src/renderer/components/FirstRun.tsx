// The first-run screen: layout A, as David picked it.
//
// Mockup: claude.ai/artifact/JBHq1Sko5Sd7aaGpJj1Gyc, option A. The window
// opens to this and nothing else until they continue; the launch bar stays
// visible above it, disabled. The dependency list itself is
// DependencyChecks.tsx and is the same list Settings shows -- A is about
// where it sits, not what it contains.
//
// WHEN IT APPEARS. The mockup does not answer this, and it is the decision
// that matters most, because the cost of getting it wrong is a wall between
// someone and the app they just opened. The rule, and why:
//
//   1. First run, with anything wrong -- yes. This is the one moment where
//      explaining what the app needs is the whole job rather than an
//      interruption, and nobody can miss it.
//   2. Every launch after that, with the core dead (no tmux) -- yes. Not
//      as nagging: without tmux the app cannot start or attach to a single
//      session, so opening to the normal window would be opening to a set
//      of controls that all refuse. The screen is the honest answer.
//   3. Every launch after that, with something else missing -- NO. Someone
//      who has deliberately chosen to run without Codex has already read
//      this screen and said continue. Showing it again every launch would
//      punish exactly the person who made an informed choice. The app opens
//      normally, the missing provider's controls are disabled with their
//      reasons attached (design §4), and this screen stays one click away
//      in Settings.
//   4. Nothing wrong -- never, not even once. There is no welcome step to
//      click through on a machine where everything is already installed.
//
// Rule 3 is the one that follows from the design rather than the mockup:
// §4's whole position is that a missing tool costs one capability, not the
// app. A permanent wall for a missing Codex would contradict it.
import { useState } from 'react';
import type { Readiness } from '../../main/checks.ts';
import { DependencyChecks, CheckAgain } from './DependencyChecks.tsx';
import { useChecks, type ChecksView } from '../state/useChecks.ts';
import { hasSeenFirstRun, markFirstRunSeen } from '../state/firstRun.ts';
import './FirstRun.css';

/** Whether the takeover should be shown at all, from the readiness alone
 *  plus one remembered bit. Pure and exported so the rule above is a thing
 *  tests can state, rather than a condition buried in a render. */
export function shouldTakeOver(readiness: Readiness | null, seenBefore: boolean): boolean {
  // Nothing to say until a sweep has finished. While one is still running
  // the app stays quiet rather than flashing a wall that vanishes a moment
  // later -- a full sweep is ~11s, almost all of it `codex doctor`.
  if (readiness === null) return false;
  const problems = readiness.checks.filter(c => c.state !== 'ok');
  if (problems.length === 0) return false;
  if (!seenBefore) return true;
  // The core is gone: no tmux means nothing can be launched or attached,
  // so the normal window would be entirely disabled controls.
  return !readiness.attach.available;
}

/** "Continue without Claude" when exactly one thing is wrong and naming it
 *  is useful; "Continue anyway" when several are, because a button that
 *  lists three names stops being a button. */
export function continueLabel(readiness: Readiness): string {
  const problems = readiness.checks.filter(c => c.state !== 'ok');
  return problems.length === 1 ? `Continue without ${problems[0]!.name}` : 'Continue anyway';
}

/** The heading, which counts rather than asserting. "Two things to install
 *  first" is the mockup's, and it is only true when two things are in fact
 *  missing. */
export function headline(readiness: Readiness): string {
  const problems = readiness.checks.filter(c => c.state !== 'ok');
  const missing = problems.filter(c => c.state === 'missing');
  if (missing.length === problems.length) {
    return missing.length === 1
      ? `One thing to install first`
      : `${missing.length === 2 ? 'Two' : String(missing.length)} things to install first`;
  }
  return problems.length === 1 ? 'One thing needs attention' : `${problems.length} things need attention`;
}

const INTRO =
  'Fleet drives the tools already on your Mac. It does not bundle them, and it never sees '
  + 'your account — you stay signed in as you already are.';

export function FirstRun({ checks, onContinue }: {
  /** Passed in rather than hooked here, so App drives one useChecks for
   *  both this and the launch bar's disabled state, and Check again on
   *  this screen updates both at once. */
  checks: ChecksView;
  onContinue: () => void;
}) {
  const { readiness } = checks;
  if (readiness === null) return null;

  return (
    <section className="firstrun" aria-label="What this app needs">
      <div className="takeover">
        <h3>{headline(readiness)}</h3>
        <p>{INTRO}</p>

        <DependencyChecks {...checks} showConsequences={false} />

        <div className="acts">
          <CheckAgain recheck={checks.recheck} rechecking={checks.rechecking} primary />
          <button type="button" className="btn quiet" onClick={onContinue}>
            {continueLabel(readiness)}
          </button>
          <small>You can reopen this from Settings.</small>
        </div>
      </div>
    </section>
  );
}

/** The takeover plus the remembering, as one thing App can render. Returns
 *  null when the rule says not to show it, so App's own render stays a
 *  single conditional. */
export function useFirstRun(checks: ChecksView): { showing: boolean; dismiss: () => void } {
  // Read once, at mount: a person who continues should not have the screen
  // re-evaluated out from under them mid-session by a recheck.
  const [seen, setSeen] = useState(hasSeenFirstRun);
  const [dismissedThisSession, setDismissed] = useState(false);

  const dismiss = () => {
    markFirstRunSeen();
    setSeen(true);
    // Also held in memory, because rule 2 (no tmux) would otherwise put the
    // wall straight back up the moment `seen` became true. Continue must
    // always get you into the app, whatever is missing -- the rule decides
    // what the NEXT launch does, never whether this click works.
    setDismissed(true);
  };

  return {
    showing: !dismissedThisSession && shouldTakeOver(checks.readiness, seen),
    dismiss,
  };
}
