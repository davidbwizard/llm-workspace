// What this app needs on the machine, and whether it is there.
//
// Design: docs/superpowers/specs/2026-09-21-first-run-checks-design.md §5.
// Presentation ported from the approved mockup, option A
// (claude.ai/artifact/JBHq1Sko5Sd7aaGpJj1Gyc): the `.dep` / `.cmd` markup
// and the three state marks, read from its CSS rather than inferred from
// the picture.
//
// This is the list alone. Where it SITS is FirstRun.tsx's job (the takeover)
// or SettingsModal's (reopened later) -- the mockup's own note is that the
// list is identical either way and option A is about placement. Nothing
// here probes, decides or spawns: it renders a Readiness that main produced
// (src/main/checks.ts) and calls recheck().
import { useState } from 'react';
import type { CheckState, DependencyCheck, Readiness } from '../../main/checks.ts';
// Values, so they come from the node-free core module -- importing a
// value out of src/main/checks.ts pulls node:child_process into this
// bundle, which only `npm run dist:mac` catches. See src/core/install.ts.
import { HOMEBREW_URL, routeIsRunnable, type InstallRoute } from '../../core/install.ts';
import { StateMark, STATE_NAME } from './StateMark.tsx';
import { useCopy, COPY_LABEL } from '../state/useCopy.ts';
import type { ChecksStatus } from '../state/useChecks.ts';
import './DependencyChecks.css';

/** The mockup's `.cmd` row: the command, and a button that says what
 *  actually happened. The state machine is the one ConversationView's own
 *  Copy button uses (state/useCopy.ts) -- a failed write says so and logs
 *  why, and never reads as "Copied". The command stays selectable text, so
 *  a machine with no clipboard API is not stuck either. */
function CopyCommand({ command }: { command: string }) {
  const { state, copy } = useCopy();
  return (
    <div className="cmd">
      <code>{command}</code>
      <button
        type="button"
        data-state={state}
        onClick={() => copy(command)}
        aria-label={state === 'idle' ? `Copy ${command}` : COPY_LABEL[state]}
      >
        {COPY_LABEL[state]}
      </button>
    </div>
  );
}

/** How to get this, given what the machine actually has.
 *
 *  A `brew install ...` line is useless to someone without Homebrew, and
 *  printing it as though it would work is the kind of small dishonesty
 *  that makes a first-run screen untrustworthy. So routes this machine can
 *  run are shown as commands; when none can, they are still shown -- hiding
 *  them teaches nothing -- under a line saying what they need first, with a
 *  link to Homebrew rather than Homebrew's own pipe-to-shell installer.
 *
 *  The app installs nothing either way (§5): every command here is text
 *  with a copy button, and no channel exists that would run one. */
function InstallRoutes({ routes, homebrew }: { routes: InstallRoute[]; homebrew: boolean }) {
  const usable = routes.filter(route => routeIsRunnable(route, homebrew));
  const shown = usable.length > 0 ? usable : routes;
  return (
    <>
      {usable.length === 0 && (
        <p className="needs">
          {shown.length === 1 ? 'This needs' : 'These need'} Homebrew, which this Mac does
          not have. You can get it from{' '}
          <a href={HOMEBREW_URL} target="_blank" rel="noreferrer">{HOMEBREW_URL}</a>.
        </p>
      )}
      {shown.map(route => (
        <CopyCommand key={route.command} command={route.command} />
      ))}
      {shown.some(r => r.note !== null) && (
        <p className="note">{shown.find(r => r.note !== null)!.note}</p>
      )}
    </>
  );
}

/** One row. The mockup's grid is `auto 1fr auto` with the mark in column
 *  one and everything else spanning from column two, so the text lines up
 *  under the name rather than under the mark. */
