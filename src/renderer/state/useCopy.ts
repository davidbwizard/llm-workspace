// One-click copy that reports what actually happened.
//
// Lifted out of ConversationView.tsx's CopyButton (unchanged in behaviour)
// so the first-run screen's own Copy button cannot drift from it. The rule
// both share, and the reason this is a shared hook rather than two
// near-identical state machines: a copy that silently failed must never
// read as "Copied". Someone who believes the command is on their clipboard
// and pastes nothing is worse off than someone told plainly it did not
// work.
//
// navigator.clipboard is absent in jsdom and THROWS rather than rejecting
// in some browsers, so the call is wrapped in a resolved promise: both a
// throw and a rejection land in the same failure path.
import { useEffect, useRef, useState } from 'react';

export const COPY_LABEL = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' } as const;

export type CopyState = keyof typeof COPY_LABEL;

/** How long a settled state shows before returning to idle. */
const SETTLE_MS = 2000;

export function useCopy(): { state: CopyState; copy: (text: string) => void } {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);

  // Set on every mount, not just initialised: StrictMode (main.tsx) mounts,
  // unmounts and remounts in dev, and a flag only ever cleared stayed
  // false, so the copy ran but its result was never shown.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);

  const settle = (next: CopyState) => {
    if (!alive.current) return;
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (alive.current) setState('idle'); }, SETTLE_MS);
  };

  const copy = (text: string) => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => settle('copied'), (err: unknown) => {
        console.error('clipboard write failed:', err);
        settle('failed');
      });
  };

  return { state, copy };
}
