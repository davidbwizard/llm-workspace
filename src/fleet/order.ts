/** The minimal shape this comparator reads, declared locally rather than
 *  imported from state.ts. That import was type-only and therefore erased at
 *  build, but it still created a state.ts <-> order.ts cycle that crashed the
 *  vitest worker at collection time (worker exits, 0 tests run, no assertion
 *  error -- an unusually silent failure mode). Declaring the shape here makes
 *  this module genuinely standalone, which is the point: it exists so the
 *  renderer can import it without dragging node:os and the database along.
 *  Structural typing means a real OpenSession satisfies it. */
export interface Orderable {
  pid: number;
  activity: string | null;
}

/** How open sessions are ordered, extracted from state.ts so the RENDERER can
 *  use it.
 *
 *  This is not tidiness. `src/fleet/state.ts` imports `node:os` (for
 *  `junkCwdKind`'s tmpdir check) and reaches the database through
 *  `store/signals.ts`. A sandboxed Electron renderer has neither, so a VALUE
 *  import of anything in that module throws at module-load time, React never
 *  mounts, and the window renders blank -- with nothing in the dev-server log,
 *  because the failure is in the renderer, not in main.
 *
 *  Vitest cannot catch that: it runs under Node, where `node:os` resolves
 *  perfectly well. The tests stayed green through exactly this bug. So the rule
 *  this file exists to enforce is structural rather than tested -- anything the
 *  renderer imports for its VALUE must live somewhere with no Node imports.
 *  The `OpenSession` import above is type-only and erased at build, which is
 *  why it is safe.
 *
 *  Junk-ness is passed IN rather than computed here for the same reason: it is
 *  the one input that needs `tmpdir()`. Main supplies the real predicate; the
 *  renderer supplies one that always answers false, because by the time an
 *  array reaches it, main has already ordered junk last and the renderer's
 *  index-based rank carries that ordering forward. */
export function compareRank(a: number | null, b: number | null): number {
  if (a === b) return 0;
  // A null rank means "unknown", which sorts after everything known rather
  // than colliding with 0 -- an unrankable session must never outrank a
  // genuinely-ranked one just because its value is missing.
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Tiers, highest first: junk last (unconditional), then blocked on the user,
 *  then unread, then the two supplied ranks, then pid.
 *
 *  `pid` is the final tiebreak so this is a TOTAL order. Without it, two
 *  sessions equal on every tier would compare inconsistently and the sort
 *  would be unstable -- cards visibly shuffling between renders on a list
 *  that is re-sorted on every fleet push. */
export function compareOpenSessions<T extends Orderable>(
  isJunk: (o: T) => boolean,
  primaryRank: (o: T) => number | null,
  secondaryRank: (o: T) => number | null,
  isUnread: (o: T) => boolean = () => false,
): (a: T, b: T) => number {
  return (a, b) => {
    // Coerced: this crosses the IPC boundary, and an absent field arrives as
    // undefined. `undefined !== false` is true, which would make the tier
    // misfire and sort an unmarked card above a marked-false one.
    const junkA = isJunk(a) === true;
    const junkB = isJunk(b) === true;
    if (junkA !== junkB) return junkA ? 1 : -1;

    const blockedA = a.activity === 'waiting_permission' || a.activity === 'waiting_input';
    const blockedB = b.activity === 'waiting_permission' || b.activity === 'waiting_input';
    if (blockedA !== blockedB) return blockedA ? -1 : 1;

    const unreadA = isUnread(a);
    const unreadB = isUnread(b);
    if (unreadA !== unreadB) return unreadA ? -1 : 1;

    const primaryDiff = compareRank(primaryRank(a), primaryRank(b));
    if (primaryDiff !== 0) return primaryDiff;
    const secondaryDiff = compareRank(secondaryRank(a), secondaryRank(b));
    if (secondaryDiff !== 0) return secondaryDiff;
    return a.pid - b.pid;
  };
}