function CheckRow({ check, homebrew }: { check: DependencyCheck; homebrew: boolean }) {
  const [showDoctor, setShowDoctor] = useState(false);
  return (
    // `.bad` is the mockup's critical-toned row, and it is for MISSING
    // alone. An unhealthy or timed-out tool is present, and colouring it
    // like an absent one would undo the distinction the probe went to the
    // trouble of making.
    <div className={`dep${check.state === 'missing' ? ' bad' : ''}`} data-state={check.state}>
      <StateMark state={check.state} />
      <b>
        {check.name}
        {check.version !== null && <span className="ver">{check.version}</span>}
      </b>
      <p>
        {/* The state's own sentence, then what the thing is for. A row that
            is fine needs only the second: "tmux is installed and ready" adds
            nothing to a tick that already says so. */}
        {check.state !== 'ok' && <span className="say">{check.detail} </span>}
        {check.purpose}
      </p>

      {check.state === 'missing' && <InstallRoutes routes={check.install} homebrew={homebrew} />}

      {/* Deliberately no install command for "no answer". A probe that timed
          out says the app could not CONFIRM the tool, not that it is absent
          -- the likeliest case is that it is installed and merely slow, and
          an install command under those words is how a timeout gets read as
          missing. The honest action is to check again, which is a button
          away, or to run the same command yourself. */}
      {check.state === 'timeout' && (
        <p className="unknown">
          This does not mean {check.name} is missing &mdash; only that it did not answer in
          time. Check again, or run <code>{check.probe}</code> yourself.
        </p>
      )}

      {/* doctor's own words, verbatim, for the person to read. The app does
          not interpret them (design §3) -- it hands them over. */}
      {check.doctor !== null && check.doctor.output.length > 0 && check.state !== 'ok' && (
        <div className="doc">
          <button type="button" className="link" aria-expanded={showDoctor}
            onClick={() => setShowDoctor(v => !v)}>
            {showDoctor ? 'Hide' : 'Show'} what {check.name} reported
          </button>
          {showDoctor && <pre>{check.doctor.output}</pre>}
        </div>
      )}
    </div>
  );
}

/** A capability that is off, named with its reason. Disabled-with-a-reason
 *  beats hidden (design §4): a control that vanished teaches the person
 *  nothing, one that explains itself teaches them what to install. */
export function Consequences({ readiness }: { readiness: Readiness }) {
  const off: string[] = [];
  if (!readiness.attach.available) off.push(`Starting and attaching to sessions: ${readiness.attach.reason}`);
  if (!readiness.launch.claude.available) off.push(`Launching Claude: ${readiness.launch.claude.reason}`);
  if (!readiness.launch.codex.available) off.push(`Launching Codex: ${readiness.launch.codex.reason}`);
  if (off.length === 0) return null;
  return (
    <div className="off">
      <p className="offtitle">Turned off for now</p>
      <ul>{off.map(line => <li key={line}>{line}</li>)}</ul>
      {/* The whole point of §4: never refuse to start. */}
      <p className="offnote">Everything already recorded stays readable, so you can still browse your history.</p>
    </div>
  );
}

/** Just the list. `title`/`intro`/`actions` are the frame around it, which
 *  differs between the takeover and Settings -- passed in rather than
 *  branched on here, so this component never knows where it is. */
export function DependencyChecks({ status, readiness, recheck, rechecking, showConsequences = true }: {
  status: ChecksStatus;
  readiness: Readiness | null;
  recheck: () => void;
  rechecking: boolean;
  showConsequences?: boolean;
}) {
  if (status === 'unavailable' && readiness === null) {
    return (
      <p className="checkserror" role="alert">
        The app could not run these checks. Everything already recorded is still readable.
      </p>
    );
  }
  if (readiness === null) return <p className="checksloading">Checking what is installed&hellip;</p>;

  return (
    <>
      <div className="checks">
        {readiness.checks.map(c => (
          <CheckRow key={c.id} check={c} homebrew={readiness.homebrew} />
        ))}
      </div>
      {showConsequences && <Consequences readiness={readiness} />}
    </>
  );
}

/** The Check again button (design §5: re-runs without a restart, so a
 *  person can fix something in a terminal and carry on). Exported on its
 *  own because the takeover puts it in a footer beside other actions and
 *  Settings puts it above the list. */
export function CheckAgain({ recheck, rechecking, primary = false }: {
  recheck: () => void;
  rechecking: boolean;
  primary?: boolean;
}) {
  return (
    <button type="button" className={`btn${primary ? ' primary' : ''}`}
      onClick={recheck} disabled={rechecking}>
      {rechecking ? 'Checking…' : 'Check again'}
    </button>
  );
}

export { STATE_NAME, type CheckState };
