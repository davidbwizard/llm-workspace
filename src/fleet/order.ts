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

/** The minimal shape the grouping transform reads. Declared locally for the
 *  same reason Orderable above is: a type import from state.ts is erased at
 *  build but still creates a state.ts <-> order.ts cycle that crashes the
 *  vitest worker at collection time (worker exits, 0 tests run, no assertion
 *  error). Structural typing means a real OpenSession satisfies it. */
export interface Groupable {
  pid: number;
  cwd: string | null;
}

/** One row of the rail: either a lone session, or several sharing a folder. */
export type RailRow<T> =
  | { kind: 'session'; key: string; session: T }
  | { kind: 'stack'; key: string; cwd: string; members: T[] };

/** What a row is remembered by, across restarts and across a session's death.
 *  The folder, when there is one -- see the spec's identity ruling on why not
 *  the pid or the session id. A session with no cwd cannot be remembered at
 *  all, so it gets a pid key that is unique for this run and simply lands at
 *  the end of the order on the next one. */
export function rowKey(s: Groupable): string {
  return s.cwd !== null && s.cwd !== '' ? s.cwd : `pid:${s.pid}`;
}

/** Collapses sessions sharing a cwd into one row. PURE and storage-free: the
 *  caller has already sorted `sessions`, and this preserves that order both
 *  BETWEEN rows (a row sits where its first member sat) and WITHIN a stack
 *  (members keep their arrival order). So compareOpenSessions remains the one
 *  and only ordering concept -- there is no second comparator here to drift
 *  from it.
 *
 *  A folder with exactly one session stays a plain session row, never a stack
 *  of one: stacking exists to collapse a crowd, and a lidded single card
 *  would be one extra click for nothing.
 *
 *  A session with no cwd is never grouped -- not even with other cwd-less
 *  sessions, which have nothing in common beyond the app failing to read
 *  their folder. rowKey gives each its own pid key, so they stay separate. */
export function groupByFolder<T extends Groupable>(sessions: T[]): RailRow<T>[] {
  // Map preserves insertion order, which is what puts each row where its
  // first member sat -- no explicit position bookkeeping needed.
  const byKey = new Map<string, T[]>();
  for (const s of sessions) {
    const key = rowKey(s);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(s);
    else byKey.set(key, [s]);
  }

  const rows: RailRow<T>[] = [];
  for (const [key, members] of byKey) {
    const first = members[0];
    if (first === undefined) continue;
    if (members.length === 1) {
      rows.push({ kind: 'session', key, session: first });
    } else {
      // Every member of a multi-member bucket shares the cwd that keyed it,
      // and rowKey only buckets by cwd when it is a non-empty string -- a
      // pid key is unique per process, so it can never reach this branch.
      rows.push({ kind: 'stack', key, cwd: first.cwd as string, members });
    }
  }
  return rows;
}

/** Puts rows in the order the user has them, NOT the order activity suggests
 *  (spec: "not auto movement for the cards"). A session that starts waiting
 *  changes how its row looks, never where it is.
 *
 *  `indexOf` is passed IN rather than read from the store here for the same
 *  reason junk-ness is passed into compareOpenSessions: this module must stay
 *  free of anything the renderer cannot import, and it keeps the function
 *  testable without a DOM or localStorage.
 *
 *  Array.prototype.sort is stable, so rows whose key is unknown (all equal at
 *  MAX_SAFE_INTEGER) keep the relative order groupByFolder gave them -- which
 *  is compareOpenSessions' own. A brand-new row therefore lands where the
 *  comparator would have put it, once, and keeps that slot from then on. */
export function applyStableOrder<T>(
  rows: RailRow<T>[],
  indexOf: (key: string) => number,
): RailRow<T>[] {
  return [...rows].sort((a, b) => indexOf(a.key) - indexOf(b.key));
}
