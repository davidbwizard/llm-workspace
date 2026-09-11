import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FleetView } from './components/FleetView.tsx';

interface ErrorBoundaryState { error: Error | null }

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
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  // Deliberately empty beyond satisfying the boundary contract -- no
  // logging service per scope (see the comment above).
  componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  render() {
    if (this.state.error) {
      // Same style as FleetView's other two error states (missing preload,
      // failed IPC load): a specific message built from the real error,
      // not a generic "something went wrong".
      return <p className="empty error">Something went wrong rendering the fleet view:
        {' '}{this.state.error.message}</p>;
    }
    return this.props.children;
  }
}

export function App() {
  return <main className="shell"><ErrorBoundary><FleetView /></ErrorBoundary></main>;
}
