// What this app needs on the machine, and whether it is there.
//
// Design: docs/superpowers/specs/2026-09-21-first-run-checks-design.md §5.
//
// DELIBERATELY PLAIN. The visual design for the first-run screen is being
// mocked up separately; this is the mechanism with the least presentation
// that satisfies §5, and it is structured so that a designed screen can
// replace this file alone. Nothing here probes, decides or spawns: it
// renders a Readiness that main produced (src/main/checks.ts) and calls
// recheck(). Swapping the visual layer touches no probe logic.
//
// The app installs nothing (§5): every missing dependency shows its exact
// command as copyable text, and that command is never executed by anything.
import { useState } from 'react';
import type { CheckState, DependencyCheck, Readiness } from '../../main/checks.ts';
// Values, so they come from the node-free core module -- importing a
// value out of src/main/checks.ts pulls node:child_process into this
// bundle, which only `npm run dist:mac` catches. See src/core/install.ts.
import { HOMEBREW_URL, routeIsRunnable, type InstallRoute } from '../../core/install.ts';
import type { ChecksStatus } from '../state/useChecks.ts';
import './DependencyChecks.css';

/** One word per state, so the four never read as the same thing. These are
 *  the four outcomes main keeps apart; collapsing any two of them here would
 *  throw away the distinction the probe went to the trouble of making. */
const STATE_LABEL: Record<CheckState, string> = {
  ok: 'Ready',
  unhealthy: 'Needs attention',
  missing: 'Not installed',
  timeout: 'No answer',
};

/** Plain text, never a colour alone -- the label above carries the state for
 *  anyone who cannot see the colour, and this is only the redundant cue. */
const STATE_CLASS: Record<CheckState, string> = {
  ok: 'ok', unhealthy: 'warn', missing: 'bad', timeout: 'warn',
};

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="checkcmd">
      <code>{command}</code>
      <button
        type="button"
        className="checkcopy"
        onClick={() => {
          // navigator.clipboard is absent in jsdom and can reject in a
          // page without focus. Either way the command is still on screen
          // as selectable text, so a failure costs nothing but the
          // confirmation.
          void navigator.clipboard?.writeText(command).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
            () => { /* the text is right there to select by hand */ },
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** How to get this, given what the machine actually has.
 *
 *  A `brew install ...` line is useless to someone without Homebrew, and
 *  printing it as though it would work is the kind of small dishonesty that
 *  makes a first-run screen untrustworthy. So:
 *
 *  - Routes this machine can run are shown as commands, best first.
 *  - When none of them can run, the routes are still SHOWN -- hiding them
 *    teaches nothing -- but under a line saying what they need first, with
 *    a link to Homebrew rather than Homebrew's own pipe-to-shell command.
 *
 *  The app installs nothing either way (§5): every command here is text
 *  with a copy button, and no channel exists that would run one. */
function InstallRoutes({ routes, homebrew }: { routes: InstallRoute[]; homebrew: boolean }) {
  const usable = routes.filter(route => routeIsRunnable(route, homebrew));
  // Nothing this machine can run: show everything, captioned honestly.
  const shown = usable.length > 0 ? usable : routes;

  return (
    <div className="checkinstall">
      {usable.length === 0 && (
        <p className="checkneeds">
          {shown.length === 1 ? 'This needs' : 'These need'} Homebrew, which this Mac
          does not have. You can get it from{' '}
          <a href={HOMEBREW_URL} target="_blank" rel="noreferrer">{HOMEBREW_URL}</a>.
        </p>
      )}
      {shown.map(route => (
        <div key={route.command}>
          <CopyCommand command={route.command} />
          {route.note !== null && <p className="checknote">{route.note}</p>}
        </div>
      ))}
    </div>
  );
}

function CheckRow({ check, homebrew }: { check: DependencyCheck; homebrew: boolean }) {
  const [showDoctor, setShowDoctor] = useState(false);
  const needsInstalling = check.state === 'missing';
  return (
    <li className="checkrow" data-state={check.state}>
      <div className="checkhead">
        <span className="checkname">{check.name}</span>
        <span className={`checkstate ${STATE_CLASS[check.state]}`}>{STATE_LABEL[check.state]}</span>
        {check.version !== null && <span className="checkversion">{check.version}</span>}
      </div>
      <p className="checkdetail">{check.detail}</p>
      <p className="checkpurpose">{check.purpose}</p>
      {/* §5: for anything missing, one line on what it is for and the exact
          command, copyable. Shown for "no answer" too -- a person whose tmux
          does not respond is equally stuck, and the command is the same one
          that reinstalls it. */}
      {(needsInstalling || check.state === 'timeout') && (
        <InstallRoutes routes={check.install} homebrew={homebrew} />
      )}
      {/* doctor's own words, verbatim, for the person to read. The app does
          not interpret them (design §3) -- it just hands them over. */}
      {check.doctor !== null && check.doctor.output.length > 0 && check.state !== 'ok' && (
        <div className="checkdoctor">
          <button type="button" className="checkdoctorbtn" aria-expanded={showDoctor}
            onClick={() => setShowDoctor(v => !v)}>
            {showDoctor ? 'Hide' : 'Show'} what {check.name} reported
          </button>
          {showDoctor && <pre className="checkdoctorout">{check.doctor.output}</pre>}
        </div>
      )}
    </li>
  );
}

/** A capability that is off, named with its reason. Disabled-with-a-reason
 *  beats hidden (design §4): a control that vanished teaches the person
 *  nothing, one that explains itself teaches them what to install. */
function Consequences({ readiness }: { readiness: Readiness }) {
  const off: string[] = [];
  if (!readiness.attach.available) off.push(`Starting and attaching to sessions: ${readiness.attach.reason}`);
  if (!readiness.launch.claude.available) off.push(`Launching Claude: ${readiness.launch.claude.reason}`);
  if (!readiness.launch.codex.available) off.push(`Launching Codex: ${readiness.launch.codex.reason}`);
  if (off.length === 0) return null;
  return (
    <div className="checkoff">
      <p className="checkofftitle">Turned off for now</p>
      <ul>{off.map(line => <li key={line}>{line}</li>)}</ul>
      {/* The whole point of §4: never refuse to start. */}
      <p className="checkoffnote">
        Everything already recorded stays readable, so you can still browse your history.
      </p>
    </div>
  );
}

export function DependencyChecks({ status, readiness, recheck, rechecking }: {
  status: ChecksStatus;
  readiness: Readiness | null;
  recheck: () => void;
  rechecking: boolean;
}) {
  return (
    <section className="checks" aria-label="What this app needs">
      <div className="checkstop">
        <p className="checksintro">
          This app runs agents in tmux and reads what they write. It never installs anything
          for you &mdash; when something is missing it shows the command and you run it.
        </p>
        <button type="button" className="checksagain" onClick={recheck} disabled={rechecking}>
          {rechecking ? 'Checking…' : 'Check again'}
        </button>
      </div>

      {status === 'unavailable' && (
        <p className="checkserror" role="alert">
          The app could not run these checks. Everything already recorded is still readable.
        </p>
      )}

      {readiness === null
        ? <p className="checksloading">Checking what is installed&hellip;</p>
        : (
          <>
            <ul className="checklist">
              {readiness.checks.map(c => (
                <CheckRow key={c.id} check={c} homebrew={readiness.homebrew} />
              ))}
            </ul>
            <Consequences readiness={readiness} />
            <p className="checkswhen">
              Last checked {new Date(readiness.checkedAt).toLocaleTimeString()}
            </p>
          </>
        )}
    </section>
  );
}
