import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { MainPane } from './components/MainPane.tsx';
import { LaunchBar } from './components/LaunchBar.tsx';
import { FirstRun, useFirstRun } from './components/FirstRun.tsx';
import { useChecks } from './state/useChecks.ts';
import { useFleet } from './state/useFleet.ts';
import { useSettings } from './state/settings.ts';
import { useRailSlots, mostUrgentMember } from './state/useRailSlots.ts';
import { isStackOpen, toggleStack } from './state/groups.ts';

interface ErrorBoundaryState { error: Error | null; componentStack: string | null }

// An uncaught render throw with no boundary anywhere in src/renderer
// produces a BLANK WINDOW with the error only in devtools -- the same
// failure shape as the black-on-black shell (Task 5) and the eternal
// loading state (fix round 1): it looks like nothing is wrong. This stays
// deliberately minimal: no retry button, no logging service, no recovery
// logic, no payload validation upstream (the producer is our own
// well-tested main process; a validator there is speculative work this
// task doesn't own). Exported so tests/renderer/App.test.tsx can exercise
// it directly with a throwing child, without needing FleetView itself to
// throw.
//
// componentDidCatch used to be empty ("no logging service") -- that traded
// away the one thing this boundary exists to preserve: WHERE the throw
// happened. A symptom with no location is exactly the failure mode this
// app exists to eliminate for provider sessions; it must not reproduce
// that failure mode for itself. No logging *service* is added here (still
// out of scope) -- this only keeps what React already hands
// componentDidCatch, in two places a person can actually read without
// devtools: the main process's log (console.error, which Electron mirrors
// to its own stdout/log file even when devtools isn't open) and the
// window itself (rendered below), so the fault can be located from
// whichever of the two is at hand.
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- the deliberate record this
    // boundary exists to keep; see the class doc comment above.
    console.error('FleetView render crashed:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      // Same style as FleetView's other two error states (missing preload,
      // failed IPC load): a specific message built from the real error,
      // not a generic "something went wrong". The stack and component
      // stack are appended below the message, not swapped in for it --
      // stack traces are the SECOND thing a person reads, after knowing
      // what broke.
      return (
        <div className="empty error">
          <p>Something went wrong rendering the fleet view:
            {' '}{this.state.error.message}</p>
          <pre className="crash-stack">
            {this.state.error.stack}
            {this.state.componentStack ? `\n${this.state.componentStack}` : ''}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Owns the one gate on whether the index is ready to show at all (bridge
 *  missing, still loading, load failed) -- MainPane's own contract takes a
 *  concrete `sessions: OpenSession[]`, not a nullable payload, precisely so
 *  it never has to re-derive "is this even loaded yet" itself (the same
 *  three states FleetView used to guard on its own, before it became one
 *  branch inside MainPane instead of everything App rendered). */
export function App() {
  const { payload, error, selection, select, setView, clear } = useFleet();
  const settings = useSettings();
  // One useChecks for the whole window: the launch bar's disabled state and
  // the first-run screen read the same sweep, so Check again on that screen
  // updates the bar behind it in the same commit.
  const checks = useChecks();
  const firstRun = useFirstRun(checks);

  // Cmd+1..9 addresses SLOTS, not sessions (David's own model: "slot 1 is
  // always slot 1... if a card in slot one moves, slot 1 stays as slot 1").
  // useRailSlots is the ONE computation behind both this and the small
  // hotkey number every card shows (rail and grid alike) -- see that hook's
  // own doc comment for why splitting this into two independent rankings is
  // exactly how the old version of this drifted. Called with `[]` while the
  // index is still loading, rather than skipping the call: React's Rules of
  // Hooks forbid calling it only after the early returns below.
  const { rows, slotByPid: cmdIndexByPid } = useRailSlots(payload?.openSessions ?? []);

  // What FleetView's grid maps over in place of raw payload.openSessions
  // (MainPane, below) -- the SAME row order the rail renders, flattened,
  // stack members sitting adjacent under their shared number. Rendering the
  // grid's own stack chrome is separate, neglected-view work and stays out
  // of scope; this only stops the grid's ordinary cards from contradicting
  // the rail about order and numbering.
  const orderedSessions = rows.flatMap(r => (r.kind === 'session' ? [r.session] : r.members));

  // Latest-value refs, not effect dependencies: the listener below is
  // installed exactly once, for the component's whole lifetime (its own
  // effect has an empty dependency array), and reads through these instead
  // of closing over a stale rows/select from whichever render happened to
  // run when it was attached.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectRef = useRef(select);
  selectRef.current = select;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // Meta alone -- Ctrl/Alt/Shift riding along means something else
      // entirely (a browser/OS chord, or nothing this app defines).
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const digit = Number(e.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;
      // Ignored, not clamped: with fewer rows than the digit pressed, there
      // is no Nth row (slot) to select. This also drops the old "9 always
      // selects the last session" special case -- under slots that would
      // mean Cmd+9 selects something OTHER than whatever card is showing
      // "9" once there are more than nine rows, which is exactly the
      // card's-number-disagrees-with-what-the-chord-does bug this whole
      // change exists to close. Slot 9 is now just slot 9, like every
      // other digit.
      const row = rowsRef.current[digit - 1];
      if (row === undefined) return;
      // A plain row selects its one session; a stack row selects whichever
      // member most needs you (mostUrgentMember, useRailSlots.ts) and opens
      // the stack if it was folded, so the chord never lands somewhere the
      // user cannot see. The undefined case is unreachable in practice
      // (groupByFolder never produces an empty stack) but is still real to
      // the type checker (noUncheckedIndexedAccess).
      const target = row.kind === 'session' ? row.session : mostUrgentMember(row.members);
      if (target === undefined) return;
      // preventDefault only now that this has actually acted -- an ignored
      // chord (too few rows, or one this handler doesn't own) must not
      // swallow whatever the OS or the page would otherwise do with it.
      e.preventDefault();
      if (row.kind === 'stack' && !isStackOpen(row.cwd)) toggleStack(row.cwd);
      // The same select() a card click uses -- always resets the view to
      // Conversation (useFleet.ts's own select), never straight to the
      // Terminal one.
      selectRef.current(target.pid);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // 'system' means NO attribute at all: theme.css's light palette is
    // guarded as :root:not([data-theme="dark"]) inside a
    // prefers-color-scheme query, so the OS setting only wins while
    // nothing explicit is stamped on the root.
    if (settings.appearance === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.appearance);
    // Best-effort, like every other bridge call in this tree: a missing
    // preload leaves the page correctly themed and only the window chrome
    // behind, which is better than throwing at mount.
    void window.fleet?.setTheme(settings.appearance);
  }, [settings.appearance]);

  // A freshly launched or reattached session answers the trust/resume
  // prompt in its OWN terminal (spec: no blind Enter, the person answers
  // it) -- so opening straight into 'conversation' would show nothing
  // useful. select() always defaults to 'conversation'; setView() flips the
  // just-created selection to 'terminal' in the same handler, and React 18
  // batches both updates into one commit.
  function openInTerminal(pid: number): void {
    select(pid);
    setView('terminal');
  }

  if (!window.fleet) {
    return (
      <main className="shell">
        <p className="empty error">The preload script did not load, so this window
          has no connection to the session index. Restart the app; if this keeps happening,
          check the main process log for a preload error.</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="shell">
        <p className="empty error">The session index could not be loaded: {error}</p>
      </main>
    );
  }

  if (payload === null) {
    return <main className="shell"><p className="empty">Reading the index…</p></main>;
  }

  // Layout A: the window opens to the first-run screen and nothing else
  // until they continue, with the launch bar visible above it and inert.
  // FirstRun.tsx's own header states when this is allowed to happen and
  // why -- in particular, it is NOT every launch with something missing.
  return (
    <main className="shell">
      <LaunchBar onLaunched={openInTerminal} disabled={firstRun.showing} />
      {firstRun.showing
        ? <FirstRun checks={checks} onContinue={firstRun.dismiss} />
        : (
          <ErrorBoundary>
            <MainPane
              selection={selection}
              sessions={payload.openSessions}
              orderedSessions={orderedSessions}
              onSelect={select}
              onSetView={setView}
              onClear={clear}
              railSide="left"
              cmdIndexByPid={cmdIndexByPid}
            />
          </ErrorBoundary>
        )}
    </main>
  );
}
