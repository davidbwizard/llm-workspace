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

/** The row key for a session pulled out of its folder by a category.
 *
 *  It CANNOT be the folder path: the folder key already belongs to whatever
 *  is left behind there, and two rows sharing a key would collide both in
 *  React's reconciler and in the stored order.
 *
 *  It is the PID rather than the session id, and that is load-bearing rather
 *  than arbitrary. A launch-time category is held against a pid and upgrades
 *  to a session-id assignment when discovery resolves it (Task 8). Keying
 *  this row by the session id would change the key at the exact moment of
 *  that upgrade -- React would unmount the card and mount a new one, and the
 *  row would lose its stored slot and jump to the end. The pid is the one
 *  handle that is the same on both sides of that transition.
 *
 *  It is still ephemeral, exactly as a `sid:` key would have been: rememberKeys
 *  forgets a `pid:` key once its row is gone, so a categorised row's position
 *  lasts the sitting and not a restart. That is correct -- the assignment it
 *  belongs to does not survive a restart either. */
export function pidRowKey(pid: number): string {
  return `pid:${pid}`;
}

/** A run of rows under one category name, or under none. */
export type RailSection<T> = { name: string | null; rows: RailRow<T>[] };

/** Every row of a folder stack, as its own row. What "stacking off" means:
 *  no collapsing, but sections and manual order still apply -- the setting
 *  governs folder stacking and nothing else.
 *
 *  A member CANNOT keep the folder key: its siblings would all claim the
 *  same one, and two rows with one key collide both in React's reconciler
 *  and in the stored order. pidRowKey is therefore the key -- the same
 *  helper a categorised row uses, so there is one answer to "what is a row
 *  that is not a folder called" rather than two that could drift.
 *
 *  That prefix is what makes groups.ts treat it as ephemeral, so an
 *  un-stacked folder's row positions last the sitting and not a restart.
 *  Inherent rather than a shortcut: once co-located sessions are not
 *  collapsed, there is no stable per-row identity left to store. A folder
 *  holding ONE session was never a stack, so it keeps its folder key and its
 *  position survives as it always did. */
function unstack<T extends Groupable>(row: RailRow<T>): RailRow<T>[] {
  if (row.kind === 'session') return [row];
  return row.members.map(m => ({ kind: 'session' as const, key: pidRowKey(m.pid), session: m }));
}

/** The whole rail layout, in one pure pass: pull out the categorised
 *  sessions, fold what is left by folder (unless stacking is off), put every
 *  row where the user has it, then split into sections.
 *
 *  CATEGORISING PULLS A SESSION OUT OF ITS STACK. A folder with three
 *  sessions, one of them filed under "Review", becomes a Review section
 *  holding that one card, plus a stack of the remaining two -- and if only
 *  one is left, a plain card, because groupByFolder never makes a stack of
 *  one. The rejected alternative was heading the whole stack with a category
 *  any member carries, which puts one row in two places at once.
 *
 *  Whether a session HAS a category is entirely `categoryOf`'s business --
 *  this function never reads a session id. That keeps the "which handle does
 *  a category hang off" question in one place (groups.ts's categoryForRow),
 *  which is what lets Task 8 add the pending-binding fallback without
 *  touching this transform at all.
 *
 *  The UNCATEGORISED section is always LAST and always unnamed. It is not an
 *  "Other" group: having no category is the normal state, and those rows must
 *  look exactly like the rail did before categories existed. It is omitted
 *  entirely when empty, so a fully filed rail shows no stray divider.
 *
 *  Pulled rows are ordered ahead of folder rows before applyStableOrder runs.
 *  That only decides where a BRAND-NEW key lands (every known key has a
 *  stored index), and the answer it gives is the right one: a section always
 *  sorts above the uncategorised rows, which is where it renders anyway.
 *
 *  `categoryOf` and `indexOf` are passed IN rather than read from the store,
 *  for the same reason junk-ness is passed into compareOpenSessions: this
 *  module must stay free of anything the renderer cannot import, and it keeps
 *  the function testable without a DOM or localStorage. */
export function railSections<T extends Groupable>(
  sessions: T[],
  categoryOf: (session: T) => string | null,
  indexOf: (key: string) => number,
  stacking: boolean,
): RailSection<T>[] {
  const pulled: RailRow<T>[] = [];
  const nameByKey = new Map<string, string>();
  const rest: T[] = [];

  for (const s of sessions) {
    const name = categoryOf(s);
    if (name === null || name === '') { rest.push(s); continue; }
    const key = pidRowKey(s.pid);
    pulled.push({ kind: 'session', key, session: s });
    nameByKey.set(key, name);
  }

  // groupByFolder runs either way, and its result is expanded afterwards
  // when stacking is off. That is not a detour: it is what gives "a folder
  // with one session" its folder key for free in both modes, with no second
  // pass counting how many sessions each cwd holds.
  const folderRows = groupByFolder(rest);
  const bodyRows = stacking ? folderRows : folderRows.flatMap(unstack);

  const rows = applyStableOrder([...pulled, ...bodyRows], indexOf);

  // Map preserves insertion order, which is what puts each section where its
  // first row sat -- the same trick groupByFolder uses for rows.
  const named = new Map<string, RailRow<T>[]>();
  const loose: RailRow<T>[] = [];
  for (const row of rows) {
    const name = nameByKey.get(row.key);
    if (name === undefined) { loose.push(row); continue; }
    const bucket = named.get(name);
    if (bucket) bucket.push(row);
    else named.set(name, [row]);
  }

  const sections: RailSection<T>[] = [];
  for (const [name, sectionRows] of named) sections.push({ name, rows: sectionRows });
  if (loose.length > 0) sections.push({ name: null, rows: loose });
  return sections;
}
