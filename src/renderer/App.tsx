import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FleetView } from './components/FleetView.tsx';
import { useFleet } from './state/useFleet.ts';

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

// Interim wiring for Task 7's hoist: useFleet() is now the one subscription
// to fleet:list/fleet:update, and FleetView is just its first consumer. The
// rail/pane split that actually uses `selection` (SessionRail,
// ConversationView, ReplyPopover) is Task 12's MainPane, not built yet --
// until then FleetView keeps rendering the full grid and `selection` sits
// unused here, same as it would on a Game view before Game exists.
export function App() {
  const { payload, error, select } = useFleet();
  return (
    <main className="shell">
      <ErrorBoundary><FleetView payload={payload} error={error} onSelect={select} /></ErrorBoundary>
    </main>
  );
}
