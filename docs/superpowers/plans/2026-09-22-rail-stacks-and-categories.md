# Rail Stacks and Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions sharing a folder collapse into one rail row that opens in place and stays open; any single session can be filed under a name David chose, from the card menu or as it launches; and rows sit where David put them, moved by drag or by keyboard. A setting turns folder stacking off — and folder stacking only: categories and manual order apply either way.

**Architecture:** Two keys, deliberately different, and the spec's identity ruling is why. Stack membership and row position are keyed by **absolute folder path**, which survives a restart, a `/clear` and a pid recycle. Category **assignments** are keyed by **session id**, which survives none of those — that is the point: an assignment is scoped to one sitting, and pruning it against the live session list on every fleet push is what makes `/clear` and session exit drop a session out of its category with no bookkeeping. Category **names** are a separate persisted list with a separate lifetime: a name outlives every assignment that ever pointed at it, which is the only way "deletable if not attached to a session" can mean anything.

One new renderer store (`src/renderer/state/groups.ts`) holds all four persisted things — names, assignments, row order, open stacks — cloning `favourites.ts`'s proven shape. It also holds one thing that is deliberately NOT persisted: a launch-time category held against a pid until discovery resolves that pid to a session id. That is a handoff, not storage, and the pid is acceptable there and nowhere else because the app spawned that exact process and the binding lives seconds to minutes. Every pure transform lives in `src/fleet/order.ts`, which is deliberately free of Node imports so the renderer can import it for its value.

**Tech Stack:** TypeScript, React 18 (`useSyncExternalStore`, no state library, no context provider), Vitest + Testing Library, plain global CSS, native HTML5 drag events.

**Spec:** `docs/superpowers/specs/2026-09-22-rail-stacks-and-categories.md`

## Global Constraints

- **Cap test workers.** Run `npx vitest run --maxWorkers=2 --minWorkers=1` — **both bounds**, or vitest errors and prints `Test Files no tests`, which reads like a pass. `--poolOptions.threads.*` caps nothing here (this repo sets no pool; vitest 2.x defaults to forks).
- **No Node imports in anything the renderer imports for its value.** `src/fleet/state.ts` imports `node:os` and reaches the database. A value import of it from the renderer throws at module load, React never mounts, and the window renders blank **with nothing in the dev-server log**. Vitest cannot catch this — it runs under Node, where `node:os` resolves fine. Type-only imports (`import type`) are erased at build and are safe.
- **`@testing-library/user-event` is NOT a dependency of this project.** Every renderer test drives interaction through `fireEvent` (see the note at the top of `tests/renderer/SessionRail.test.tsx`). Any step below that appears to want `userEvent.click`/`userEvent.type` is written with `fireEvent` instead. Do not add the package.
- **No drag library.** A vertical list of ten rows does not justify a dependency. Native `draggable`/`dragstart`/`dragover`/`drop` only.
- **Every localStorage read and write is wrapped in try/catch** and validated on read, not just on write. A stored value may have been written by an older version or edited by hand.
- **Stores expose a `reload*()` function** for tests, which write localStorage directly and need the module singleton to see it.
- **Plain text only in UI copy and test names.** No emoji.
- Existing suite is 2696 tests, typecheck clean. Both must stay that way.

---

### Task 1: The groups store

**Files:**
- Create: `src/renderer/state/groups.ts`
- Test: `tests/renderer/groups.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GROUPS_STORAGE_KEY`, `MAX_CATEGORY_LENGTH`, `MAX_CATEGORIES`, `type GroupsState = { categories: string[]; assignments: Record<string,string>; order: string[]; open: string[] }`, `DEFAULT_GROUPS`, `normalizeGroups(raw: unknown): GroupsState`, `getGroups(): GroupsState`, `categoryNames(): string[]`, `categoryOfSession(sessionId: string): string | null`, `assignCategory(sessionId: string, name: string | null): void`, `renameCategory(from: string, to: string): string | null`, `deleteCategory(name: string): boolean`, `categoryInUse(name: string): boolean`, `pruneAssignments(liveSessionIds: string[]): void`, `isStackOpen(folder: string): boolean`, `toggleStack(folder: string): void`, `orderIndex(key: string): number`, `rememberKeys(keys: string[]): void`, `moveRow(key: string, targetKey: string): void`, `subscribeGroups(l: () => void): () => void`, `reloadGroups(): void`, `useGroups(): GroupsState`.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/groups.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GROUPS_STORAGE_KEY, MAX_CATEGORY_LENGTH, MAX_CATEGORIES, DEFAULT_GROUPS, normalizeGroups,
  getGroups, categoryNames, categoryOfSession, assignCategory, renameCategory, deleteCategory,
  categoryInUse, pruneAssignments, isStackOpen, toggleStack, orderIndex, rememberKeys, moveRow,
  subscribeGroups, reloadGroups,
} from '../../src/renderer/state/groups.ts';

// A module-scoped singleton, the same shape settings.ts and favourites.ts
// already use -- clearing localStorage alone leaves the in-memory value
// untouched, so every test also reloads it.
beforeEach(() => {
  localStorage.clear();
  reloadGroups();
});

describe('normalizeGroups', () => {
  it('returns the default for anything that is not a plain object', () => {
    expect(normalizeGroups(null)).toEqual(DEFAULT_GROUPS);
    expect(normalizeGroups([])).toEqual(DEFAULT_GROUPS);
    expect(normalizeGroups('x')).toEqual(DEFAULT_GROUPS);
  });

  it('keeps category names as trimmed, deduped, non-empty strings in the order stored', () => {
    const got = normalizeGroups({ categories: ['  Fleet  ', 'Review', 'Fleet', '', 7, null] });
    expect(got.categories).toEqual(['Fleet', 'Review']);
  });

  it('caps a name at MAX_CATEGORY_LENGTH and the list at MAX_CATEGORIES', () => {
    const long = 'x'.repeat(MAX_CATEGORY_LENGTH + 10);
    expect(normalizeGroups({ categories: [long] }).categories[0]).toHaveLength(MAX_CATEGORY_LENGTH);
    const many = Array.from({ length: MAX_CATEGORIES + 5 }, (_, i) => `c${i}`);
    expect(normalizeGroups({ categories: many }).categories).toHaveLength(MAX_CATEGORIES);
  });

  // The one invariant that keeps a section header from naming a category
  // the app does not have: every assignment value is a name in the list.
  it('drops an assignment whose name is not in the category list', () => {
    const got = normalizeGroups({
      categories: ['Fleet'],
      assignments: { 's1': 'Fleet', 's2': 'Gone', 's3': 7, '': 'Fleet' },
    });
    expect(got.assignments).toEqual({ s1: 'Fleet' });
  });

  it('keeps order as deduped non-empty strings, first occurrence winning', () => {
    expect(normalizeGroups({ order: ['/a', '/b', '/a', '', 3] }).order).toEqual(['/a', '/b']);
  });

  it('keeps open as deduped absolute paths', () => {
    expect(normalizeGroups({ open: ['/a', '/a', 'rel', null] }).open).toEqual(['/a']);
  });
});

describe('category names and assignments', () => {
  it('creates the name on first assignment, and reads it back by session id', () => {
    assignCategory('s1', 'Fleet');
    expect(categoryOfSession('s1')).toBe('Fleet');
    expect(categoryNames()).toEqual(['Fleet']);
  });

  it('returns null for a session that has none', () => {
    expect(categoryOfSession('nope')).toBeNull();
  });

  it('holds ONE category per session -- a second assignment replaces the first', () => {
    assignCategory('s1', 'Fleet');
    assignCategory('s1', 'Review');
    expect(categoryOfSession('s1')).toBe('Review');
    expect(categoryNames()).toEqual(['Fleet', 'Review']);
  });

  it('clears the assignment on null or a blank name, and LEAVES the name standing', () => {
    assignCategory('s1', 'Fleet');
    assignCategory('s1', null);
    expect(categoryOfSession('s1')).toBeNull();
    expect(categoryNames()).toEqual(['Fleet']);
    assignCategory('s1', 'Fleet');
    assignCategory('s1', '   ');
    expect(categoryOfSession('s1')).toBeNull();
  });

  it('trims and caps an assigned name, so the list and the assignment agree', () => {
    assignCategory('s1', `  ${'y'.repeat(MAX_CATEGORY_LENGTH + 4)}  `);
    expect(categoryOfSession('s1')).toHaveLength(MAX_CATEGORY_LENGTH);
    expect(categoryNames()).toEqual([categoryOfSession('s1')]);
  });

  it('ignores an empty session id, which no live session ever has', () => {
    assignCategory('', 'Fleet');
    expect(categoryNames()).toEqual([]);
  });

  it('refuses a brand-new name once MAX_CATEGORIES is reached, keeping the existing ones', () => {
    for (let i = 0; i < MAX_CATEGORIES; i++) assignCategory(`s${i}`, `c${i}`);
    assignCategory('over', 'one more');
    expect(categoryNames()).toHaveLength(MAX_CATEGORIES);
    expect(categoryOfSession('over')).toBeNull();
  });

  it('persists across a reload', () => {
    assignCategory('s1', 'Fleet');
    reloadGroups();
    expect(categoryOfSession('s1')).toBe('Fleet');
    expect(categoryNames()).toEqual(['Fleet']);
  });
});

describe('renaming a category', () => {
  it('rewrites every assignment pointing at the old name, so nothing is orphaned', () => {
    assignCategory('s1', 'Fleet');
    assignCategory('s2', 'Fleet');
    assignCategory('s3', 'Review');
    expect(renameCategory('Fleet', 'Shipping')).toBe('Shipping');
    expect(categoryOfSession('s1')).toBe('Shipping');
    expect(categoryOfSession('s2')).toBe('Shipping');
    expect(categoryOfSession('s3')).toBe('Review');
  });

  it('keeps the name in its old slot, so the menu does not reshuffle under the click', () => {
    assignCategory('s1', 'Fleet');
    assignCategory('s2', 'Review');
    renameCategory('Fleet', 'Shipping');
    expect(categoryNames()).toEqual(['Shipping', 'Review']);
  });

  it('trims and caps the new name', () => {
    assignCategory('s1', 'Fleet');
    expect(renameCategory('Fleet', '  Shipping  ')).toBe('Shipping');
  });

  it('refuses a blank new name, an unknown old name, and a name already taken', () => {
    assignCategory('s1', 'Fleet');
    assignCategory('s2', 'Review');
    expect(renameCategory('Fleet', '   ')).toBeNull();
    expect(renameCategory('Nothing', 'Shipping')).toBeNull();
    // Refused rather than merged: folding two categories into one is a
    // different decision from renaming, and it is not reversible.
    expect(renameCategory('Fleet', 'Review')).toBeNull();
    expect(categoryNames()).toEqual(['Fleet', 'Review']);
  });

  it('accepts renaming a name to itself as a no-op rather than a collision', () => {
    assignCategory('s1', 'Fleet');
    expect(renameCategory('Fleet', 'Fleet')).toBe('Fleet');
    expect(categoryNames()).toEqual(['Fleet']);
  });
});

describe('deleting a category', () => {
  it('refuses while a session still holds the name, and says so through categoryInUse', () => {
    assignCategory('s1', 'Fleet');
    expect(categoryInUse('Fleet')).toBe(true);
    expect(deleteCategory('Fleet')).toBe(false);
    expect(categoryNames()).toEqual(['Fleet']);
  });

  it('deletes once nothing holds it -- the name outlives its assignments', () => {
    assignCategory('s1', 'Fleet');
    assignCategory('s1', null);
    expect(categoryInUse('Fleet')).toBe(false);
    expect(deleteCategory('Fleet')).toBe(true);
    expect(categoryNames()).toEqual([]);
  });

  it('deletes a name whose only session was pruned away', () => {
    assignCategory('s1', 'Fleet');
    pruneAssignments(['s2']);
    expect(deleteCategory('Fleet')).toBe(true);
  });

  it('returns false for a name it does not have', () => {
    expect(deleteCategory('Nothing')).toBe(false);
  });
});

describe('pruning assignments against the live sessions', () => {
  it('drops an assignment whose session is no longer live, keeping the live ones', () => {
    assignCategory('s1', 'Fleet');
    assignCategory('s2', 'Fleet');
    pruneAssignments(['s2']);
    expect(categoryOfSession('s1')).toBeNull();
    expect(categoryOfSession('s2')).toBe('Fleet');
  });

  it('keeps the category NAME even when its last assignment is pruned', () => {
    assignCategory('s1', 'Fleet');
    pruneAssignments(['s2']);
    expect(categoryNames()).toEqual(['Fleet']);
  });

  // This is the whole of "it can be temp": /clear mints a session id that
  // was never assigned, so the old id simply stops being live.
  it('drops a cleared session, because its new id was never assigned', () => {
    assignCategory('old-id', 'Fleet');
    pruneAssignments(['new-id']);
    expect(categoryOfSession('old-id')).toBeNull();
    expect(categoryOfSession('new-id')).toBeNull();
  });

  it('does nothing at all on an empty live list, which also means "not discovered yet"', () => {
    assignCategory('s1', 'Fleet');
    pruneAssignments([]);
    expect(categoryOfSession('s1')).toBe('Fleet');
  });

  it('does not write when every assignment is already live', () => {
    assignCategory('s1', 'Fleet');
    const before = localStorage.getItem(GROUPS_STORAGE_KEY);
    pruneAssignments(['s1']);
    expect(localStorage.getItem(GROUPS_STORAGE_KEY)).toBe(before);
  });
});

describe('stack open state', () => {
  it('is closed until toggled, and persists across a reload', () => {
    expect(isStackOpen('/a')).toBe(false);
    toggleStack('/a');
    expect(isStackOpen('/a')).toBe(true);
    reloadGroups();
    expect(isStackOpen('/a')).toBe(true);
  });

  it('toggles back closed', () => {
    toggleStack('/a');
    toggleStack('/a');
    expect(isStackOpen('/a')).toBe(false);
  });
});

describe('row order', () => {
  it('reports a very large index for a key it has never seen', () => {
    expect(orderIndex('/unseen')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('appends unseen keys in the order given and keeps their slots', () => {
    rememberKeys(['/a', '/b']);
    expect(orderIndex('/a')).toBe(0);
    expect(orderIndex('/b')).toBe(1);
    rememberKeys(['/b', '/a', '/c']);
    expect(orderIndex('/a')).toBe(0);
    expect(orderIndex('/b')).toBe(1);
    expect(orderIndex('/c')).toBe(2);
  });

  it('keeps a folder key whose sessions have all gone away', () => {
    rememberKeys(['/a', '/b']);
    rememberKeys(['/a']);
    expect(orderIndex('/b')).toBe(1);
  });

  // A pid: key names one process and can never come back, so keeping it
  // would grow this blob forever. A folder key is never dropped.
  it('forgets a pid key once its row is gone, and keeps the folder keys', () => {
    rememberKeys(['/a', 'pid:7', 'pid:8']);
    expect(orderIndex('pid:7')).toBe(1);
    rememberKeys(['/a']);
    expect(orderIndex('pid:7')).toBe(Number.MAX_SAFE_INTEGER);
    expect(orderIndex('pid:8')).toBe(Number.MAX_SAFE_INTEGER);
    expect(orderIndex('/a')).toBe(0);
  });

  it('does not write when nothing is added and nothing is dropped', () => {
    rememberKeys(['/a']);
    const before = localStorage.getItem(GROUPS_STORAGE_KEY);
    rememberKeys(['/a']);
    expect(localStorage.getItem(GROUPS_STORAGE_KEY)).toBe(before);
  });
});

describe('moveRow', () => {
  beforeEach(() => { rememberKeys(['/a', '/b', '/c', '/d']); });

  it('moves a row down into the slot the target holds', () => {
    moveRow('/a', '/c');
    expect(['/a', '/b', '/c', '/d'].map(orderIndex)).toEqual([2, 0, 1, 3]);
  });

  it('moves a row up into the slot the target holds', () => {
    moveRow('/d', '/b');
    expect(['/a', '/b', '/c', '/d'].map(orderIndex)).toEqual([0, 2, 3, 1]);
  });

  it('swaps two neighbours', () => {
    moveRow('/b', '/a');
    expect(orderIndex('/b')).toBe(0);
    expect(orderIndex('/a')).toBe(1);
  });

  // The order array outlives the rows in it, so two rows that are adjacent
  // on screen can have a dead key sitting between them in storage.
  it('still swaps two rows that have a dead key between them', () => {
    localStorage.clear();
    reloadGroups();
    rememberKeys(['/a', '/dead', '/b']);
    rememberKeys(['/a', '/b']); // /dead is a folder key, so it stays in order
    moveRow('/a', '/b');
    expect(orderIndex('/b')).toBeLessThan(orderIndex('/a'));
  });

  it('is a no-op for an unknown key, for an unknown target, and for itself', () => {
    const before = localStorage.getItem(GROUPS_STORAGE_KEY);
    moveRow('/nope', '/a');
    moveRow('/a', '/nope');
    moveRow('/a', '/a');
    expect(localStorage.getItem(GROUPS_STORAGE_KEY)).toBe(before);
  });

  it('persists across a reload', () => {
    moveRow('/d', '/a');
    reloadGroups();
    expect(orderIndex('/d')).toBe(0);
  });
});

describe('the store singleton', () => {
  it('survives a corrupt stored value', () => {
    localStorage.setItem(GROUPS_STORAGE_KEY, '{not json');
    reloadGroups();
    expect(getGroups()).toEqual(DEFAULT_GROUPS);
  });

  // A grouping preference is never worth taking the rail down over --
  // the same reasoning favourites.ts's own never-throws test states.
  it('never throws when localStorage itself is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => assignCategory('s1', 'Fleet')).not.toThrow();
    expect(() => toggleStack('/a')).not.toThrow();
    expect(() => reloadGroups()).not.toThrow();
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('returns a stable identity until something changes', () => {
    const a = getGroups();
    expect(getGroups()).toBe(a);
    assignCategory('s1', 'Fleet');
    expect(getGroups()).not.toBe(a);
  });

  it('notifies subscribers on a real change, and not on a no-op', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeGroups(cb);
    assignCategory('s1', 'Fleet');
    expect(cb).toHaveBeenCalledTimes(1);
    assignCategory('s1', 'Fleet'); // already there
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    assignCategory('s2', 'Fleet');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/groups.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — cannot resolve `src/renderer/state/groups.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/state/groups.ts`:

```ts
import { useSyncExternalStore } from 'react';

/** The rail's grouping state: what categories exist, which session is in
 *  which, what order the rows sit in, and which stacks are unfolded.
 *  Follows favourites.ts's own store shape exactly -- one module-scoped
 *  singleton, so the rail, the card menu and every row's move controls all
 *  read and write the SAME state with no reload and no context provider.
 *
 *  TWO KEYS LIVE HERE, DELIBERATELY DIFFERENT, and the spec's identity
 *  ruling is the whole reason:
 *
 *  - `order` and `open` are keyed by ABSOLUTE FOLDER PATH. A folder path
 *    survives a restart, a /clear and a pid recycle (macOS pids were at
 *    99129 of 99999 on the machine this was decided on), so a row David
 *    dragged into place stays there.
 *  - `assignments` is keyed by SESSION ID, which survives none of those --
 *    and that is the point. David's call, made after reading the ruling:
 *    "to session id. It can be temp. If clear or session exit its lost."
 *    pruneAssignments below is what makes that automatic rather than a
 *    leak: /clear mints an id that was never assigned, and an exited
 *    session stops being live, so both fall out with no bookkeeping.
 *
 *  `categories` is the third lifetime: a NAME persists past every
 *  assignment that ever pointed at it. That is not a nicety -- "deletable
 *  if not attached to a session" can only mean something if a name is
 *  allowed to exist while attached to nothing.
 *
 *  Stack MEMBERSHIP is deliberately absent -- it is derived from `cwd` on
 *  every fleet push (order.ts's groupByFolder), so nothing here ever needs
 *  reconciling when a session dies.
 *
 *  There is no node import anywhere in this file, and there must not be: a
 *  value import from main blanks the whole window (same rule settings.ts and
 *  favourites.ts both state). */

export const GROUPS_STORAGE_KEY = 'llmws:groups';
/** Long enough for "Client work, archived"; short enough that a name cannot
 *  push a rail section header into wrapping at the 140px minimum width. */
export const MAX_CATEGORY_LENGTH = 32;
/** A bound, not a design limit: David will never hand-make two dozen names,
 *  but a hand-edited or older blob could carry any number, and this list is
 *  rendered in full inside a card menu. */
export const MAX_CATEGORIES = 24;

export type GroupsState = {
  /** Category names, in the order they were first created. Creation order,
   *  not alphabetical, so renaming one does not make it jump under the
   *  click that renamed it. */
  categories: string[];
  /** Session id -> category name. Every value here is one of `categories`
   *  -- normalizeGroups enforces it on read and assignCategory on write, so
   *  a section header can never name a category the app does not have. */
  assignments: Record<string, string>;
  /** Row keys in rail order: a folder path, or `pid:<n>` for a row that is
   *  not a folder -- a session with no cwd, one pulled out of its folder by
   *  a category, or one of an un-stacked folder's members. Appended to as
   *  new keys appear; a key keeps its slot. */
  order: string[];
  /** Absolute folder paths whose stack is unfolded. */
  open: string[];
};

export const DEFAULT_GROUPS: GroupsState = { categories: [], assignments: {}, order: [], open: [] };

function isAbsPath(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/');
}

function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_CATEGORY_LENGTH) : '';
}

/** Deduped, first occurrence winning -- same rule normalizeFavourites uses. */
function dedupe(raw: unknown, keep: (v: unknown) => boolean): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.filter(keep) as string[]));
}

/** A key that names one PROCESS, and can therefore never come back once its
 *  row is gone -- every row that is not a folder is keyed this way
 *  (order.ts's pidRowKey). Folder keys are the opposite: a folder David has
 *  arranged keeps its slot even with nothing running in it, which is the
 *  entire reason position is keyed by folder. */
function isEphemeralKey(key: string): boolean {
  return key.startsWith('pid:');
}

/** Validated on every read, not just on write: this is a blob on disk that
 *  an older version of the app or a hand edit could have left behind. Each
 *  field is checked on its own, so one bad field costs one default rather
 *  than the whole object. */
export function normalizeGroups(raw: unknown): GroupsState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_GROUPS;
  const r = raw as Record<string, unknown>;

  const categories = Array.isArray(r.categories)
    ? Array.from(new Set(r.categories.map(cleanName).filter(n => n !== ''))).slice(0, MAX_CATEGORIES)
    : [];

  const assignments: Record<string, string> = {};
  if (typeof r.assignments === 'object' && r.assignments !== null && !Array.isArray(r.assignments)) {
    for (const [sessionId, name] of Object.entries(r.assignments as Record<string, unknown>)) {
      if (sessionId === '' || typeof name !== 'string') continue;
      // Dropped rather than repaired by re-adding the name: a stored
      // assignment to a category David deleted is stale, and resurrecting
      // the name would undo a deletion he made on purpose.
      if (!categories.includes(name)) continue;
      assignments[sessionId] = name;
    }
  }

  return {
    categories,
    assignments,
    order: dedupe(r.order, v => typeof v === 'string' && v !== ''),
    open: dedupe(r.open, isAbsPath),
  };
}

function read(): GroupsState {
  try {
    const rawText = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (rawText === null) return DEFAULT_GROUPS;
    return normalizeGroups(JSON.parse(rawText));
  } catch {
    return DEFAULT_GROUPS;
  }
}

/** Best-effort only: a failed write leaves `current` (already updated) as the
 *  only copy of the change, gone on the next reload -- still better than
 *  throwing and losing the click entirely. */
function write(s: GroupsState): void {
  try { localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(s)); } catch { /* best-effort only */ }
}

let current: GroupsState = read();
const listeners = new Set<() => void>();

/** A STABLE object identity until something actually changes -- required by
 *  useSyncExternalStore, which re-renders forever if the snapshot is a new
 *  object each call. */
export function getGroups(): GroupsState {
  return current;
}

function commit(next: GroupsState): void {
  current = next;
  write(next);
  for (const listener of listeners) listener();
}

/** The names, in creation order, for the card menu's picker. Returns the
 *  live array rather than a copy so the identity stays stable between
 *  renders that changed nothing. */
export function categoryNames(): string[] {
  return current.categories;
}

export function categoryOfSession(sessionId: string): string | null {
  return current.assignments[sessionId] ?? null;
}

/** One category per session: assigning replaces whatever was there. A null
 *  or blank name CLEARS the assignment and leaves the name standing, which
 *  is the one place that rule lives, so the card menu cannot disagree with
 *  it.
 *
 *  Creates the name when it is new, so "type a name and press Enter" is one
 *  atomic change rather than a create that could succeed followed by an
 *  assign that fails -- which is how an assignment pointing at a
 *  non-existent name would get written in the first place. */
export function assignCategory(sessionId: string, name: string | null): void {
  if (sessionId === '') return;
  const clean = name === null ? '' : cleanName(name);

  if (clean === '') {
    if (!(sessionId in current.assignments)) return;
    const assignments = { ...current.assignments };
    delete assignments[sessionId];
    commit({ ...current, assignments });
    return;
  }

  const known = current.categories.includes(clean);
  // Refused rather than silently swapping something out: the cap exists to
  // bound the menu, and dropping a name David is using to make room for a
  // new one would take its sessions with it.
  if (!known && current.categories.length >= MAX_CATEGORIES) return;
  if (known && current.assignments[sessionId] === clean) return;

  commit({
    ...current,
    categories: known ? current.categories : [...current.categories, clean],
    assignments: { ...current.assignments, [sessionId]: clean },
  });
}

/** Renames a name AND every assignment pointing at it, in one commit, so a
 *  rename can never orphan a session -- the spec's explicit requirement.
 *
 *  Returns the stored name, or null when it refused: a blank new name, an
 *  old name it does not have, or a new name already taken by a DIFFERENT
 *  category. That last one is refused rather than merged because folding two
 *  categories into one is a different decision from renaming, and it is not
 *  reversible. The caller shows the reason; this returns the fact. */
export function renameCategory(from: string, to: string): string | null {
  const clean = cleanName(to);
  if (clean === '' || !current.categories.includes(from)) return null;
  if (clean === from) return clean;
  if (current.categories.includes(clean)) return null;

  const assignments: Record<string, string> = {};
  for (const [sessionId, name] of Object.entries(current.assignments)) {
    assignments[sessionId] = name === from ? clean : name;
  }
  // Mapped in place rather than removed and appended: the name keeps its
  // slot in the menu, so the row does not jump out from under the click.
  commit({
    ...current,
    categories: current.categories.map(n => (n === from ? clean : n)),
    assignments,
  });
  return clean;
}

/** True while some assignment points at this name. Because pruneAssignments
 *  runs on every fleet push, every assignment left in the map belongs to a
 *  LIVE session -- so this in-memory check IS the spec's "no live session is
 *  assigned to it" test, with no need to ask main anything. */
export function categoryInUse(name: string): boolean {
  return Object.values(current.assignments).includes(name);
}

/** Refuses while a live session holds the name (see categoryInUse), and
 *  returns false so the caller can explain why rather than hiding the
 *  option. Returns false for a name it does not have, too. */
export function deleteCategory(name: string): boolean {
  if (!current.categories.includes(name) || categoryInUse(name)) return false;
  commit({ ...current, categories: current.categories.filter(n => n !== name) });
  return true;
}

/** Drops every assignment whose session is no longer live. Called on every
 *  fleet push -- this is the mechanism behind "if clear or session exit its
 *  lost", and the reason assignments may safely be keyed by a session id
 *  the identity ruling otherwise rejects.
 *
 *  An EMPTY live list is ignored on purpose. "Nothing discovered yet" and
 *  "nothing running" arrive here as the same empty array, and a sweep that
 *  finds nothing -- on the app's first frame, or between two discovery
 *  passes -- would otherwise wipe every assignment David has made. Leaving
 *  stale entries for one push costs nothing visible (a row is drawn from the
 *  live sessions, never from this map, so a stale entry paints nothing);
 *  wiping them is unrecoverable.
 *
 *  Names are untouched: an assignment dying is exactly when a name starts
 *  being deletable. */
export function pruneAssignments(liveSessionIds: string[]): void {
  if (liveSessionIds.length === 0) return;
  const live = new Set(liveSessionIds);
  const assignments: Record<string, string> = {};
  let dropped = false;
  for (const [sessionId, name] of Object.entries(current.assignments)) {
    if (live.has(sessionId)) assignments[sessionId] = name;
    else dropped = true;
  }
  if (!dropped) return;
  commit({ ...current, assignments });
}

export function isStackOpen(folder: string): boolean {
  return current.open.includes(folder);
}

export function toggleStack(folder: string): void {
  const open = current.open.includes(folder)
    ? current.open.filter(f => f !== folder)
    : [...current.open, folder];
  commit({ ...current, open });
}

/** MAX_SAFE_INTEGER rather than -1 for an unknown key: unseen rows sort to
 *  the END, never above rows the user has already placed. */
export function orderIndex(key: string): number {
  const i = current.order.indexOf(key);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** Appends keys never seen before, in the order given, and leaves known keys
 *  exactly where they are -- that is what makes a session starting to wait
 *  change how its row LOOKS and never where it IS.
 *
 *  It also forgets `pid:` keys that are no longer on screen. Those name one
 *  process and can never return, so keeping them would grow this blob
 *  without bound. Folder keys are never dropped:
 *  a folder with nothing running in it today is the same folder tomorrow,
 *  and its slot is the thing being preserved.
 *
 *  Returns without writing when there is nothing to add and nothing to drop,
 *  so calling it on every fleet push usually costs one scan and no storage
 *  write. */
export function rememberKeys(keys: string[]): void {
  const present = new Set(keys.filter(k => k !== ''));
  const kept = current.order.filter(k => !isEphemeralKey(k) || present.has(k));
  const unseen = Array.from(present).filter(k => !current.order.includes(k));
  if (unseen.length === 0 && kept.length === current.order.length) return;
  commit({ ...current, order: [...kept, ...unseen] });
}

/** Moves `key` to the slot `targetKey` currently occupies, shifting the rest
 *  -- the ordinary splice-move a drag-and-drop list is expected to do, and
 *  the SINGLE function both the drop handler and the Move up / Move down
 *  menu items call, so the two can never drift into different behaviour.
 *
 *  Both indices are taken from the stored order, not from the screen, which
 *  is what makes it correct when dead folder keys sit between two rows that
 *  are visually adjacent: removing then re-inserting at the target's
 *  ORIGINAL index lands `key` on the far side of the target either way.
 *
 *  A no-op for a key it has never seen. The rail appends every rendered key
 *  before any of these controls can be clicked, so in practice that guard
 *  only fires on a stale click. */
export function moveRow(key: string, targetKey: string): void {
  if (key === targetKey) return;
  const from = current.order.indexOf(key);
  const to = current.order.indexOf(targetKey);
  if (from === -1 || to === -1) return;
  const order = [...current.order];
  order.splice(from, 1);
  order.splice(to, 0, key);
  commit({ ...current, order });
}

export function subscribeGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-reads from storage and notifies -- for tests, which write localStorage
 *  directly and need the module to see it (same as settings.ts's own
 *  reloadSettings); harmless in production, where nothing calls it. */
export function reloadGroups(): void {
  current = read();
  for (const listener of listeners) listener();
}

/** React 18's own external-store hook -- no context provider, and every
 *  consumer sees the same object the moment any one of them writes it. */
export function useGroups(): GroupsState {
  return useSyncExternalStore(subscribeGroups, getGroups, getGroups);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/groups.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/groups.ts tests/renderer/groups.test.ts
git commit -m "feat(rail): a store for category names, assignments, row order and open stacks"
```

---

### Task 2: The grouping transform

**Files:**
- Modify: `src/fleet/order.ts` (append after `compareOpenSessions`)
- Test: `tests/fleet/order.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1 — this module stays pure and storage-free so it can be tested without a DOM.
- Produces: `interface Groupable { pid: number; cwd: string | null }`, `type RailRow<T>`, `rowKey(s: Groupable): string`, `groupByFolder<T extends Groupable>(sessions: T[]): RailRow<T>[]`, `applyStableOrder<T>(rows: RailRow<T>[], indexOf: (key: string) => number): RailRow<T>[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/fleet/order.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rowKey, groupByFolder, applyStableOrder, type RailRow } from '../../src/fleet/order.ts';

type S = { pid: number; cwd: string | null };
const s = (pid: number, cwd: string | null): S => ({ pid, cwd });

describe('rowKey', () => {
  it('is the cwd when there is one', () => {
    expect(rowKey(s(1, '/repo'))).toBe('/repo');
  });

  it('falls back to the pid when cwd is null or empty', () => {
    expect(rowKey(s(7, null))).toBe('pid:7');
    expect(rowKey(s(7, ''))).toBe('pid:7');
  });
});

describe('groupByFolder', () => {
  it('leaves a folder with one session as a plain session row', () => {
    const rows = groupByFolder([s(1, '/a')]);
    expect(rows).toEqual([{ kind: 'session', key: '/a', session: s(1, '/a') }]);
  });

  it('collapses two sessions sharing a folder into one stack row', () => {
    const rows = groupByFolder([s(1, '/a'), s(2, '/a')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('stack');
    if (rows[0].kind !== 'stack') throw new Error('expected a stack');
    expect(rows[0].cwd).toBe('/a');
    expect(rows[0].members.map(m => m.pid)).toEqual([1, 2]);
  });

  it('never groups sessions with no cwd, even with each other', () => {
    const rows = groupByFolder([s(1, null), s(2, null)]);
    expect(rows.map(r => r.kind)).toEqual(['session', 'session']);
    expect(rows.map(r => r.key)).toEqual(['pid:1', 'pid:2']);
  });

  it('keeps members in the order they arrived, so the caller comparator still governs', () => {
    const rows = groupByFolder([s(3, '/a'), s(1, '/a'), s(2, '/a')]);
    if (rows[0].kind !== 'stack') throw new Error('expected a stack');
    expect(rows[0].members.map(m => m.pid)).toEqual([3, 1, 2]);
  });

  it('places each row where its FIRST member sat in the input', () => {
    const rows = groupByFolder([s(1, '/a'), s(2, '/b'), s(3, '/a')]);
    expect(rows.map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('returns an empty array for no sessions', () => {
    expect(groupByFolder([])).toEqual([]);
  });
});

describe('applyStableOrder', () => {
  const rows: RailRow<S>[] = [
    { kind: 'session', key: '/b', session: s(2, '/b') },
    { kind: 'session', key: '/a', session: s(1, '/a') },
  ];

  it('sorts rows by their stored index', () => {
    const indexOf = (k: string) => (k === '/a' ? 0 : 1);
    expect(applyStableOrder(rows, indexOf).map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('sends unknown keys to the end, keeping their relative input order', () => {
    const indexOf = (k: string) => (k === '/b' ? 0 : Number.MAX_SAFE_INTEGER);
    const more: RailRow<S>[] = [...rows, { kind: 'session', key: '/c', session: s(3, '/c') }];
    expect(applyStableOrder(more, indexOf).map(r => r.key)).toEqual(['/b', '/a', '/c']);
  });

  it('does not mutate the array it is given', () => {
    const before = rows.map(r => r.key);
    applyStableOrder(rows, () => 0);
    expect(rows.map(r => r.key)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fleet/order.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `rowKey is not a function` / no such export.

- [ ] **Step 3: Write minimal implementation**

Append to `src/fleet/order.ts`, below `compareOpenSessions`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fleet/order.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/order.ts tests/fleet/order.test.ts
git commit -m "feat(rail): group sessions by folder into stack rows"
```

---

### Task 3: The setting

**Files:**
- Modify: `src/renderer/state/settings.ts:18-64` (add the type, the allowed list, the default, the normalizer line, the `same` comparison)
- Modify: `src/renderer/components/SettingsModal.tsx`
- Test: `tests/renderer/settings.test.ts`, `tests/renderer/SettingsModal.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `type GroupSessions = 'on' | 'off'`, `GROUP_SESSIONS: readonly GroupSessions[]`, and `groupSessions` on `Settings` (default `'on'`).

- [ ] **Step 1: Write the failing test**

Append to `tests/renderer/settings.test.ts`:

```ts
describe('groupSessions', () => {
  it('defaults to on', () => {
    expect(DEFAULT_SETTINGS.groupSessions).toBe('on');
  });

  it('keeps a valid value and falls back to the default for anything else', () => {
    expect(normalizeSettings({ groupSessions: 'off' }).groupSessions).toBe('off');
    expect(normalizeSettings({ groupSessions: 'sometimes' }).groupSessions).toBe('on');
    expect(normalizeSettings({ groupSessions: null }).groupSessions).toBe('on');
  });

  it('round-trips through setSettings', () => {
    setSettings({ groupSessions: 'off' });
    expect(getSettings().groupSessions).toBe('off');
    reloadSettings();
    expect(getSettings().groupSessions).toBe('off');
  });

  it('changes the object identity, so subscribers re-render', () => {
    const before = getSettings();
    setSettings({ groupSessions: 'off' });
    expect(getSettings()).not.toBe(before);
  });
});
```

Ensure the file's existing import list includes `DEFAULT_SETTINGS`, `normalizeSettings`, `setSettings`, `getSettings` and `reloadSettings`; add any that are missing.

Append to `tests/renderer/SettingsModal.test.tsx`, following that file's existing render helper and `beforeEach`:

```tsx
it('offers a control for grouping sessions by folder', () => {
  renderModal();
  const control = screen.getByRole('checkbox', { name: /group sessions by folder/i });
  expect(control).toBeChecked();
});

it('writes the setting when toggled off', () => {
  renderModal();
  fireEvent.click(screen.getByRole('checkbox', { name: /group sessions by folder/i }));
  expect(getSettings().groupSessions).toBe('off');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/settings.test.ts tests/renderer/SettingsModal.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `DEFAULT_SETTINGS.groupSessions` is `undefined`; no matching checkbox.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/state/settings.ts`, add beside the existing unions:

```ts
/** Whether sessions sharing a folder collapse into one rail row.
 *
 *  FOLDER STACKING ONLY. Categories and David's own row order apply either
 *  way -- "not auto movement for the cards" was stated unconditionally, and
 *  a category he set must not disappear because he turned stacking off. So
 *  'off' means no stacks, not a rollback of the whole feature. */
export type GroupSessions = 'on' | 'off';
```

Add `groupSessions: GroupSessions;` to the `Settings` type, then:

```ts
export const GROUP_SESSIONS: readonly GroupSessions[] = ['on', 'off'];
```

Add `groupSessions: 'on'` to `DEFAULT_SETTINGS`, add to `normalizeSettings`'s returned object:

```ts
    groupSessions: pick(GROUP_SESSIONS, r.groupSessions, DEFAULT_SETTINGS.groupSessions),
```

and extend `same`:

```ts
function same(a: Settings, b: Settings): boolean {
  return a.appearance === b.appearance && a.textSize === b.textSize
    && a.messageStyle === b.messageStyle && a.compactCards === b.compactCards
    && a.groupSessions === b.groupSessions;
}
```

In `SettingsModal.tsx`, add a row matching the file's existing control markup:

```tsx
<label className="setrow">
  <input
    type="checkbox"
    checked={settings.groupSessions === 'on'}
    onChange={e => setSettings({ groupSessions: e.target.checked ? 'on' : 'off' })}
  />
  <span>Group sessions by folder</span>
</label>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/settings.test.ts tests/renderer/SettingsModal.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/settings.ts src/renderer/components/SettingsModal.tsx tests/renderer/settings.test.ts tests/renderer/SettingsModal.test.tsx
git commit -m "feat(settings): a switch for grouping rail sessions by folder"
```

---

### Task 4: The stack card

**Files:**
- Create: `src/renderer/components/StackCard.tsx`
- Create: `src/renderer/components/StackCard.css`
- Test: `tests/renderer/StackCard.test.tsx`
- Test: `tests/renderer/StackCard.css.test.ts`

**Interfaces:**
- Consumes: `RailRow` from Task 2 (type only); `OpenSession` from `src/fleet/state.ts` (type only); `Icon` from `./Icon.tsx`.
- Produces: `StackCard({ cwd, members, open, onToggle, selectedPid, renderMember, onAnswer })`, and `stackSummary(members: OpenSession[]): string`.

**The motion, as David approved it from the rendered prototype: "Slide", 220ms.**

- 220ms on `cubic-bezier(0.22,1,0.36,1)`, with duration, easing and stagger as custom properties on `.stack` so they change in one place.
- Members stagger 30ms apart **on the way in only**. Closing has no stagger: a staggered exit reads as the app hesitating. Things leave together and come back one at a time.
- The chevron rotates on the same duration and curve, so nothing arrives out of step.
- Height animates `grid-template-rows: 0fr -> 1fr` with an inner `overflow:hidden` wrapper, **never `max-height`** — a hard-coded max either clips a deep stack or leaves dead air under a shallow one.

**This forces a structural change, and it is the part that matters.** Members can no longer be conditionally mounted: a node that does not exist cannot transition from anything. They always render, and the `open` class on the root drives the motion.

That opens an accessibility hole this task must close in the same breath. Always-rendered members sit in the accessibility tree and the tab order while folded, so a screen reader would announce three sessions the sighted user cannot see. `visibility: hidden` on the collapsed container removes the subtree from both, and unlike `display:none` it does not break the transition. It is sequenced to flip to `visible` immediately on open, and to `hidden` only once the collapse has finished (`visibility 0s linear var(--dur)` closed, `0s` open).

**Why the tests below are split, and why `toBeVisible()` is not used.** It cannot work here, and using it would be worse than not testing at all. This repo's `vitest.config.ts` sets no `css` option, so Vitest's default applies and `import './StackCard.css'` is stubbed — jsdom receives not one rule from it. An element with no CSS is visible, so `toBeVisible()` would pass on the folded stack **and** on the open one: green whichever way the code behaved. That is why this repo already carries twelve `*.css.test.ts` files that read the stylesheet as text; `OpenSessionCard.css.test.ts` states the reasoning in full. The split below follows it — the DOM test pins the structure the motion depends on, the CSS test pins the rules that produce it, and neither alone would catch a regression.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/StackCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StackCard, stackSummary } from '../../src/renderer/components/StackCard.tsx';
import type { OpenSession } from '../../src/fleet/state.ts';

function session(pid: number, activity: OpenSession['activity'], project = 'repo'): OpenSession {
  return { pid, cwd: '/repo', project, activity } as unknown as OpenSession;
}

const members = [session(1, 'waiting_permission'), session(2, 'working'), session(3, 'idle')];

describe('stackSummary', () => {
  it('counts each state it finds, waiting first', () => {
    expect(stackSummary(members)).toBe('1 waiting on you, 1 working, 1 idle');
  });

  it('omits a state with no members', () => {
    expect(stackSummary([session(1, 'working'), session(2, 'working')])).toBe('2 working');
  });

  it('counts both waiting kinds together', () => {
    expect(stackSummary([session(1, 'waiting_permission'), session(2, 'waiting_input')]))
      .toBe('2 waiting on you');
  });
});

describe('StackCard', () => {
  function renderStack(over: Partial<Parameters<typeof StackCard>[0]> = {}) {
    const props = {
      cwd: '/repo', members, open: false, onToggle: vi.fn(), selectedPid: null,
      renderMember: (s: OpenSession) => <div key={s.pid}>member {s.pid}</div>,
      onAnswer: vi.fn(),
      ...over,
    };
    render(<StackCard {...props} />);
    return props;
  }

  it('names the folder and the member count when folded', () => {
    renderStack();
    expect(screen.getByText('repo')).toBeInTheDocument();
    expect(screen.getByText('3 sessions')).toBeInTheDocument();
  });

  it('states what its members are doing when folded', () => {
    renderStack();
    expect(screen.getByText('1 waiting on you, 1 working, 1 idle')).toBeInTheDocument();
  });

  // Members are ALWAYS mounted now -- a node that does not exist cannot
  // transition from anything. What changes is the `open` class on the root,
  // which is what the stylesheet animates and what hides the subtree from
  // assistive technology while folded. Deliberately NOT toBeVisible(): CSS
  // imports are stubbed under this repo's vitest config, so that matcher
  // would answer "visible" in both states and prove nothing. The rules
  // themselves are pinned in StackCard.css.test.ts.
  it('keeps its members mounted in both states, so the height can transition', () => {
    const { rerender, container } = render(
      <StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={s => <div>member {s.pid}</div>} />,
    );
    expect(screen.getByText('member 1')).toBeInTheDocument();
    expect(container.querySelector('.stack.open')).toBeNull();
    rerender(
      <StackCard cwd="/repo" members={members} open={true} onToggle={vi.fn()}
        selectedPid={null} renderMember={s => <div>member {s.pid}</div>} />,
    );
    expect(screen.getByText('member 1')).toBeInTheDocument();
    expect(container.querySelector('.stack.open')).not.toBeNull();
  });

  it('wraps each member in its own stagger slot, indexed in order', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={members} open={true} onToggle={vi.fn()}
        selectedPid={null} renderMember={s => <div>member {s.pid}</div>} />,
    );
    const slots = [...container.querySelectorAll('.stackmember')];
    expect(slots).toHaveLength(3);
    expect(slots.map(el => (el as HTMLElement).style.getPropertyValue('--i'))).toEqual(['0', '1', '2']);
  });

  it('marks the chevron decorative, since the toggle already names itself', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={() => null} />,
    );
    expect(container.querySelector('.stackchev')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('reports its folded state to assistive technology', () => {
    renderStack();
    expect(screen.getByRole('button', { name: /repo/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('calls onToggle with the folder when the face is clicked', () => {
    const props = renderStack();
    fireEvent.click(screen.getByRole('button', { name: /repo/i }));
    expect(props.onToggle).toHaveBeenCalledWith('/repo');
  });

  it('offers Answer on the face when exactly one member is waiting', () => {
    const props = renderStack();
    fireEvent.click(screen.getByRole('button', { name: /^Answer repo, pid 1$/ }));
    expect(props.onAnswer).toHaveBeenCalledWith(1);
  });

  it('offers no Answer button when two members are waiting, because which one is ambiguous', () => {
    renderStack({ members: [session(1, 'waiting_permission'), session(2, 'waiting_input')] });
    expect(screen.queryByRole('button', { name: /^Answer/ })).not.toBeInTheDocument();
  });

  it('carries the attention treatment while any member waits', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={() => null} />,
    );
    expect(container.querySelector('.stack.attn')).not.toBeNull();
  });

  it('drops the attention treatment when nothing waits', () => {
    const { container } = render(
      <StackCard cwd="/repo" members={[session(1, 'idle')]} open={false} onToggle={vi.fn()}
        selectedPid={null} renderMember={() => null} />,
    );
    expect(container.querySelector('.stack.attn')).toBeNull();
  });
});
```

Create `tests/renderer/StackCard.css.test.ts`, following `OpenSessionCard.css.test.ts`'s shape exactly:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// jsdom computes no layout and this repo's vitest config stubs CSS imports,
// so there is no way to render a stack and observe a real height animation
// or a real hidden subtree -- the same gap OpenSessionCard.css.test.ts,
// SessionRail.css.test.ts and ConversationView.css.test.ts already work
// around. Reading the stylesheet and asserting on the properties that take
// effect is that same established technique. StackCard.test.tsx separately
// proves the members stay mounted and the `open` class tracks the prop;
// that DOM test and this one together stand in for "the motion is right in
// the window". Neither alone would catch a regression.
const CSS_PATH = 'src/renderer/components/StackCard.css';
// Comments stripped first, so every assertion below runs against real
// declarations rather than text a comment happens to quote -- same defect
// and same fix as theme.test.ts and the other css tests in this directory.
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The first `{ ... }` block following `selector`'s first real occurrence.
 *  `selector` includes the trailing `{` so '.stackmembers {' cannot match
 *  inside '.stackmembers-inner {'. */
function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('the stack open/close motion', () => {
  it('declares the approved duration, easing and stagger in one place', () => {
    const root = blockAfter('.stack {');
    expect(root).toMatch(/--dur:\s*220ms/);
    expect(root).toMatch(/--ease:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
    expect(root).toMatch(/--stag:\s*30ms/);
  });

  // A hard-coded max-height either clips a deep stack or leaves dead air
  // under a shallow one. 0fr -> 1fr animates to CONTENT height.
  it('animates height with grid-template-rows, never max-height', () => {
    expect(blockAfter('.stackmembers {')).toMatch(/grid-template-rows:\s*0fr/);
    expect(blockAfter('.stack.open .stackmembers {')).toMatch(/grid-template-rows:\s*1fr/);
    expect(css).not.toMatch(/max-height/);
  });

  it('gives the collapsing grid an inner overflow-hidden wrapper', () => {
    const inner = blockAfter('.stackmembers-inner {');
    expect(inner).toMatch(/overflow:\s*hidden/);
    // Without min-height:0 a grid item refuses to shrink below its content,
    // and the 0fr row never actually collapses.
    expect(inner).toMatch(/min-height:\s*0/);
  });

  // The a11y half: always-rendered members would otherwise sit in the
  // accessibility tree and the tab order while folded.
  it('hides the folded subtree with visibility, not display', () => {
    expect(blockAfter('.stackmembers {')).toMatch(/visibility:\s*hidden/);
    expect(blockAfter('.stack.open .stackmembers {')).toMatch(/visibility:\s*visible/);
    // display:none would remove it from the a11y tree too, but it also kills
    // the transition outright -- the whole reason visibility is the tool.
    expect(css).not.toMatch(/display:\s*none/);
  });

  it('delays hiding until the collapse finishes, and shows immediately on open', () => {
    expect(blockAfter('.stackmembers {')).toMatch(/visibility\s+0s\s+linear\s+var\(--dur\)/);
    expect(blockAfter('.stack.open .stackmembers {')).toMatch(/visibility\s+0s\s+linear\s+0s/);
  });

  it('staggers members in by their index', () => {
    expect(blockAfter('.stack.open .stackmember {'))
      .toMatch(/transition-delay:\s*calc\(var\(--stag\)\s*\*\s*var\(--i\)\)/);
  });

  // Arriving staggers; leaving does not. The base rule's shorthand carries
  // an implicit 0 delay, and the closing transition reads the delay from the
  // state it is moving TO -- so this is what makes the exit move together.
  it('leaves no stagger on the way out', () => {
    const base = blockAfter('.stackmember {');
    expect(base).toMatch(/transition:\s*opacity\s+var\(--dur\)\s+var\(--ease\)/);
    expect(base).not.toMatch(/transition-delay/);
  });

  it('turns the chevron on the same duration and curve, so nothing arrives out of step', () => {
    expect(blockAfter('.stackchev {')).toMatch(/transition:\s*transform\s+var\(--dur\)\s+var\(--ease\)/);
    expect(blockAfter('.stack.open .stackchev {')).toMatch(/transform:\s*rotate\(180deg\)/);
  });

  // theme.css's blanket reduced-motion rule is `* { animation:none }` plus
  // `.card, .btn { transition:none }` -- it does NOT cover .stack's
  // transitions, so this block is load-bearing rather than belt and braces.
  it('stops the motion under prefers-reduced-motion, without stranding the members', () => {
    const idx = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(idx, 'no reduced-motion block').toBeGreaterThanOrEqual(0);
    const block = css.slice(idx, css.indexOf('}\n}', idx) + 3);
    expect(block).toMatch(/\.stackmembers/);
    expect(block).toMatch(/\.stackmember\b/);
    expect(block).toMatch(/\.stackchev/);
    expect(block).toMatch(/transition:\s*none/);
    // Only the transition goes. If this block touched visibility, a
    // reduced-motion user would open the stack onto nothing.
    expect(block).not.toMatch(/visibility/);
    expect(block).not.toMatch(/opacity/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/StackCard.test.tsx tests/renderer/StackCard.css.test.ts --maxWorkers=2 --minWorkers=1`
Expected: FAIL — cannot resolve `StackCard.tsx`, and `StackCard.css` does not exist for the stylesheet test to read.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/components/StackCard.tsx`:

```tsx
import type { CSSProperties, ReactNode } from 'react';
import type { OpenSession } from '../../fleet/state.ts';
import { lastSegment } from '../state/favourites.ts';
import { Icon } from './Icon.tsx';
import './StackCard.css';

function isWaiting(s: OpenSession): boolean {
  return s.activity === 'waiting_permission' || s.activity === 'waiting_input';
}

/** What the folded face says its members are doing. Waiting comes FIRST and
 *  is named in the app's own words ("waiting on you"), because folding must
 *  never be the reason David misses the one thing this app exists to show
 *  him. States with no members are omitted rather than printed as "0 idle". */
export function stackSummary(members: OpenSession[]): string {
  const waiting = members.filter(isWaiting).length;
  const working = members.filter(s => s.activity === 'working').length;
  const rest = members.length - waiting - working;
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} waiting on you`);
  if (working > 0) parts.push(`${working} working`);
  if (rest > 0) parts.push(`${rest} idle`);
  return parts.join(', ');
}

/** Several sessions sharing a folder, as one rail row that opens in place
 *  (the mechanic David chose on 2026-09-22 over a flyout and over an
 *  always-open header list).
 *
 *  Members are rendered by the CALLER via `renderMember` rather than by this
 *  component: the rail already wires each OpenSessionCard to seven handlers
 *  plus its unread and cmdIndex state, and threading all of that through here
 *  would duplicate that wiring in a second place that could drift from it. */
export function StackCard({
  cwd, members, open, onToggle, selectedPid, renderMember, onAnswer,
}: {
  cwd: string;
  members: OpenSession[];
  open: boolean;
  onToggle: (cwd: string) => void;
  selectedPid: number | null;
  renderMember: (s: OpenSession) => ReactNode;
  /** Optional so tests that never click Answer need not wire it, matching
   *  SessionRail's own onAnswer convention. */
  onAnswer?: (pid: number) => void;
}): JSX.Element {
  const waiting = members.filter(isWaiting);
  const label = lastSegment(cwd);
  const holdsSelection = members.some(m => m.pid === selectedPid);

  // Exactly one waiting member gets an Answer button on the FACE. Two or more
  // and there is no honest answer to "which session would this answer", so
  // the count stands on its own and the stack must be opened -- deliberately
  // not a button that silently picks the first one.
  const answerable = waiting.length === 1 ? waiting[0] : undefined;

  const cls = ['stack'];
  if (waiting.length > 0) cls.push('attn');
  if (open) cls.push('open');
  if (holdsSelection) cls.push('sel');

  return (
    <div className={cls.join(' ')}>
      <div className="stackface">
        <button
          type="button"
          className="stacktoggle"
          aria-expanded={open}
          onClick={() => onToggle(cwd)}
        >
          <span className="stackcount">{members.length} sessions</span>
          {/* Decorative: aria-expanded on this button already tells a screen
              reader which way the stack is, so naming the chevron too would
              say the same thing twice. */}
          <span className="stackchev" aria-hidden="true">
            <Icon name="chevron-down" size={12} />
          </span>
          <span className="stackname">{label}</span>
          <span className="stackpath">{cwd}</span>
          <span className="stacksummary">{stackSummary(members)}</span>
        </button>
        {answerable && (
          // Named with project and pid, matching the rail's own Answer button
          // convention (SessionRail.tsx) -- with two stacks each offering one,
          // a bare "Answer" would put indistinguishable buttons in the
          // accessibility tree.
          <button
            type="button"
            className="stackreply"
            aria-label={`Answer ${answerable.project}, pid ${answerable.pid}`}
            onClick={() => onAnswer?.(answerable.pid)}
          >
            Answer
          </button>
        )}
      </div>
      {/* ALWAYS rendered, never `{open && ...}`: a node that does not exist
          cannot transition from anything, and the height animation is the
          whole point. The `open` class on the root drives it, and the
          stylesheet's visibility rule is what keeps the folded subtree out
          of the accessibility tree and the tab order in the meantime. */}
      <div className="stackmembers">
        <div className="stackmembers-inner">
          {members.map((m, i) => (
            // One slot per member carrying its index, so the stagger works
            // at any depth. An nth-child list would have to guess a maximum
            // and silently stop staggering past it.
            <div className="stackmember" key={m.pid} style={{ '--i': i } as CSSProperties}>
              {renderMember(m)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

Create `src/renderer/components/StackCard.css`:

```css
/* A stack reuses SessionCard's card shape rather than inventing a second
   one -- same radius, same border tokens, same attention treatment, so a
   folded folder reads as a sibling of the cards around it rather than a
   different kind of object. Only what is genuinely new lives here.

   The two offset sheets below the face are what says "there is more than one
   of these" before any count is read: a structural signal that survives
   grayscale and a colour-vision deficiency, the same standard
   OpenSessionCard.css's own .card.unread left border is held to.

   The three motion values live here, on the root, so the whole open/close
   gesture is retuned in one place -- "Slide", 220ms, the option David chose
   from the rendered prototype on 2026-09-22. */
.stack {
  --dur: 220ms;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --stag: 30ms;
  position: relative; margin-bottom: 9px;
}

.stack::before, .stack::after {
  content: ""; position: absolute; left: 5px; right: 5px; bottom: -4px; height: 11px;
  background: var(--surface); border: 1px solid var(--line-soft); border-top: none;
  border-radius: 0 0 var(--r-md) var(--r-md);
}
.stack::before { left: 10px; right: 10px; bottom: -9px; height: 13px; background: var(--ground); }

.stackface {
  position: relative; z-index: 1;
  background: var(--ground); border: 1px solid var(--line-soft);
  border-radius: var(--r-md); display: flex; align-items: flex-start; gap: 9px;
  padding: 16px 17px 17px;
}
.stack.attn > .stackface {
  border-color: color-mix(in srgb, var(--critical) 34%, transparent);
  background: linear-gradient(var(--critical-soft), var(--ground) 70%);
}
.stack.sel > .stackface { border-color: color-mix(in srgb, var(--accent) 46%, transparent); }
.stackface:hover { border-color: color-mix(in srgb, var(--accent) 46%, transparent); }

/* The whole face is the toggle: a 44px-plus target that covers the name, the
   path and the summary, so folding never depends on hitting a small chevron. */
.stacktoggle {
  flex-grow: 1; min-width: 0; background: none; border: none; padding: 0;
  text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 6px;
  font: inherit; color: inherit;
}
.stackcount {
  font-family: var(--f-mono); font-size: 10px; color: var(--accent);
  background: var(--raised); border-radius: 6px; padding: 3px 8px; align-self: flex-start;
}
.stackname { font-family: var(--f-display); font-weight: 600; font-size: 18px; line-height: 1.2; color: var(--ink); }
.stackpath {
  font-family: var(--f-mono); font-size: 10.5px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.stacksummary { font-size: 14px; color: var(--ink-2); line-height: 1.5; }
.stack.attn .stacksummary { color: var(--critical); }

.stackreply {
  flex: none; font: inherit; font-size: 12px; padding: 7px 11px; min-height: 44px;
  background: var(--raised); color: var(--ink); border: 1px solid var(--line);
  border-radius: var(--r-sm); cursor: pointer;
}

.stackchev { flex: none; display: inline-flex; color: var(--muted); }
/* Same duration and curve as the height below, so the mark and the drawer
   arrive together rather than one trailing the other. */
.stackchev { transition: transform var(--dur) var(--ease); }
.stack.open .stackchev { transform: rotate(180deg); }

/* Height animates 0fr -> 1fr, NOT max-height. A hard-coded max either clips
   a deep stack or leaves dead air under a shallow one; a grid row animated
   to 1fr resolves to the real content height whatever that turns out to be.

   visibility, not display:none, is what keeps the folded members out of the
   accessibility tree and the tab order -- they are always in the DOM now,
   because a node that does not exist cannot transition. display:none would
   hide them just as well and destroy the animation with it.

   The 0s-with-a-delay transition is the sequencing: hidden lands only AFTER
   the collapse has finished, so the members do not vanish mid-slide, while
   the open rule below has no delay so they are reachable the instant the
   stack starts opening. */
.stackmembers {
  position: relative; z-index: 1;
  display: grid; grid-template-rows: 0fr;
  margin: 8px 0 0 12px;
  visibility: hidden;
  transition: grid-template-rows var(--dur) var(--ease), visibility 0s linear var(--dur);
}
.stack.open .stackmembers {
  grid-template-rows: 1fr;
  visibility: visible;
  transition: grid-template-rows var(--dur) var(--ease), visibility 0s linear 0s;
}

/* min-height:0 alongside overflow:hidden, or the grid item refuses to shrink
   below its content and the 0fr row never actually collapses. */
.stackmembers-inner {
  overflow: hidden; min-height: 0;
  display: flex; flex-direction: column; gap: 8px;
}

/* Members are inset (above) so the stack reads as one object with contents,
   not four unrelated cards that happen to be adjacent. Each slides down into
   place as it fades in. */
.stackmember {
  opacity: 0; transform: translateY(-10px);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
/* Arriving staggers, leaving does not. A staggered exit reads as the app
   hesitating -- things leave together and come back one at a time. This
   works because a closing element takes its delay from the state it is
   moving TO, which is the rule above, whose shorthand carries an implicit
   0s delay. So the stagger only ever applies on the way in. `--i` is set
   per member in StackCard.tsx, which is what makes it correct at any depth
   rather than up to however many nth-child lines were written out. */
.stack.open .stackmember {
  opacity: 1; transform: none;
  transition-delay: calc(var(--stag) * var(--i));
}

/* NOT belt and braces here, unlike WorkingStrip.css's own block. theme.css
   stops `animation` globally and `transition` only on .card and .btn --
   every rule above is a transition on neither, so without this the whole
   slide would still run for someone who asked the OS for less motion.

   Only the transitions go. visibility and opacity are deliberately left
   alone: zeroing them here would open the stack onto nothing. */
@media (prefers-reduced-motion: reduce) {
  .stackmembers, .stack.open .stackmembers,
  .stackmember, .stack.open .stackmember,
  .stackchev { transition: none; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/StackCard.test.tsx tests/renderer/StackCard.css.test.ts --maxWorkers=2 --minWorkers=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/StackCard.tsx src/renderer/components/StackCard.css tests/renderer/StackCard.test.tsx tests/renderer/StackCard.css.test.ts
git commit -m "feat(rail): a folded stack card that slides open, for sessions sharing a folder"
```

---

### Task 5: Wire the rail

**Files:**
- Modify: `src/renderer/components/SessionRail.tsx:205-248`
- Test: `tests/renderer/SessionRail.test.tsx`

**Interfaces:**
- Consumes: `groupByFolder`, `applyStableOrder` (Task 2); `useGroups`, `isStackOpen`, `toggleStack`, `orderIndex`, `rememberKeys` (Task 1); `StackCard` (Task 4); `groupSessions` on `Settings` (Task 3).
- Produces: no new exports — the rail's props are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/renderer/SessionRail.test.tsx`, following that file's existing fixture arrays and render calls:

```tsx
describe('folder grouping', () => {
  const twoInOneFolder = [
    { pid: 1, project: 'repo', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/repo', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 's1' },
    { pid: 2, project: 'repo', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/repo', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 's2' },
  ] as never[];

  const renderRail = (list: never[] = twoInOneFolder) => render(
    <SessionRail sessions={list} selectedPid={null} onSelect={() => {}} onKill={noopKill}
      onReattach={noopReattach} onResume={noopResume} side="left" />,
  );

  beforeEach(() => {
    localStorage.clear();
    reloadGroups();
    reloadSettings();
  });

  it('renders one row for two sessions sharing a folder', () => {
    renderRail();
    expect(screen.getByText('2 sessions')).toBeTruthy();
  });

  it('leaves a lone session as an ordinary card, with no stack chrome', () => {
    renderRail([twoInOneFolder[0]] as never[]);
    expect(screen.queryByText(/\d+ sessions/)).toBeNull();
  });

  it('shows the members once the stack is opened, and keeps them open across a re-render', () => {
    const { rerender } = renderRail();
    fireEvent.click(screen.getByRole('button', { name: /repo/i }));
    expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
    rerender(
      <SessionRail sessions={twoInOneFolder} selectedPid={null} onSelect={() => {}} onKill={noopKill}
        onReattach={noopReattach} onResume={noopResume} side="left" />,
    );
    expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
  });

  it('does not group when the setting is off', () => {
    setSettings({ groupSessions: 'off' });
    renderRail();
    expect(screen.queryByText('2 sessions')).toBeNull();
    expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
    expect(screen.getByLabelText(/Close, pid 2/)).toBeTruthy();
  });

  it('keeps a row where it first appeared when a later session starts waiting', () => {
    const first = [
      { pid: 1, project: 'a-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 'sa' },
      { pid: 2, project: 'b-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 'sb' },
    ] as never[];
    const { rerender, container } = render(
      <SessionRail sessions={first} selectedPid={null} onSelect={() => {}} onKill={noopKill}
        onReattach={noopReattach} onResume={noopResume} side="left" />,
    );
    const namesOf = () => [...container.querySelectorAll('.proj')].map(p => p.textContent);
    const before = namesOf();
    const bumped = [
      { ...first[1] as object, activity: 'waiting_permission' },
      first[0],
    ] as never[];
    rerender(
      <SessionRail sessions={bumped} selectedPid={null} onSelect={() => {}} onKill={noopKill}
        onReattach={noopReattach} onResume={noopResume} side="left" />,
    );
    expect(namesOf()).toEqual(before);
  });
});
```

Add the imports this block needs at the top of the file: `reloadGroups` from `../../src/renderer/state/groups.ts` (`setSettings`/`reloadSettings` are already imported).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/SessionRail.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: FAIL — no "2 sessions" text; the rail still renders two separate cards.

- [ ] **Step 3: Write minimal implementation**

In `SessionRail.tsx`, extend the imports:

```tsx
import { compareOpenSessions, groupByFolder, applyStableOrder } from '../../fleet/order.ts';
import { StackCard } from './StackCard.tsx';
import { useGroups, isStackOpen, toggleStack, orderIndex, rememberKeys } from '../state/groups.ts';
```

Extract the per-session card into a local function, so the rail renders it identically whether it is loose or inside a stack (replacing the body of the existing `displaySessions.map`):

```tsx
  // Subscribed so a category change, a toggle or a new key re-renders the
  // rail; the values themselves are read through the module functions below.
  useGroups();
  const grouping = useSettings().groupSessions === 'on';

  function renderSession(s: OpenSession): JSX.Element {
    const waiting = s.activity === 'waiting_permission' || s.activity === 'waiting_input';
    const unread = isUnread(s);
    return (
      <div key={s.pid} className={s.pid === selectedPid ? 'railitem sel' : 'railitem'}>
        <OpenSessionCard state={s} onOpen={onSelect} onKill={onKill} onReveal={onReveal}
          onReattach={onReattach} onResume={onResume} unread={unread} compact={compact}
          cmdIndex={cmdIndexByPid?.get(s.pid)} />
        {waiting && (
          <button type="button" className="railreply"
            aria-label={`Answer ${s.project}, pid ${s.pid}`}
            onClick={() => onAnswer?.(s.pid)}>
            Answer
          </button>
        )}
      </div>
    );
  }

  // Grouping OFF is the pre-grouping rail exactly: the transform does not run
  // at all, rather than running and being flattened, so nothing about the old
  // path can regress behind the setting.
  const rows = grouping
    ? applyStableOrder(groupByFolder(displaySessions), orderIndex)
    : null;

  // Appending happens in an effect, not during render: rememberKeys writes
  // localStorage and notifies subscribers, and doing that mid-render would
  // re-enter this component while it is still rendering. The join/split is
  // how a string dependency stands in for an array one -- useEffect compares
  // deps by identity, and a fresh array every render would fire it forever.
  const rowKeys = rows?.map(r => r.key).join('\n') ?? '';
  useEffect(() => {
    if (rowKeys !== '') rememberKeys(rowKeys.split('\n'));
  }, [rowKeys]);
```

Then the returned list:

```tsx
      <div className="railcards">
        {rows === null
          ? displaySessions.map(renderSession)
          : rows.map(row => (
              row.kind === 'session'
                ? renderSession(row.session)
                : <StackCard key={row.key} cwd={row.cwd} members={row.members}
                    open={isStackOpen(row.cwd)} onToggle={toggleStack}
                    selectedPid={selectedPid} renderMember={renderSession}
                    onAnswer={onAnswer} />
            ))}
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/SessionRail.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npx vitest run --maxWorkers=2 --minWorkers=1 && npm run typecheck`
Expected: 2696 or more tests pass; typecheck clean. Investigate any pre-existing test that now fails — grouping defaults to ON, so a test asserting the old flat rail is a real regression to fix, not a test to delete.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/SessionRail.tsx tests/renderer/SessionRail.test.tsx
git commit -m "feat(rail): fold sessions sharing a folder into one row"
```

---

### Task 6: Categories from the card menu

**Files:**
- Modify: `src/renderer/components/OpenSessionCard.tsx` (the existing `...` menu)
- Modify: `src/renderer/components/OpenSessionCard.css`
- Test: `tests/renderer/OpenSessionCard.test.tsx`

**Interfaces:**
- Consumes: `useGroups`, `categoryNames`, `categoryOfSession`, `assignCategory`, `renameCategory`, `deleteCategory`, `categoryInUse`, `MAX_CATEGORY_LENGTH` (Task 1).
- Produces: no new exports — the card's props are unchanged.

**What this task is doing, and why the shape is what it is.** A category is attached to a SESSION, not a folder, so the gate is `state.sessionId`, not `state.cwd`.

**Sharing a folder does NOT stop a session being filed, and the common case is that it can be.** `applyExactMatches` (`src/discovery/match.ts:63-69`) overrides the cwd-based guess with an exact pid-to-session identity and sets `quality: 'unique'` whenever one exists, and both providers supply one: Claude writes a live session file (`~/.claude/sessions/<pid>.json`, carrying `pid`, `sessionId` and `cwd` — 11 of them on David's machine when this was written), and Codex resolves its open root rollout through `rolloutSessionIds`. This is exactly what the 2026-09-15 exact-session-identity work was for, and `OpenSession.sessionId`'s own doc comment (`src/fleet/state.ts:619-628`) says so: matched by cwd, **or** by an exact live-session file, whichever resolved it. So two sessions in one folder normally each have their own id and each take their own category.

`ambiguous` is the FALLBACK, not the default: no live session file and no open rollout, which in practice means a session this app did not launch and that predates the file. It is a real state and it still needs handling — the item is shown **disabled with the reason visible**, never hidden — but it is the edge, not the norm.

- [ ] **Step 1: Write the failing test**

Three existing tests assert the EXACT contents of the menu and will fail once an item is added. Update their expected arrays in place — do not delete them:

- `'opens the menu with the four documented items, favourites included'` becomes
  `['Show in iTerm2', 'Reattach in app', 'Add to category', 'Add folder to favourites', 'Close session']`
- `'omits Reattach for a session that is already tmux-backed, and Show in host with no host'` becomes
  `['Add to category', 'Add folder to favourites', 'Close session']`
- `'offers a session-actions menu on a full card too, with only the favourites item in it'` becomes
  `['Add to category', 'Add folder to favourites']` — and rename it to `'offers a session-actions menu on a full card too, with the category and favourites items in it'`.

Then append a new top-level describe to `tests/renderer/OpenSessionCard.test.tsx`:

```tsx
describe('the category menu item', () => {
  // A session-keyed store, so the fixture needs a real sessionId -- the
  // base fixture is deliberately unmatched (sessionId: null), which is the
  // "cannot be categorised" case tested last.
  const matched: OpenSession = {
    ...base, match: 'unique', sessionId: 's1', activity: 'working', tmux: true,
  };

  function renderCat(over: Partial<OpenSession> = {}) {
    return render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} compact state={{ ...matched, ...over }} />);
  }

  function openCategoryPanel() {
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: /^(Add to category|Category: )/ }));
  }

  beforeEach(() => { localStorage.clear(); reloadGroups(); });

  it('offers to put the session in a category', () => {
    renderCat();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.getByRole('button', { name: 'Add to category' })).toBeTruthy();
  });

  it('creates a name and assigns the session to it in one go', () => {
    renderCat();
    openCategoryPanel();
    const field = screen.getByRole('textbox', { name: /new category name/i });
    fireEvent.change(field, { target: { value: 'Fleet' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(categoryOfSession('s1')).toBe('Fleet');
    expect(categoryNames()).toEqual(['Fleet']);
  });

  // THE case David will actually hit, and the one the exact-session-identity
  // work exists to make possible: two sessions in the same repo, each with
  // its own id because applyExactMatches resolved each pid from its live
  // session file, filed under two different names. A shared cwd is not a
  // barrier -- this test is what says so.
  it('files two sessions sharing a folder under two different categories', () => {
    const { unmount } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
      onReattach={neverReattach()} onResume={neverResume()} compact
      state={{ ...matched, pid: 101, cwd: '/repo', sessionId: 's1', match: 'unique' }} />);
    openCategoryPanel();
    let field = screen.getByRole('textbox', { name: /new category name/i });
    fireEvent.change(field, { target: { value: 'Review' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    unmount();

    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
      onReattach={neverReattach()} onResume={neverResume()} compact
      state={{ ...matched, pid: 102, cwd: '/repo', sessionId: 's2', match: 'unique' }} />);
    openCategoryPanel();
    field = screen.getByRole('textbox', { name: /new category name/i });
    fireEvent.change(field, { target: { value: 'Shipping' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(categoryOfSession('s1')).toBe('Review');
    expect(categoryOfSession('s2')).toBe('Shipping');
    expect(categoryNames()).toEqual(['Review', 'Shipping']);
  });

  it('names the current category on the menu item once assigned', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.getByRole('button', { name: 'Category: Fleet' })).toBeTruthy();
  });

  it('assigns to a name another session already created', () => {
    assignCategory('other', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(categoryOfSession('s1')).toBe('Fleet');
  });

  it('marks the current category as the chosen one', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    expect(screen.getByRole('button', { name: 'Fleet' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears the category through No category, leaving the name standing', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'No category' }));
    expect(categoryOfSession('s1')).toBeNull();
    expect(categoryNames()).toEqual(['Fleet']);
  });

  it('renames a category, and the session follows the new name', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Fleet' }));
    const field = screen.getByRole('textbox', { name: /new name for Fleet/i });
    fireEvent.change(field, { target: { value: 'Shipping' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(categoryOfSession('s1')).toBe('Shipping');
  });

  it('says why a rename was refused rather than failing silently', () => {
    assignCategory('other', 'Review');
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Fleet' }));
    const field = screen.getByRole('textbox', { name: /new name for Fleet/i });
    fireEvent.change(field, { target: { value: 'Review' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText(/already a category/i)).toBeTruthy();
    expect(categoryOfSession('s1')).toBe('Fleet');
  });

  // The spec's rule, and the UI half of it: "The UI shows why, rather than
  // hiding the option."
  it('blocks Delete while a live session holds the name, and explains it on the button', () => {
    assignCategory('s1', 'Fleet');
    renderCat();
    openCategoryPanel();
    const del = screen.getByRole('button', { name: 'Delete Fleet' });
    expect(del).toBeDisabled();
    const why = screen.getByText(/a session is in Fleet/i);
    expect(del).toHaveAttribute('aria-describedby', why.getAttribute('id'));
    expect(categoryNames()).toEqual(['Fleet']);
  });

  it('deletes a name that nothing holds', () => {
    assignCategory('other', 'Fleet');
    // The rail prunes on every fleet push; here the session simply is not live.
    pruneAssignments(['s1']);
    renderCat();
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Fleet' }));
    expect(categoryNames()).toEqual([]);
  });

  // Disabled WITH THE REASON VISIBLE, not hidden and not in a title
  // attribute -- a tooltip explains nothing to anyone on a keyboard or a
  // screen reader, the same call this app already makes for the Codex
  // reattach line and the name field in the launch dropdown.
  it('says a folder is shared, when that is why it cannot file this one', () => {
    renderCat({ sessionId: null, match: 'ambiguous' });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    const item = screen.getByRole('button', { name: 'Add to category' });
    expect(item).toBeDisabled();
    const why = screen.getByText(/several sessions share this folder/i);
    expect(why.textContent).toMatch(/cannot tell which one this is/i);
    expect(item).toHaveAttribute('aria-describedby', why.getAttribute('id'));
  });

  // The other cause of a null sessionId, and a different sentence: nothing
  // matched this process at all, which is not the same as too much matching.
  it('says no conversation was matched, when THAT is why', () => {
    renderCat({ sessionId: null, match: 'unknown' });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.getByRole('button', { name: 'Add to category' })).toBeDisabled();
    expect(screen.getByText(/no conversation matched to this process yet/i)).toBeTruthy();
  });

  it('shows no reason at all once the session is uniquely matched', () => {
    renderCat();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(screen.queryByText(/several sessions share this folder/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to category' })).not.toBeDisabled();
  });

  it('never opens the session when a category control is clicked', () => {
    const onOpen = vi.fn();
    render(<OpenSessionCard onOpen={onOpen} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} compact state={matched} />);
    openCategoryPanel();
    fireEvent.click(screen.getByRole('button', { name: 'No category' }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
```

Add imports at the top of the file:

```tsx
import {
  reloadGroups, categoryNames, categoryOfSession, assignCategory, pruneAssignments,
} from '../../src/renderer/state/groups.ts';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/OpenSessionCard.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: FAIL — no button named "Add to category"; the three exact-list assertions also fail until the item exists.

- [ ] **Step 3: Write minimal implementation**

In `OpenSessionCard.tsx`, add the import:

```tsx
import {
  useGroups, categoryNames, categoryOfSession, assignCategory, renameCategory,
  deleteCategory, categoryInUse, MAX_CATEGORY_LENGTH,
} from '../state/groups.ts';
```

Add alongside the component's existing hooks, next to the `useFavourites()` block:

```tsx
  // Categories are keyed by SESSION ID, not by folder -- David's explicit
  // call (spec's identity ruling): "to session id. It can be temp. If clear
  // or session exit its lost." The store is the same shared singleton the
  // rail reads, so filing a session here re-heads its row with no reload.
  //
  // Sharing a folder does NOT stop a session being filed. applyExactMatches
  // (src/discovery/match.ts) overrides the cwd guess with an exact
  // pid-to-session identity wherever one exists -- Claude's live session
  // file, Codex's open root rollout -- so two sessions in one folder
  // normally each have their own id and each take their own category.
  //
  // `sessionId` is null only when neither of those resolved: no live session
  // file and no open rollout, in practice a session this app did not launch
  // and that predates the file. Rare, but real, and there is no stable
  // handle to hang an assignment off in that state -- so the item is
  // DISABLED with the reason VISIBLE rather than hidden: say why in the UI,
  // the same rule the Codex reattach text follows.
  useGroups();
  const sessionId = state.sessionId;
  const currentCategory = sessionId === null ? null : categoryOfSession(sessionId);
  const [catOpen, setCatOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
```

The existing menu button must reset the panel each time it opens, so reopening the menu never lands mid-rename:

```tsx
            onClick={() => { setMenuOpen(o => !o); setCatOpen(false); setRenaming(null); setRenameError(null); }}
```

Inside the existing `{menuOpen && (<div className="cardmenu-list"> ... </div>)}` block, add the category item immediately BEFORE the favourites item:

```tsx
              <button type="button" className="cardmenu-item"
                disabled={sessionId === null}
                aria-describedby={sessionId === null ? `catwhy-${state.pid}` : undefined}
                onClick={() => setCatOpen(true)}>
                {currentCategory === null ? 'Add to category' : `Category: ${currentCategory}`}
              </button>
              {sessionId === null && (
                <p className="catwhy" id={`catwhy-${state.pid}`}>{categoryBlockedReason}</p>
              )}
```

and define the reason above, beside the other derived values:

```tsx
  // Disabled WITH THE REASON VISIBLE, never a title attribute: a tooltip
  // explains nothing to anyone on a keyboard or a screen reader, and this
  // app already makes that call for the Codex reattach line and for the
  // launch dropdown's name field.
  //
  // Two different causes, two different sentences, because they call for
  // different things from the reader. 'ambiguous' means several sessions
  // share this folder and the app will not attribute a category to a guess
  // -- David can still file them one at a time from each session's OWN card
  // once they are distinguishable. 'unknown' means no conversation has been
  // matched to this process at all, which usually resolves itself as soon as
  // the session is prompted. Collapsing them into one "unavailable" would
  // teach the reader nothing about which of the two they are looking at.
  const categoryBlockedReason = state.match === 'ambiguous'
    ? 'Several sessions share this folder, so the app cannot tell which one this is. A category needs one session to attach to.'
    : 'No conversation matched to this process yet, so there is nothing to attach a category to.';
```

and render the panel as a sibling of `.cardmenu-list`, inside the same `.cardmenu` box so the existing Escape / click-outside effect closes it too:

```tsx
          {menuOpen && catOpen && sessionId !== null && (
            <div className="cardmenu-list catpanel" role="group" aria-label="Category">
              {/* One category per session, so this is a chosen-one list, not
                  a set of checkboxes: aria-pressed marks which name is the
                  session's, and picking another simply replaces it. */}
              <button type="button" className="catitem"
                aria-pressed={currentCategory === null}
                onClick={() => { assignCategory(sessionId, null); setMenuOpen(false); }}>
                No category
              </button>

              {categoryNames().map((name, i) => (
                renaming === name ? (
                  <label className="catedit" key={name}>
                    <span className="catlabel">New name for {name}</span>
                    <input type="text" defaultValue={name} autoFocus maxLength={MAX_CATEGORY_LENGTH}
                      onKeyDown={e => {
                        if (e.key === 'Escape') { setRenaming(null); setRenameError(null); return; }
                        if (e.key !== 'Enter') return;
                        // renameCategory rewrites every assignment pointing
                        // at the old name in one commit, so a rename can
                        // never orphan a session. It refuses a name already
                        // taken rather than merging two categories -- that
                        // is a different decision, and not reversible.
                        if (renameCategory(name, e.currentTarget.value) === null) {
                          setRenameError('That is already a category, or the name is blank.');
                          return;
                        }
                        setRenaming(null);
                        setRenameError(null);
                      }} />
                  </label>
                ) : (
                  <div className="catrow" key={name}>
                    <button type="button" className="catitem catpick"
                      aria-pressed={currentCategory === name}
                      onClick={() => { assignCategory(sessionId, name); setMenuOpen(false); }}>
                      {name}
                    </button>
                    {/* Named with the category, not bare "Rename": this list
                        repeats the same two buttons per row, and bare names
                        would be indistinguishable in the accessibility
                        tree -- the same rule the per-card Close button
                        already follows. */}
                    <button type="button" className="catmini"
                      aria-label={`Rename ${name}`}
                      onClick={() => { setRenaming(name); setRenameError(null); }}>
                      Rename
                    </button>
                    <button type="button" className="catmini catdanger"
                      aria-label={`Delete ${name}`}
                      disabled={categoryInUse(name)}
                      aria-describedby={categoryInUse(name) ? `catuse-${state.pid}-${i}` : undefined}
                      onClick={() => { deleteCategory(name); }}>
                      Delete
                    </button>
                    {/* Shown, not hidden: the spec's rule is that the UI
                        says WHY delete is unavailable. Because the rail
                        prunes assignments against the live session list on
                        every push, anything still holding a name is a live
                        session by construction. */}
                    {categoryInUse(name) && (
                      <p className="catwhy" id={`catuse-${state.pid}-${i}`}>
                        A session is in {name}. Move it out first.
                      </p>
                    )}
                  </div>
                )
              ))}

              {renameError && <p className="catwhy" role="alert">{renameError}</p>}

              {/* Creating and assigning are ONE action: assignCategory adds
                  the name when it is new, so there is no window in which a
                  created name exists with nothing pointing at it because the
                  second half failed. A name outliving its assignments is
                  what pruning produces later, on purpose. */}
              <label className="catedit">
                <span className="catlabel">New category name</span>
                <input type="text" placeholder="New category" maxLength={MAX_CATEGORY_LENGTH}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { setCatOpen(false); return; }
                    if (e.key !== 'Enter') return;
                    if (e.currentTarget.value.trim() === '') return;
                    assignCategory(sessionId, e.currentTarget.value);
                    setMenuOpen(false);
                  }} />
              </label>
            </div>
          )}
```

Append to `src/renderer/components/OpenSessionCard.css`:

```css
/* The category picker reuses .cardmenu-list's popover box (same position,
   same shadow, same width floor) and only adds what a two-column row with
   its own controls needs. It REPLACES the item list rather than nesting
   inside it: a submenu would need roving focus and an escape path of its
   own, which this app's popovers deliberately do not implement (see the
   note on why the items are plain buttons, not role="menuitem"). */
.catpanel { min-width: 200px; gap: 2px; }
.catrow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.catitem { flex: 1 1 auto; text-align: left; font-family: var(--f-mono); font-size: 11px;
  color: var(--ink-2); background: none; border: 0; border-radius: 5px; padding: 6px 9px;
  cursor: pointer; white-space: nowrap; }
.catitem:hover { background: var(--raised); color: var(--ink); }
/* The chosen one is marked by weight and colour, never by colour alone --
   the same standard the unread left border is held to. */
.catitem[aria-pressed="true"] { color: var(--ink); font-weight: 600; background: var(--raised); }
.catmini { flex: none; font-family: var(--f-mono); font-size: 10px; color: var(--muted);
  background: none; border: 1px solid transparent; border-radius: 5px; padding: 3px 6px;
  cursor: pointer; }
.catmini:hover { color: var(--ink); border-color: var(--line); }
.catdanger:hover { color: var(--critical); }
.catmini:disabled { opacity: .5; cursor: default; }
.catmini:disabled:hover { color: var(--muted); border-color: transparent; }
/* Wraps onto its own full-width line under the row it explains, so the
   reason is read next to the button it is about. */
.catwhy { flex: 1 0 100%; margin: 0; font-size: 10.5px; line-height: 1.4; color: var(--muted); }
.catedit { display: block; padding: 2px; }
.catedit input { width: 100%; box-sizing: border-box; font-family: var(--f-mono); font-size: 11px;
  color: var(--ink); background: var(--ground); border: 1px solid var(--line);
  border-radius: 5px; padding: 6px 8px; }
/* Same clip-path technique as SessionRail.css's own hidden status word,
   duplicated rather than shared for the same reason it is there: this app
   has no global utility sheet, and a field needs a real label, not a
   placeholder -- a placeholder is not an accessible name. */
.catlabel { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/OpenSessionCard.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: PASS, including the three updated exact-menu assertions.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/OpenSessionCard.tsx src/renderer/components/OpenSessionCard.css tests/renderer/OpenSessionCard.test.tsx
git commit -m "feat(rail): file a session under a category from the card menu"
```

---

### Task 7: Category sections in the rail

**Files:**
- Modify: `src/fleet/order.ts` (append `railSections`)
- Modify: `src/renderer/components/SessionRail.tsx`
- Modify: `src/renderer/components/SessionRail.css`
- Test: `tests/fleet/order.test.ts`, `tests/renderer/SessionRail.test.tsx`

**Interfaces:**
- Consumes: `RailRow`, `Groupable`, `groupByFolder`, `applyStableOrder` (Task 2); `categoryOfSession`, `orderIndex`, `rememberKeys` (Task 1).
- Produces, in `src/fleet/order.ts`: `pidRowKey(pid: number): string`, `type RailSection<T> = { name: string | null; rows: RailRow<T>[] }`, `railSections<T extends Groupable>(sessions: T[], categoryOf: (session: T) => string | null, indexOf: (key: string) => number, stacking: boolean): RailSection<T>[]`.
- Produces, in `src/renderer/state/groups.ts`: `categoryForRow(session: { pid: number; sessionId: string | null }): string | null` — the one place that answers "which handle does a category hang off", so Task 8 can add the launch-time fallback there without touching the transform.

**Two rules this task implements.**

**1. Categorising a session PULLS IT OUT of its folder stack.** A folder holding three sessions, one of them filed under "Review", renders as a Review section with that one card in it, plus a stack of the remaining two. If only one session is left in the folder there is no stack at all — it is a plain card, per the stacking rule. The rejected alternative was showing the whole stack under a category when any member carries it, which puts one row in two places at once.

**2. The setting governs FOLDER STACKING ONLY.** Sections and manual row order apply whether it is on or off, so this task replaces Task 5's `rows === null` branch with a `stacking` flag threaded into the transform. Task 5's version was a valid intermediate; from here the transform always runs.

That has one consequence worth stating, because it is a real limit rather than an oversight. With stacking OFF, a folder holding several sessions produces one row per session, and those rows cannot be keyed by the folder — they would collide. They are keyed `pid:<n>` instead, which `rememberKeys` treats as ephemeral, so their manual position lasts the sitting and not a restart. A folder holding ONE session keeps its folder key and its position survives, exactly as with stacking on. There is no stable per-row identity for co-located sessions once they are not collapsed, so this is inherent, not a shortcut.

- [ ] **Step 1: Write the failing test**

Append to `tests/fleet/order.test.ts`:

```ts
import { railSections, pidRowKey } from '../../src/fleet/order.ts';

type C = { pid: number; cwd: string | null; sessionId: string | null };
const c = (pid: number, cwd: string | null, sessionId: string | null): C => ({ pid, cwd, sessionId });
// railSections never reads sessionId itself -- the caller's lookup decides
// what a category hangs off, which is what lets Task 8 add the launch-time
// pending fallback without changing this transform at all. These helpers
// stand in for groups.ts's categoryForRow.
const byId = (f: (id: string) => string | null) => (s: C) => (s.sessionId === null ? null : f(s.sessionId));
const noOrder = () => Number.MAX_SAFE_INTEGER;

describe('railSections', () => {
  it('returns one unnamed section when nothing is categorised', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')], () => null, noOrder, true);
    expect(got.map(sec => sec.name)).toEqual([null]);
    expect(got[0].rows.map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('returns nothing for no sessions', () => {
    expect(railSections([], () => null, noOrder, true)).toEqual([]);
  });

  // The core ruling: three in one folder, one categorised.
  it('pulls a categorised session out of its folder, leaving a stack of the rest', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/a', 's2'), c(3, '/a', 's3')];
    const got = railSections(sessions, byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
    expect(got[0].rows).toHaveLength(1);
    expect(got[0].rows[0].kind).toBe('session');
    expect(got[0].rows[0].key).toBe(pidRowKey(2));
    const rest = got[1].rows[0];
    if (rest.kind !== 'stack') throw new Error('expected a stack');
    expect(rest.members.map(m => m.pid)).toEqual([1, 3]);
  });

  it('leaves a plain card, not a stack of one, when the pull-out empties the folder', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/a', 's2')];
    const got = railSections(sessions, byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got[1].rows[0].kind).toBe('session');
    expect(got[1].rows[0].key).toBe('/a');
  });

  it('leaves no uncategorised section at all when the folder empties completely', () => {
    const got = railSections([c(1, '/a', 's1')], () => 'Review', noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review']);
  });

  it('gives each categorised session its own row, never a stack, even in one folder', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')], () => 'Review', noOrder, true);
    expect(got).toHaveLength(1);
    expect(got[0].rows.map(r => r.kind)).toEqual(['session', 'session']);
  });

  // The case a shared repo actually produces: both sessions carry their own
  // id (applyExactMatches resolved each pid from its live session file), so
  // they file separately and the folder is left with nothing to stack.
  it('splits two sessions in ONE folder into two different sections', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')],
      byId(id => (id === 's1' ? 'Review' : 'Shipping')), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', 'Shipping']);
    expect(got[0].rows.map(r => r.key)).toEqual([pidRowKey(1)]);
    expect(got[1].rows.map(r => r.key)).toEqual([pidRowKey(2)]);
  });

  it('puts the uncategorised section LAST, however early its rows appear', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/b', 's2')];
    const got = railSections(sessions, byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
  });

  it('orders named sections by where their first row sits', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/b', 's2')];
    const index = (k: string) => (k === pidRowKey(2) ? 0 : 1);
    const got = railSections(sessions, byId(id => (id === 's1' ? 'One' : 'Two')), index, true);
    expect(got.map(sec => sec.name)).toEqual(['Two', 'One']);
  });

  it('honours the stored order inside a section', () => {
    const sessions = [c(1, '/a', 's1'), c(2, '/b', 's2')];
    const index = (k: string) => (k === '/b' ? 0 : 1);
    const got = railSections(sessions, () => 'One', index, true);
    expect(got[0].rows.map(r => r.key)).toEqual([pidRowKey(2), pidRowKey(1)]);
  });

  // Whether a session can be categorised at all is the LOOKUP's business,
  // not this transform's -- which is what lets Task 8 add the launch-time
  // pending fallback without touching a line here. This only proves the
  // transform respects whatever the lookup says.
  it('leaves a session in its folder whenever the lookup declines it', () => {
    const got = railSections([c(1, '/a', null), c(2, '/a', 's2')],
      byId(id => (id === 's2' ? 'Review' : null)), noOrder, true);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
    expect(got[1].rows[0].key).toBe('/a');
  });

  it('treats a blank category name as no category', () => {
    const got = railSections([c(1, '/a', 's1')], () => '', noOrder, true);
    expect(got.map(sec => sec.name)).toEqual([null]);
  });
});

// The setting is folder stacking and nothing else: sections and manual order
// still apply with it off.
describe('railSections with stacking off', () => {
  it('gives each session in a shared folder its own row', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')], () => null, noOrder, false);
    expect(got[0].rows.map(r => r.kind)).toEqual(['session', 'session']);
  });

  // They cannot share the folder key -- two rows with one key collide in
  // React's reconciler and in the stored order alike.
  it('keys those rows by pid, since the folder key belongs to neither alone', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/a', 's2')], () => null, noOrder, false);
    expect(got[0].rows.map(r => r.key)).toEqual(['pid:1', 'pid:2']);
  });

  it('leaves a folder holding ONE session on its folder key, so its position survives', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')], () => null, noOrder, false);
    expect(got[0].rows.map(r => r.key)).toEqual(['/a', '/b']);
  });

  it('still heads a categorised session with its category', () => {
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')],
      byId(id => (id === 's1' ? 'Review' : null)), noOrder, false);
    expect(got.map(sec => sec.name)).toEqual(['Review', null]);
  });

  it('still honours the stored order', () => {
    const index = (k: string) => (k === '/b' ? 0 : 1);
    const got = railSections([c(1, '/a', 's1'), c(2, '/b', 's2')], () => null, index, false);
    expect(got[0].rows.map(r => r.key)).toEqual(['/b', '/a']);
  });
});
```

Append to `tests/renderer/SessionRail.test.tsx`'s `folder grouping` describe:

```tsx
  it('heads a categorised session with its category name', () => {
    assignCategory('s1', 'Fleet');
    renderRail();
    expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
  });

  it('gives uncategorised rows no header at all, not an Other bucket', () => {
    renderRail();
    expect(screen.queryByRole('heading', { name: /other/i })).toBeNull();
  });

  it('pulls the categorised session out, leaving its folder-mate as a plain card', () => {
    assignCategory('s1', 'Fleet');
    renderRail();
    expect(screen.queryByText(/\d+ sessions/)).toBeNull();
    expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
    expect(screen.getByLabelText(/Close, pid 2/)).toBeTruthy();
  });

  // The setting is folder stacking only. A category David set must not
  // disappear because he turned stacking off.
  it('still heads a categorised session when stacking is off', () => {
    assignCategory('s1', 'Fleet');
    setSettings({ groupSessions: 'off' });
    renderRail();
    expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
    expect(screen.queryByText('2 sessions')).toBeNull();
  });

  // An assignment for a session that is not in the fleet is not the rail's
  // problem to clean up (Task 8 prunes it on the fleet push) -- but it must
  // never PAINT anything, because a header with no card under it would be a
  // category David cannot get rid of.
  it('renders nothing for an assignment whose session is not in the fleet', () => {
    assignCategory('gone', 'Ghosts');
    renderRail();
    expect(screen.queryByRole('heading', { name: 'Ghosts' })).toBeNull();
  });
```

Extend the file's groups import to `reloadGroups, assignCategory, categoryOfSession`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fleet/order.test.ts tests/renderer/SessionRail.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `railSections is not a function`; no heading named "Fleet".

- [ ] **Step 3: Write minimal implementation**

Append to `src/fleet/order.ts`:

```ts
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
```

Append to `src/renderer/state/groups.ts`, below `categoryOfSession`:

```ts
/** The category a ROW shows, as opposed to the one a session is assigned.
 *
 *  The two are the same today, and this function exists so that they can
 *  stop being the same in Task 8 without any other file learning about it:
 *  a category chosen at launch is held against a pid until discovery
 *  resolves a session id, and this is the one place that fallback will be
 *  added. Everything that renders a row asks here.
 *
 *  Takes the session rather than a session id precisely so that the pid is
 *  available when that day comes. */
export function categoryForRow(session: { pid: number; sessionId: string | null }): string | null {
  return session.sessionId === null ? null : categoryOfSession(session.sessionId);
}
```

and its tests, appended to the `category names and assignments` describe in `tests/renderer/groups.test.ts`:

```ts
  it('reports the row category of an assigned session', () => {
    assignCategory('s1', 'Fleet');
    expect(categoryForRow({ pid: 1, sessionId: 's1' })).toBe('Fleet');
  });

  it('reports none for a session that has no id to be assigned by', () => {
    expect(categoryForRow({ pid: 1, sessionId: null })).toBeNull();
  });

  // Sharing a folder is not a barrier: applyExactMatches gives each pid its
  // own session id from its live session file, so each files separately.
  it('keeps two sessions in one folder on their own categories', () => {
    assignCategory('s1', 'Review');
    assignCategory('s2', 'Shipping');
    expect(categoryForRow({ pid: 101, sessionId: 's1' })).toBe('Review');
    expect(categoryForRow({ pid: 102, sessionId: 's2' })).toBe('Shipping');
  });
```

Add `categoryForRow` to that file's import list.

In `SessionRail.tsx`, change the order.ts import to bring in `railSections` (`groupByFolder` and `applyStableOrder` are now reached through it and are no longer imported here):

```tsx
import { compareOpenSessions, railSections } from '../../fleet/order.ts';
import {
  useGroups, isStackOpen, toggleStack, orderIndex, rememberKeys, categoryForRow,
} from '../state/groups.ts';
```

Replace Task 5's `rows` / `rowKeys` block with:

```tsx
  // The transform ALWAYS runs. `grouping` is folder stacking and nothing
  // else -- sections and David's own row order apply either way, because
  // "not auto movement for the cards" was stated unconditionally and a
  // category he set must not vanish because he turned stacking off. This
  // replaces Task 5's `rows === null` branch, which switched off too much.
  const sections = railSections(displaySessions, categoryForRow, orderIndex, grouping);

  // Pruning a dead assignment is NOT done here. It belongs on the fleet push
  // itself, which useFleet owns (Task 8) -- this component is not mounted in
  // every view, and an assignment's lifetime must not depend on which pane
  // happens to be on screen. Until Task 8 lands, an assignment simply
  // outlives its session; nothing renders for it, because rows are built
  // from the live sessions, not from the map.
  //
  // The join/split below is how a string dependency stands in for an array
  // one: useEffect compares deps by identity, and a fresh array each render
  // would fire it forever.
  const rowKeys = sections.flatMap(sec => sec.rows.map(r => r.key)).join('\n');
  useEffect(() => {
    if (rowKeys !== '') rememberKeys(rowKeys.split('\n'));
  }, [rowKeys]);
```

`renderSession` no longer needs its own `key` on the session branch below, because each row already carries one — leave Task 5's `key={s.pid}` in place for now; Task 9 moves it onto the row wrapper.

And replace the `.railcards` block:

```tsx
      <div className="railcards">
        {sections.map(section => (
          // The key for the unnamed section cannot collide with a real name,
          // which normalizeGroups guarantees is trimmed and non-empty -- a
          // leading space is therefore unreachable.
          <div className="railsection" key={section.name ?? ' uncategorised'}>
            {section.name !== null && <h2 className="railsectionname">{section.name}</h2>}
            {section.rows.map(row => (
              row.kind === 'session'
                ? renderSession(row.session)
                : <StackCard key={row.key} cwd={row.cwd} members={row.members}
                    open={isStackOpen(row.cwd)} onToggle={toggleStack}
                    selectedPid={selectedPid} renderMember={renderSession}
                    onAnswer={onAnswer} />
            ))}
          </div>
        ))}
      </div>
```

Task 5's "does not group when the setting is off" test still passes unchanged — with stacking off there is no "2 sessions" face and both cards render, which is exactly what it asserts.

Append to `SessionRail.css`:

```css
/* A category header is typography and a rule, nothing more -- no colour, no
   icon, no swatch. The spec's "a name and nothing else" is a decision, not a
   first draft: the rail already spends its colour budget on attention state,
   and a second colour system would compete with the one thing this app
   exists to show. */
.railsection { display: flex; flex-direction: column; gap: 6px; }
.railsection + .railsection { margin-top: 14px; }
.railsectionname {
  font-family: var(--f-mono); font-size: 10.5px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink-2); margin: 0;
  display: flex; align-items: center; gap: 9px;
  /* min-width:0 plus the overflow rule is what keeps a 32-character name
     from pushing the rail's own content past its border at the 140px
     minimum width -- the same failure a long project name already had. */
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.railsectionname::after {
  content: ""; flex: 1 0 12px; height: 1px; background: var(--line-soft);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fleet/order.test.ts tests/renderer/SessionRail.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npx vitest run --maxWorkers=2 --minWorkers=1 && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/fleet/order.ts src/renderer/components/SessionRail.tsx src/renderer/components/SessionRail.css tests/fleet/order.test.ts tests/renderer/SessionRail.test.tsx
git commit -m "feat(rail): head categorised sessions with their category, pulled out of their stack"
```

---

### Task 8: A category at launch, and the fleet-push handoff

**Files:**
- Modify: `src/renderer/state/groups.ts` (append the pending-binding map)
- Modify: `src/renderer/state/useFleet.ts`
- Modify: `src/renderer/components/LaunchBar.tsx`
- Modify: `src/renderer/components/LaunchBar.css`
- Test: `tests/renderer/groups.test.ts`, `tests/renderer/useFleet.test.tsx`, `tests/renderer/LaunchBar.test.tsx`

**Interfaces:**
- Consumes: `assignCategory`, `pruneAssignments`, `categoryNames`, `categoryOfSession`, `MAX_CATEGORY_LENGTH` (Task 1).
- Produces: `bindPendingCategory(pid: number, name: string): void`, `resolvePendingCategories(live: { pid: number; sessionId: string | null }[]): void`, and the pending fallback inside `categoryForRow` (Task 7).

**The problem this task solves, and why it is not the naming path.** A category can be set from BOTH surfaces the app already has: the card menu on a running session (Task 6) and the launch dropdown shipped in `dd304d5`. The launch path cannot work the way naming does. A session NAME is handed to the CLI at spawn (`claude -n <name>`) and lives in the CLI's own state. A category is app-side only, and at spawn there is no session id to key it to: `launchSession` returns `{ status: 'launched'; pid: number }` and nothing else (`src/main/launch.ts:12-21`).

The gap is not small. Claude Code writes nothing indexable until the first prompt — measured on David's machine at 11 seconds for one session and 11 minutes for another. A session that is launched and never prompted has no session id at all.

**So a launch-time category is held against the PID and transferred to the session id once discovery resolves it.** The pid is safe here and only here: the app spawned this exact process and holds its pid directly, and the binding is discarded the moment it resolves or the app exits. It is a handoff, never storage — it is a module-scoped `Map` that is deliberately NOT part of `GroupsState` and therefore never reaches localStorage. If the process dies before a session id is ever known, the binding is dropped: nothing is retried and nothing is shown.

**This task also moves pruning onto the fleet push**, where the spec puts it, and where the pending handoff has to live anyway. `useFleet` is the single subscriber to `fleet:update`; `SessionRail` is not mounted in every view, and an assignment's lifetime must not depend on which pane is on screen.

**The category field is enabled for Codex, unlike the name field.** The name is disabled there because `codex --help` carries no launch-time name flag. A category never touches the CLI, so that limitation does not apply.

**A pending binding is also what the row DISPLAYS, not just what it will become.** `categoryForRow` (Task 7) gains the fallback `assignments[sessionId] ?? pendingByPid[pid]`, so a category David typed at launch heads its row immediately and quietly upgrades to the stored assignment when discovery resolves the session id. Without that, a launch-time category is invisible for however long the first prompt takes — 11 seconds or 11 minutes — and on the fallback path, where no live session file or rollout ever resolves, it would be invisible forever. Task 7 keyed a categorised row by its PID precisely so this upgrade changes no key: the same card stays mounted in the same slot, and nothing flickers or doubles.

- [ ] **Step 1: Write the failing test**

Append to `tests/renderer/groups.test.ts`:

```ts
describe('pending launch-time categories', () => {
  it('transfers the binding to the session id discovery resolves the pid to', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  // Typing a name into the launch field IS the name-creation act; it is not
  // the assignment. So the name exists at once, trimmed and capped like any
  // other, and is offered to every other session straight away.
  it('creates the name at once, before anything resolves', () => {
    bindPendingCategory(4821, '  Fleet  ');
    expect(categoryNames()).toEqual(['Fleet']);
    expect(getGroups().assignments).toEqual({});
  });

  it('offers that name to a SECOND session while the first is still pending', () => {
    bindPendingCategory(4821, 'Fleet');
    // Nothing has resolved, and yet another session can already be filed
    // under it -- the gap this ruling closes.
    assignCategory('s2', 'Fleet');
    expect(categoryNames()).toEqual(['Fleet']);
    expect(categoryOfSession('s2')).toBe('Fleet');
  });

  it('reuses an existing name rather than duplicating it', () => {
    assignCategory('s1', 'Fleet');
    bindPendingCategory(4821, 'Fleet');
    expect(categoryNames()).toEqual(['Fleet']);
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryNames()).toEqual(['Fleet']);
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  it('refuses a brand-new name at the cap, and binds nothing', () => {
    for (let i = 0; i < MAX_CATEGORIES; i++) assignCategory(`s${i}`, `c${i}`);
    bindPendingCategory(4821, 'one more');
    expect(categoryNames()).toHaveLength(MAX_CATEGORIES);
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBeNull();
  });

  it('holds the binding while the session id is still unknown', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: null }]);
    expect(getGroups().assignments).toEqual({});
    // Still pending, so the SAME binding lands once the id appears -- which
    // can be minutes later, and is unbounded if nobody ever prompts.
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  it('holds the binding while the pid has not been discovered yet', () => {
    bindPendingCategory(4821, 'Fleet');
    // Discovery sweeps on a timer, so the first push after a launch can
    // easily not contain the pid the app just spawned. Dropping there would
    // lose the binding of every fast launch.
    resolvePendingCategories([{ pid: 999, sessionId: 'other' }]);
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  it('two concurrent launches never cross their bindings', () => {
    bindPendingCategory(4821, 'Fleet');
    bindPendingCategory(4822, 'Review');
    resolvePendingCategories([
      { pid: 4821, sessionId: 'sa' },
      { pid: 4822, sessionId: 'sb' },
    ]);
    expect(categoryOfSession('sa')).toBe('Fleet');
    expect(categoryOfSession('sb')).toBe('Review');
  });

  it('resolves one of two launches without disturbing the one still waiting', () => {
    bindPendingCategory(4821, 'Fleet');
    bindPendingCategory(4822, 'Review');
    resolvePendingCategories([
      { pid: 4821, sessionId: 'sa' },
      { pid: 4822, sessionId: null },
    ]);
    expect(categoryOfSession('sa')).toBe('Fleet');
    resolvePendingCategories([{ pid: 4822, sessionId: 'sb' }]);
    expect(categoryOfSession('sb')).toBe('Review');
  });

  it('drops a binding whose process died before any session id was known', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: null }]); // seen, still nameless
    resolvePendingCategories([{ pid: 999, sessionId: 'other' }]); // gone
    // Proof it is gone rather than merely unresolved: a later push carrying
    // that very pid assigns nothing.
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBeNull();
  });

  // The two halves have different lifetimes, and this is where that shows:
  // the assignment is gone, the name David typed is not. A leftover name
  // attached to nothing is exactly the state his delete rule was written
  // for -- one click removes it.
  it('leaves the NAME behind when a binding dies, attached to nothing and deletable', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: null }]);
    resolvePendingCategories([{ pid: 999, sessionId: 'other' }]);
    expect(categoryNames()).toEqual(['Fleet']);
    expect(getGroups().assignments).toEqual({});
    expect(categoryInUse('Fleet')).toBe(false);
    expect(deleteCategory('Fleet')).toBe(true);
  });

  // The BINDING is the handoff, and it is what may never be persisted. The
  // name is not a binding, and names were always persisted.
  it('writes the name but never the binding', () => {
    bindPendingCategory(4821, 'Fleet');
    const stored = JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY)!);
    expect(stored.categories).toEqual(['Fleet']);
    expect(stored.assignments).toEqual({});
    // Nothing anywhere in the serialized blob names the pid.
    expect(JSON.stringify(stored)).not.toContain('4821');
  });

  it('is forgotten entirely on a reload, the way an app restart forgets it', () => {
    bindPendingCategory(4821, 'Fleet');
    reloadGroups();
    expect(categoryForRow({ pid: 4821, sessionId: null })).toBeNull();
    // The name survives the restart; only the binding does not.
    expect(categoryNames()).toEqual(['Fleet']);
  });

  it('ignores a blank name rather than binding an unlabelled category', () => {
    bindPendingCategory(4821, '   ');
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryNames()).toEqual([]);
  });

  it('ignores an empty live list, which also means "not discovered yet"', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([]);
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBe('Fleet');
  });
});

// What a row SHOWS, which is not the same question as what is stored.
describe('categoryForRow with a pending binding', () => {
  it('shows a launch-time category before any session id exists', () => {
    bindPendingCategory(4821, 'Fleet');
    expect(categoryForRow({ pid: 4821, sessionId: null })).toBe('Fleet');
  });

  it('keeps showing it on the fallback path, where no session id ever arrives', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: null }]);
    expect(categoryForRow({ pid: 4821, sessionId: null })).toBe('Fleet');
  });

  it('shows the stored assignment once discovery resolves the pid', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryForRow({ pid: 4821, sessionId: 's9' })).toBe('Fleet');
  });

  // The assignment wins, so a category changed from the card menu takes
  // effect at once rather than being masked by a stale pending entry.
  it('prefers the assignment over a binding that somehow outlived it', () => {
    bindPendingCategory(4821, 'Fleet');
    assignCategory('s9', 'Review');
    expect(categoryForRow({ pid: 4821, sessionId: 's9' })).toBe('Review');
  });

  it('shows nothing for a row with neither', () => {
    expect(categoryForRow({ pid: 4821, sessionId: null })).toBeNull();
  });

  it('shows nothing once the binding is dropped', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: null }]); // seen
    resolvePendingCategories([{ pid: 999, sessionId: 'other' }]); // gone
    expect(categoryForRow({ pid: 4821, sessionId: null })).toBeNull();
  });

  // The map lives outside `current`, so nothing else can tell a subscriber
  // that a row's category changed. Without these the rail would only catch
  // up on an unrelated re-render.
  it('notifies subscribers on a bind, so the header appears at once', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeGroups(cb);
    bindPendingCategory(4821, 'Fleet');
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('notifies subscribers when a binding is dropped with nothing assigned', () => {
    bindPendingCategory(4821, 'Fleet');
    resolvePendingCategories([{ pid: 4821, sessionId: null }]);
    const cb = vi.fn();
    const unsubscribe = subscribeGroups(cb);
    resolvePendingCategories([{ pid: 999, sessionId: 'other' }]);
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
```

Extend that file's import list with `bindPendingCategory`, `resolvePendingCategories` and `categoryForRow`.

Append to `tests/renderer/SessionRail.test.tsx`'s `folder grouping` describe — the rendered half of the same rule, and the one that proves the upgrade does not remount the card:

```tsx
  it('heads a launched session with its category before any session id exists', () => {
    bindPendingCategory(1, 'Fleet');
    renderRail([{ ...(twoInOneFolder[0] as object), sessionId: null }] as never[]);
    expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
  });

  it('upgrades to the stored assignment without remounting the card or doubling the header', () => {
    bindPendingCategory(1, 'Fleet');
    const pending = [{ ...(twoInOneFolder[0] as object), sessionId: null }] as never[];
    const { container, rerender } = render(
      <SessionRail sessions={pending} selectedPid={null} onSelect={() => {}} onKill={noopKill}
        onReattach={noopReattach} onResume={noopResume} side="left" />,
    );
    const cardBefore = container.querySelector('.card');

    // Discovery names the pid, exactly as useFleet's own effect would.
    const named = [{ ...(twoInOneFolder[0] as object), sessionId: 's1' }] as never[];
    resolvePendingCategories([{ pid: 1, sessionId: 's1' }]);
    rerender(
      <SessionRail sessions={named} selectedPid={null} onSelect={() => {}} onKill={noopKill}
        onReattach={noopReattach} onResume={noopResume} side="left" />,
    );

    expect(screen.getAllByRole('heading', { name: 'Fleet' })).toHaveLength(1);
    expect(container.querySelectorAll('.card')).toHaveLength(1);
    // The SAME DOM node: React only reuses it when the row key is unchanged,
    // so this is what proves the pid key survives the upgrade. A session-id
    // key would fail here, and the card would visibly flash and lose its slot.
    expect(container.querySelector('.card')).toBe(cardBefore);
  });
```

Extend that file's groups import with `bindPendingCategory` and `resolvePendingCategories`.

Append to `tests/renderer/useFleet.test.tsx`:

```tsx
describe('useFleet category bookkeeping', () => {
  const session = (pid: number, sessionId: string | null) => ({
    pid, sessionId, provider: 'claude', host: 'iterm2', cwd: '/a', project: 'a',
    name: null, ageSeconds: 1, rssBytes: 1, match: 'unique', lastProse: null,
    events: null, agents: null, liveAgents: null, activity: 'idle', tmux: false,
    junk: false, context: null,
  });

  function pushFleet(openSessions: unknown[]) {
    const listFleet = vi.fn().mockResolvedValue({ version: 1, generatedAt: 't', openSessions });
    (globalThis as any).window.fleet = { listFleet, onFleet: vi.fn().mockReturnValue(() => {}) };
    return renderHook(() => useFleet());
  }

  beforeEach(() => { localStorage.clear(); reloadGroups(); });
  afterEach(() => { delete (globalThis as any).window.fleet; });

  it('transfers a launch-time binding the first time the push carries a session id', async () => {
    bindPendingCategory(4821, 'Fleet');
    const { result } = pushFleet([session(4821, 's9')]);
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    await waitFor(() => expect(categoryOfSession('s9')).toBe('Fleet'));
  });

  // The whole of "it can be temp": /clear mints an id that was never
  // assigned, and an exited session stops appearing in the push.
  it('prunes an assignment whose session is no longer in the push', async () => {
    assignCategory('gone', 'Fleet');
    assignCategory('s9', 'Fleet');
    const { result } = pushFleet([session(4821, 's9')]);
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    await waitFor(() => expect(categoryOfSession('gone')).toBeNull());
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  it('prunes nothing on an empty push, which is also what "not discovered yet" looks like', async () => {
    assignCategory('s9', 'Fleet');
    const { result } = pushFleet([]);
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    expect(categoryOfSession('s9')).toBe('Fleet');
  });
});
```

Add to that file's imports: `beforeEach`, `afterEach` from vitest, and

```tsx
import {
  reloadGroups, assignCategory, categoryOfSession, bindPendingCategory,
} from '../../src/renderer/state/groups.ts';
```

Append to `tests/renderer/LaunchBar.test.tsx`, inside the describe that already defines `openOptions()`:

```tsx
  it('offers a category field in the dropdown, alongside the name', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    expect(screen.getByLabelText('Category')).toBeTruthy();
  });

  // The name field is disabled for Codex because the CLI has no name flag.
  // A category never touches the CLI, so that reason does not carry over.
  it('keeps the category field usable for Codex, where the name field is not', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    openOptions();
    expect((screen.getByLabelText('Session name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Category') as HTMLInputElement).disabled).toBe(false);
  });

  it('offers the categories that already exist, without forcing one', () => {
    assignCategory('somewhere', 'Fleet');
    const { container } = render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    const field = screen.getByLabelText('Category') as HTMLInputElement;
    const list = container.querySelector(`datalist#${field.getAttribute('list')}`);
    expect([...list!.querySelectorAll('option')].map(o => o.getAttribute('value'))).toEqual(['Fleet']);
  });

  it('files the new session under the typed category once discovery names it', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() => expect(launch).toHaveBeenCalled());
    // The NAME exists at once -- typing it was the creation act. The
    // ASSIGNMENT does not, because there is no session id at spawn.
    expect(categoryNames()).toEqual(['Fleet']);
    expect(getGroups().assignments).toEqual({});
    // The push that finally resolves pid 4821 is what files it.
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBe('Fleet');
  });

  // The picker, rendered: a name typed for one launch is immediately on
  // offer for the next one, with nothing resolved in between.
  it('offers a just-launched category in the dropdown for the next launch', async () => {
    const { container } = render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch with this name' }));
    await waitFor(() => expect(launch).toHaveBeenCalled());

    openOptions();
    const field = screen.getByLabelText('Category') as HTMLInputElement;
    expect(field.value).toBe(''); // the panel was cleared, as it always is
    const list = container.querySelector(`datalist#${field.getAttribute('list')}`);
    expect([...list!.querySelectorAll('option')].map(o => o.getAttribute('value'))).toEqual(['Fleet']);
  });

  it('carries no category from the main Launch half, which opens no panel', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(launch).toHaveBeenCalled());
    resolvePendingCategories([{ pid: 4821, sessionId: 's9' }]);
    expect(categoryOfSession('s9')).toBeNull();
  });

  it('discards a typed category when the panel is closed without launching', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    openOptions();
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('');
  });

  it('keeps a typed category when the provider is switched, since it never reaches the CLI', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    openOptions();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Fleet' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    expect((screen.getByLabelText('Category') as HTMLInputElement).value).toBe('Fleet');
  });
```

Add to that file's `beforeEach` (it already clears localStorage for favourites) and imports:

```tsx
import {
  reloadGroups, assignCategory, categoryNames, categoryOfSession, getGroups, resolvePendingCategories,
} from '../../src/renderer/state/groups.ts';
```

and call `reloadGroups()` beside the existing `reloadFavourites()` in the file's top-level `beforeEach`, adding `localStorage.clear()` there if it is not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/groups.test.ts tests/renderer/useFleet.test.tsx tests/renderer/LaunchBar.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: FAIL — `bindPendingCategory is not a function`; no form control labelled "Category".

- [ ] **Step 3: Write minimal implementation**

Append to `src/renderer/state/groups.ts`, below `pruneAssignments`:

```ts
/** A category chosen at LAUNCH time, waiting for a session id to attach to.
 *
 *  This is the one place a pid is an acceptable key, and the two reasons do
 *  not hold anywhere else in this feature: the app spawned this exact
 *  process and holds its pid directly, and the binding lives seconds to
 *  minutes, where the pid-recycling problem in the spec's identity ruling
 *  needs hours.
 *
 *  It is a HANDOFF, NOT STORAGE. It is deliberately not a field of
 *  GroupsState, so it can never be serialized: nothing about it survives a
 *  restart, which is exactly what the spec asks for. `seen` is what tells a
 *  process that has DIED apart from one that discovery has simply not swept
 *  up yet -- discovery runs on a timer, so the first push after a launch
 *  routinely does not contain the pid the app just spawned, and dropping
 *  there would lose the binding of every fast launch. */
type PendingCategory = { name: string; seen: boolean };
const pendingByPid = new Map<number, PendingCategory>();

/** Holds `name` against a pid the app has just spawned, and CREATES the name
 *  if it is new.
 *
 *  Creating it is not a side effect -- it is David's own two-things model
 *  applied literally. A name and an assignment are separate, with separate
 *  lifetimes, which is the entire basis of "deletable if not attached to a
 *  session". Typing "Fleet" into the launch field IS the name-creation act;
 *  it is not the assignment. So the NAME lands in `categories` at once,
 *  persisted, exactly as if it had been created from a card menu, and is
 *  offered to every other session immediately. The ASSIGNMENT stays pending,
 *  in memory, unpersisted, and dies with the pid.
 *
 *  A name that already exists is reused, never duplicated. The cap is
 *  enforced here as it is in assignCategory, and for the same reason: a new
 *  name is refused rather than silently displacing one David is using.
 *
 *  An existing name still NOTIFIES even though it writes nothing, and that
 *  is not optional: this map is deliberately outside `current`, so
 *  useSyncExternalStore has no way to learn that a row's category just
 *  changed. Without it the new session's header would appear only when
 *  something unrelated happened to re-render the rail -- which it does
 *  today, by coincidence, because onLaunched changes the selection. Relying
 *  on that coincidence is how a feature breaks the day launch is touched.
 *
 *  This also makes the store's own invariant EASIER to hold, not harder:
 *  every assignment value must be a name in the list, and now the name
 *  exists before the assignment that will point at it ever does. */
export function bindPendingCategory(pid: number, name: string): void {
  const clean = cleanName(name);
  if (clean === '') return;
  const known = current.categories.includes(clean);
  if (!known && current.categories.length >= MAX_CATEGORIES) return;
  pendingByPid.set(pid, { name: clean, seen: false });
  if (known) { for (const listener of listeners) listener(); return; }
  commit({ ...current, categories: [...current.categories, clean] });
}

/** Transfers every pending binding whose pid discovery has now resolved to a
 *  session id, and drops the ones whose process is gone. Called on every
 *  fleet push (useFleet), beside pruneAssignments.
 *
 *  Three outcomes per binding, and the middle one is the whole point:
 *  - the pid carries a session id  -> assign, and forget the binding;
 *  - the pid is present with none  -> keep waiting. Claude Code writes
 *    nothing indexable until the first prompt, measured at 11 seconds for
 *    one session and 11 minutes for another, and unbounded if nobody ever
 *    prompts;
 *  - the pid is absent, having been seen before -> the process died before
 *    it was ever nameable. Drop it. Nothing is retried and nothing is shown:
 *    there is no session left to show it on.
 *
 *  An EMPTY live list is ignored for the same reason pruneAssignments
 *  ignores it: "nothing running" and "nothing discovered yet" arrive here as
 *  the same empty array, and treating the second as the first would throw
 *  away a binding made moments earlier. */
export function resolvePendingCategories(live: { pid: number; sessionId: string | null }[]): void {
  if (pendingByPid.size === 0 || live.length === 0) return;
  const sessionIdByPid = new Map(live.map(s => [s.pid, s.sessionId]));
  // A binding dropped with nothing assigned changes what a row displays but
  // writes nothing, so like bindPendingCategory it has to notify by hand --
  // the assign path below notifies through commit() already.
  let droppedWithoutAssigning = false;
  // Snapshotted, because the loop deletes from the map it is reading.
  for (const [pid, pending] of [...pendingByPid]) {
    if (!sessionIdByPid.has(pid)) {
      if (pending.seen) { pendingByPid.delete(pid); droppedWithoutAssigning = true; }
      continue;
    }
    const sessionId = sessionIdByPid.get(pid) ?? null;
    if (sessionId === null || sessionId === '') {
      pending.seen = true;
      continue;
    }
    pendingByPid.delete(pid);
    // The same call the card menu makes, so a launch-time category and a
    // menu-set one are the same thing in the store -- there is no second
    // kind of assignment to keep in step. It commits, which notifies.
    assignCategory(sessionId, pending.name);
  }
  if (droppedWithoutAssigning) for (const listener of listeners) listener();
}
```

Replace `categoryForRow` (Task 7) with the version that falls back to the binding — this is the whole reason that function exists and takes the session rather than a session id:

```ts
/** The category a ROW shows, as opposed to the one a session is assigned.
 *
 *  `assignments[sessionId] ?? pendingByPid[pid]`, in that order. A category
 *  chosen at launch therefore heads its row IMMEDIATELY and upgrades to the
 *  stored assignment the moment discovery resolves the session id. Without
 *  the fallback it would be invisible for as long as the first prompt takes
 *  -- 11 seconds once and 11 minutes another time on David's machine -- and
 *  on the fallback path, where no live session file or open rollout ever
 *  resolves the pid, it would be invisible for good.
 *
 *  The upgrade changes nothing else: the row is keyed by PID (order.ts's
 *  pidRowKey), so the same card stays mounted in the same slot and there is
 *  no flicker and no second row.
 *
 *  The assignment WINS over the binding rather than the other way round, so
 *  re-filing the session from the card menu takes effect at once instead of
 *  being masked by a pending entry that outlived its usefulness. In practice
 *  the two never coexist -- resolvePendingCategories deletes and assigns in
 *  the same call -- but the order makes that safe rather than lucky. */
export function categoryForRow(session: { pid: number; sessionId: string | null }): string | null {
  if (session.sessionId !== null) {
    const assigned = current.assignments[session.sessionId];
    if (assigned !== undefined) return assigned;
  }
  return pendingByPid.get(session.pid)?.name ?? null;
}
```

and add one line to `reloadGroups`, so a test's reset clears the handoff too:

```ts
export function reloadGroups(): void {
  current = read();
  // Never called in production; in a test it must leave nothing behind,
  // including a binding that would otherwise resolve into the next test.
  pendingByPid.clear();
  for (const listener of listeners) listener();
}
```

In `src/renderer/state/useFleet.ts`, import the two store functions and add one effect after the existing `seenEvents` effect:

```tsx
// groups.ts imports nothing but react -- safe from the renderer, unlike
// fleet/state.ts, which reaches node:os and the database.
import { pruneAssignments, resolvePendingCategories } from './groups.ts';
```

```tsx
  // Category bookkeeping belongs on the fleet push, and this hook is the
  // single subscriber to fleet:update -- SessionRail is not mounted in every
  // view, and neither of these may depend on which pane is on screen.
  //
  // Resolve first, then prune: resolve only ever assigns a session id that
  // is in THIS push, so the prune below can never undo what it just did.
  useEffect(() => {
    if (!payload) return;
    const open = payload.openSessions;
    if (open.length === 0) return;
    resolvePendingCategories(open);
    pruneAssignments(
      open.map(s => s.sessionId).filter((id): id is string => id !== null && id !== ''),
    );
  }, [payload]);
```

In `src/renderer/components/LaunchBar.tsx`, add the import and the field state:

```tsx
import { bindPendingCategory, categoryNames, MAX_CATEGORY_LENGTH } from '../state/groups.ts';
```

```tsx
  // A category set as the session starts -- the second of the two entry
  // points the launch control was built as a dropdown for. Unlike `name`
  // above, this NEVER reaches the CLI: it is app-side only, which is why it
  // stays usable for Codex, where the name field cannot be.
  const [category, setCategory] = useState('');
```

Clear it with the rest of the panel, so a closed panel leaves nothing invisible behind:

```tsx
  function cancelOptions(): void {
    setNameOpen(false);
    setName('');
    setCategory('');
  }
```

The provider `<select>` keeps clearing `name` and deliberately does NOT clear `category` — a name is provider-specific and a category is not. Leave that handler as it is.

Rename `launch`'s second parameter, which now governs both dropdown fields rather than the name alone, and update its two call sites in the dropdown from `launch(undefined, true)` (unchanged in form; only the parameter's name changes):

```tsx
  async function launch(targetDir?: string, fromOptions = false): Promise<void> {
    const dir = (targetDir ?? cwd).trim();
    if (blocked) { setMessage(launchable?.reason ?? 'That provider is not available right now.'); return; }
    if (dir === '') { setMessage('Choose a working directory first.'); return; }
    const wanted = fromOptions && nameable ? name.trim() : '';
    // Read BEFORE the await: cancelOptions below clears the field, and the
    // binding has to be made from what was typed, not from what is left.
    const wantedCategory = fromOptions ? category.trim() : '';
```

and bind it on success, before the panel is cleared:

```tsx
      if (r.status === 'launched') {
        // Held against the PID, because there is no session id yet and will
        // not be until the first prompt. useFleet transfers it the moment
        // discovery resolves this pid to one; if the process dies first, the
        // binding is dropped and nothing is shown for it.
        if (wantedCategory !== '') bindPendingCategory(r.pid, wantedCategory);
        setCwd('');
        cancelOptions();
        onLaunched(r.pid);
        return;
      }
```

Add the field to the dropdown, after the existing name `<small>` and before `.launchdrop-row`:

```tsx
            <label>
              Category
              {/* A text field with a datalist rather than a select: one
                  control both picks an existing category and creates a new
                  one, which is what the card menu needs two controls for.
                  Native, so it needs no popover, no focus management and no
                  new component. NOT disabled for Codex -- see above. */}
              <input type="text" list="launchcats" value={category} disabled={pending}
                maxLength={MAX_CATEGORY_LENGTH} placeholder="None"
                onChange={e => setCategory(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void launch(undefined, true);
                }} />
              <datalist id="launchcats">
                {categoryNames().map(n => <option key={n} value={n} />)}
              </datalist>
            </label>
            <small>Filed in the app only, and dropped if the session is cleared or ends.</small>
```

Append to `src/renderer/components/LaunchBar.css`:

```css
/* The category field sits under the name field in the same panel and takes
   the same shape, so the two read as one set of launch options rather than
   two mechanisms -- even though only one of them reaches the CLI. */
.launchdrop datalist { display: none; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/groups.test.ts tests/renderer/useFleet.test.tsx tests/renderer/LaunchBar.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npx vitest run --maxWorkers=2 --minWorkers=1 && npm run typecheck`
Expected: all tests pass; typecheck clean. `tests/renderer/bundle.test.ts` is the one that would catch a Node import reaching the renderer — `groups.ts` imports only react, so it must stay green.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/state/groups.ts src/renderer/state/useFleet.ts src/renderer/components/LaunchBar.tsx src/renderer/components/LaunchBar.css tests/renderer/groups.test.ts tests/renderer/useFleet.test.tsx tests/renderer/LaunchBar.test.tsx
git commit -m "feat(launch): set a category as a session starts, bound to its pid until discovery names it"
```

---

### Task 9: Reorder rows by drag, and by keyboard

**Files:**
- Modify: `src/renderer/components/SessionRail.tsx`
- Modify: `src/renderer/components/SessionRail.css`
- Modify: `src/renderer/components/OpenSessionCard.tsx`
- Modify: `src/renderer/components/StackCard.tsx`, `src/renderer/components/StackCard.css`
- Test: `tests/renderer/SessionRail.test.tsx`, `tests/renderer/OpenSessionCard.test.tsx`, `tests/renderer/StackCard.test.tsx`

**Interfaces:**
- Consumes: `moveRow` (Task 1); `RailSection`, `RailRow` (Tasks 2, 7).
- Produces: `onMoveUp?: () => void` and `onMoveDown?: () => void` on `OpenSessionCard` and on `StackCard`. No new exports.

**The rules this task implements.**

- **A whole row is the drag unit.** A stack moves with its members. You cannot drag a session out of a stack — folder membership is derived from `cwd` and is not David's to rearrange. (Pulling a session out of a stack is what giving it a category does.)
- **Dropping rewrites the persisted `order` array and nothing else.** That array is already the single source of row position, so drag adds no second ordering concept and no new stored state.
- **No drag library.** Native `draggable`/`dragstart`/`dragover`/`drop`.
- **A drop is only accepted inside the row's own section, and this is a ruling rather than a limitation.** The tempting alternative — make a cross-section drop assign that category — cannot be made to work: a stack row holds several sessions, and an assignment is one session to one name, so the gesture would succeed for a lone card and silently do nothing for a stack. The same gesture must not mean two different things depending on what is under the cursor. Refusing both is consistent, and categorising stays where it can be explicit: the card's own menu. Mechanically the refusal is just not calling `preventDefault` on `dragover`, so the browser shows the "no drop" cursor for free.
- **Drag alone is unreachable by keyboard**, which nothing else in this rail is — the resize handle already takes arrow keys. So Move up / Move down also appear on the row itself, calling the SAME `moveRow` the drop calls, with the neighbour taken from the rendered section so dead keys in storage cannot make it skip.

- [ ] **Step 1: Write the failing test**

Append to `tests/renderer/StackCard.test.tsx`:

```tsx
describe('StackCard move controls', () => {
  const members = [session(1, 'idle'), session(2, 'idle')];

  it('offers nothing when the handlers are absent, so nothing else changes', () => {
    render(<StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
      selectedPid={null} renderMember={() => null} />);
    expect(screen.queryByRole('button', { name: /^Move repo/ })).toBeNull();
  });

  // Named with the folder for the same reason every other repeated control
  // in this rail is: several stacks would otherwise offer identical buttons.
  it('moves the row up and down through the handlers it is given', () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    render(<StackCard cwd="/repo" members={members} open={false} onToggle={vi.fn()}
      selectedPid={null} renderMember={() => null} onMoveUp={onMoveUp} onMoveDown={onMoveDown} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move repo up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move repo down' }));
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(onMoveDown).toHaveBeenCalledTimes(1);
  });

  it('does not fold or unfold the stack when a move button is clicked', () => {
    const onToggle = vi.fn();
    render(<StackCard cwd="/repo" members={members} open={false} onToggle={onToggle}
      selectedPid={null} renderMember={() => null} onMoveUp={vi.fn()} onMoveDown={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move repo up' }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
```

Append to the `the category menu item` sibling area of `tests/renderer/OpenSessionCard.test.tsx` as its own describe:

```tsx
describe('the move menu items', () => {
  function renderMovable(props: Record<string, unknown> = {}) {
    return render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} compact state={base} {...props} />);
  }

  // Absent unless wired, so every existing menu assertion in this file --
  // which renders the card without them -- keeps its exact item list.
  it('adds nothing to the menu when no move handlers are given', () => {
    const { container } = renderMovable();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect([...container.querySelectorAll('.cardmenu-item')].map(b => b.textContent))
      .not.toContain('Move up');
  });

  it('offers Move up and Move down, and closes the menu after one', () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    const { container } = renderMovable({ onMoveUp, onMoveDown });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.cardmenu-list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
    expect(onMoveDown).toHaveBeenCalledTimes(1);
  });

  it('never opens the session when a move item is clicked', () => {
    const onOpen = vi.fn();
    renderMovable({ onOpen, onMoveUp: vi.fn(), onMoveDown: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
```

Append to `tests/renderer/SessionRail.test.tsx` as its own describe:

```tsx
describe('reordering rows', () => {
  const three = [
    { pid: 1, project: 'a-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 'sa' },
    { pid: 2, project: 'b-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 'sb' },
    { pid: 3, project: 'c-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 'sc' },
  ] as never[];

  const renderThree = () => render(
    <SessionRail sessions={three} selectedPid={null} onSelect={() => {}} onKill={noopKill}
      onReattach={noopReattach} onResume={noopResume} side="left" />,
  );

  // jsdom implements no DataTransfer, and Chromium/Firefox both refuse to
  // start a drag with nothing on the transfer -- so the component sets data
  // and the test supplies the object it sets it on.
  const transfer = () => ({ setData: vi.fn(), getData: () => '', effectAllowed: '', dropEffect: '' });

  const namesOf = (container: HTMLElement) =>
    [...container.querySelectorAll('.proj')].map(p => p.textContent);

  beforeEach(() => {
    localStorage.clear();
    reloadGroups();
    reloadSettings();
  });

  it('marks every row draggable', () => {
    const { container } = renderThree();
    expect(container.querySelectorAll('.railrow[draggable="true"]')).toHaveLength(3);
  });

  it('moves a dragged row into the slot it is dropped on', () => {
    const { container } = renderThree();
    const rows = container.querySelectorAll('.railrow');
    const dt = transfer();
    fireEvent.dragStart(rows[0], { dataTransfer: dt });
    fireEvent.dragOver(rows[2], { dataTransfer: dt });
    fireEvent.drop(rows[2], { dataTransfer: dt });
    expect(namesOf(container)).toEqual(['b-proj', 'c-proj', 'a-proj']);
  });

  it('keeps the new order across a re-render, because it is the stored order', () => {
    const { container, rerender } = renderThree();
    const rows = container.querySelectorAll('.railrow');
    const dt = transfer();
    fireEvent.dragStart(rows[2], { dataTransfer: dt });
    fireEvent.drop(rows[0], { dataTransfer: dt });
    rerender(
      <SessionRail sessions={three} selectedPid={null} onSelect={() => {}} onKill={noopKill}
        onReattach={noopReattach} onResume={noopResume} side="left" />,
    );
    expect(namesOf(container)).toEqual(['c-proj', 'a-proj', 'b-proj']);
  });

  it('does nothing when a row is dropped on itself', () => {
    const { container } = renderThree();
    const rows = container.querySelectorAll('.railrow');
    const dt = transfer();
    fireEvent.dragStart(rows[1], { dataTransfer: dt });
    fireEvent.drop(rows[1], { dataTransfer: dt });
    expect(namesOf(container)).toEqual(['a-proj', 'b-proj', 'c-proj']);
  });

  // Ruled, not merely unimplemented: making this drop ASSIGN the category
  // would work for a lone card and do nothing for a stack, which holds
  // several sessions and cannot take one assignment. One gesture, two
  // meanings, is worse than one gesture the user can see is refused.
  it('refuses a drop into another category section', () => {
    assignCategory('sa', 'Fleet');
    const { container } = renderThree();
    const rows = container.querySelectorAll('.railrow');
    const dt = transfer();
    fireEvent.dragStart(rows[0], { dataTransfer: dt }); // the Fleet row
    fireEvent.drop(rows[2], { dataTransfer: dt });      // an uncategorised row
    expect(namesOf(container)).toEqual(['a-proj', 'b-proj', 'c-proj']);
  });

  it('moves a row up from its own menu, the same way a drop would', () => {
    const { container } = renderThree();
    fireEvent.click(screen.getAllByRole('button', { name: /session actions/i })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    expect(namesOf(container)).toEqual(['b-proj', 'a-proj', 'c-proj']);
  });

  it('moves a row down from its own menu', () => {
    const { container } = renderThree();
    fireEvent.click(screen.getAllByRole('button', { name: /session actions/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
    expect(namesOf(container)).toEqual(['b-proj', 'a-proj', 'c-proj']);
  });

  it('offers no Move up on the first row of a section, and no Move down on the last', () => {
    renderThree();
    fireEvent.click(screen.getAllByRole('button', { name: /session actions/i })[0]);
    expect(screen.queryByRole('button', { name: 'Move up' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move down' })).toBeTruthy();
  });

  // The setting is folder stacking only: order is David's either way.
  it('still reorders when stacking is off', () => {
    setSettings({ groupSessions: 'off' });
    const { container } = renderThree();
    expect(container.querySelectorAll('.railrow')).toHaveLength(3);
    fireEvent.click(screen.getAllByRole('button', { name: /session actions/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
    expect(namesOf(container)).toEqual(['b-proj', 'a-proj', 'c-proj']);
  });
});
```

Extend the file's groups import to include `assignCategory` if Task 7 has not already added it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/StackCard.test.tsx tests/renderer/OpenSessionCard.test.tsx tests/renderer/SessionRail.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: FAIL — no `.railrow` elements, no button named "Move up".

- [ ] **Step 3: Write minimal implementation**

In `OpenSessionCard.tsx`, add the two optional props to the destructure and the prop type:

```tsx
export function OpenSessionCard({ state, onOpen, onKill, onReveal, onReattach, onResume, unread, compact = false, cmdIndex, onMoveUp, onMoveDown }: {
  // ... existing props unchanged ...
  /** Move this row one place up / down in the rail's own order, calling the
   *  SAME store function a drop calls (groups.ts's moveRow) -- the keyboard
   *  half of dragging, which is otherwise unreachable without a pointer.
   *
   *  Each is absent when the row is already at that end of its section, and
   *  BOTH are absent for every caller that does not order rows at all (the
   *  fleet grid, and the rail with grouping off), so no existing call site
   *  grows a menu item it has no meaning for. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
```

and render them at the TOP of the existing `.cardmenu-list`, above the Show-in-host item:

```tsx
              {onMoveUp && (
                <button type="button" className="cardmenu-item"
                  onClick={() => { setMenuOpen(false); onMoveUp(); }}>
                  Move up
                </button>
              )}
              {onMoveDown && (
                <button type="button" className="cardmenu-item"
                  onClick={() => { setMenuOpen(false); onMoveDown(); }}>
                  Move down
                </button>
              )}
```

In `StackCard.tsx`, add the same two props:

```tsx
  /** The keyboard half of dragging, exactly as OpenSessionCard's own pair.
   *  Rendered as two small buttons on the face rather than behind a "..."
   *  popover of their own: a two-item popover would need its own Escape and
   *  click-outside handling -- machinery this app writes once per popover,
   *  not a shared component -- to reach two controls that fit on the face as
   *  they are. Absent when the row is at that end of its section. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
```

and render them inside `.stackface`, after the Answer button:

```tsx
        {(onMoveUp || onMoveDown) && (
          <div className="stackmove">
            {onMoveUp && (
              <button type="button" aria-label={`Move ${label} up`} onClick={onMoveUp}>Up</button>
            )}
            {onMoveDown && (
              <button type="button" aria-label={`Move ${label} down`} onClick={onMoveDown}>Down</button>
            )}
          </div>
        )}
```

Append to `StackCard.css`:

```css
/* A sibling of .stacktoggle, not a child: the toggle is a button, and a
   button inside a button is invalid HTML that browsers silently un-nest,
   which would drop these two controls out of the face entirely. */
.stackmove { flex: none; display: flex; flex-direction: column; gap: 4px; }
.stackmove button {
  font-family: var(--f-mono); font-size: 10px; color: var(--muted);
  background: none; border: 1px solid var(--line); border-radius: 5px;
  padding: 3px 7px; cursor: pointer;
}
.stackmove button:hover { color: var(--ink); border-color: var(--accent); }
```

In `SessionRail.tsx`, import `moveRow` from the store and the `RailRow` type from order.ts, then add the drag state and the row wrapper. `renderSession` gains the two handlers and loses its own `key` (the wrapper carries it now):

```tsx
import { compareOpenSessions, railSections, type RailRow } from '../../fleet/order.ts';
import {
  useGroups, isStackOpen, toggleStack, orderIndex, rememberKeys, categoryForRow, moveRow,
} from '../state/groups.ts';
```

`RailRow` is a type-only member of that import list, erased at build — order.ts has no Node imports either way, so this is safe regardless.

```tsx
  // Which row is currently being dragged. Component state, not the store:
  // it lasts for the length of one gesture and nothing outside this rail has
  // any use for it.
  const [dragKey, setDragKey] = useState<string | null>(null);

  // Which section each row is in, so a drop can be refused across a section
  // boundary. Built from the sections that were just computed rather than by
  // asking the store again, so the map and the render can never disagree.
  const sectionOfKey = new Map<string, string | null>();
  for (const section of sections) {
    for (const row of section.rows) sectionOfKey.set(row.key, section.name);
  }

  /** Moves `key` one place within its OWN section, using the neighbour as it
   *  is rendered rather than the neighbour in storage -- the stored order
   *  outlives the rows in it, so an adjacent stored key may be a folder with
   *  nothing running in it and stepping onto that would look like a skip. */
  function moveWithinSection(rows: RailRow<OpenSession>[], key: string, delta: -1 | 1): void {
    const i = rows.findIndex(r => r.key === key);
    const target = rows[i + delta];
    if (target === undefined) return;
    moveRow(key, target.key);
  }

  function dragProps(key: string): React.HTMLAttributes<HTMLDivElement> & { draggable: true } {
    return {
      draggable: true,
      onDragStart: e => {
        setDragKey(key);
        // Chromium and Firefox both refuse to start a drag with nothing on
        // the transfer, so this is required even though the payload is
        // never read back -- dragKey above is the real handle.
        e.dataTransfer.setData('text/plain', key);
        e.dataTransfer.effectAllowed = 'move';
      },
      // preventDefault on dragover is what marks an element as a valid drop
      // target. NOT calling it is therefore how a drop is refused, and the
      // browser shows the "no drop" cursor for free.
      onDragOver: e => {
        if (dragKey === null || dragKey === key) return;
        if (sectionOfKey.get(dragKey) !== sectionOfKey.get(key)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDrop: e => {
        e.preventDefault();
        if (dragKey !== null && dragKey !== key
          && sectionOfKey.get(dragKey) === sectionOfKey.get(key)) {
          // The ONE function the menu items call too, so drag and keyboard
          // can never drift into two different notions of "one place up".
          moveRow(dragKey, key);
        }
        setDragKey(null);
      },
      // Fires whether the drag landed or was abandoned, so the handle is
      // always cleared -- a stale dragKey would make the next click-drag
      // start from the wrong row.
      onDragEnd: () => setDragKey(null),
    };
  }
```

`renderSession` takes the two handlers and no longer sets a key:

```tsx
  function renderSession(
    s: OpenSession,
    move?: { up?: () => void; down?: () => void },
  ): JSX.Element {
    const waiting = s.activity === 'waiting_permission' || s.activity === 'waiting_input';
    const unread = isUnread(s);
    return (
      <div className={s.pid === selectedPid ? 'railitem sel' : 'railitem'}>
        <OpenSessionCard state={s} onOpen={onSelect} onKill={onKill} onReveal={onReveal}
          onReattach={onReattach} onResume={onResume} unread={unread} compact={compact}
          cmdIndex={cmdIndexByPid?.get(s.pid)} onMoveUp={move?.up} onMoveDown={move?.down} />
        {waiting && (
          <button type="button" className="railreply"
            aria-label={`Answer ${s.project}, pid ${s.pid}`}
            onClick={() => onAnswer?.(s.pid)}>
            Answer
          </button>
        )}
      </div>
    );
  }
```

Every row gets the wrapper, with stacking on or off — the setting governs folder stacking, and row order is David's either way:

```tsx
      <div className="railcards">
        {sections.map(section => (
          <div className="railsection" key={section.name ?? ' uncategorised'}>
            {section.name !== null && <h2 className="railsectionname">{section.name}</h2>}
            {section.rows.map((row, i) => {
              // Absent at each end of the section rather than present and
              // disabled: a menu item that is always there and sometimes does
              // nothing is worse than one that is only offered when it can act.
              const move = {
                up: i > 0 ? () => moveWithinSection(section.rows, row.key, -1) : undefined,
                down: i < section.rows.length - 1
                  ? () => moveWithinSection(section.rows, row.key, 1) : undefined,
              };
              return (
                <div className={`railrow${dragKey === row.key ? ' dragging' : ''}`}
                  key={row.key} {...dragProps(row.key)}>
                  {row.kind === 'session'
                    ? renderSession(row.session, move)
                    : <StackCard cwd={row.cwd} members={row.members}
                        open={isStackOpen(row.cwd)} onToggle={toggleStack}
                        selectedPid={selectedPid} renderMember={renderSession}
                        onAnswer={onAnswer} onMoveUp={move.up} onMoveDown={move.down} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
```

Note `renderMember={renderSession}`: passed as the one-argument callback `StackCard` declares, so a member card gets no move handlers — a session inside a stack cannot be reordered, because the drag unit is the whole row.

Append to `SessionRail.css`:

```css
/* The drag wrapper. It carries no box of its own -- the card inside it still
   draws every border and background -- so adding this layer changes nothing
   visually until a drag is actually in progress. */
.railrow { position: relative; }
/* Feedback while dragging comes from opacity alone, not a transform: a
   transform on an ancestor opens a stacking context, and OpenSessionCard.css
   already documents at length what that does to an open card menu. */
.railrow.dragging { opacity: .45; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/StackCard.test.tsx tests/renderer/OpenSessionCard.test.tsx tests/renderer/SessionRail.test.tsx --maxWorkers=2 --minWorkers=1`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npx vitest run --maxWorkers=2 --minWorkers=1 && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/SessionRail.tsx src/renderer/components/SessionRail.css src/renderer/components/OpenSessionCard.tsx src/renderer/components/StackCard.tsx src/renderer/components/StackCard.css tests/renderer/SessionRail.test.tsx tests/renderer/OpenSessionCard.test.tsx tests/renderer/StackCard.test.tsx
git commit -m "feat(rail): drag rows into order, with Move up and Move down for the keyboard"
```

---

## After the last task: look at it

The suite passing is not the finish line for a rendered surface. jsdom computes no layout and paints nothing, so every drag, every overflow and every stacking-context question below is invisible to it. Launch the dev app (tmux session `workspace-app`, `npm run dev`; a main-process change needs C-c and a restart there, and verify exactly ONE Electron main is running afterwards) and check by eye:

**Stacks**

1. Two sessions in one folder fold into one row; the face states what they are doing.
2. Opening a stack pushes the rows below it down, and the stack is STILL open after quitting and relaunching the app.
3. A folder whose session is waiting shows the attention treatment while folded, and its Answer button works from the face.
4. A folder with two waiting members shows the count and NO Answer button.

**Categories**

5. Filing a session under a new name pulls it out of its folder: the category header appears with that one card under it, and the folder row below drops from a stack of three to a stack of two.
6. Filing the second-to-last session out of a folder leaves a plain card behind, not a stack of one.
7. Uncategorised rows sit at the bottom with no header and no "Other" label.
8. Rename a category: the header changes and the card stays under it.
9. Delete is greyed out while a session holds the name, and the reason is readable next to it. Move the session out and Delete works.
10. `/clear` inside a categorised session: within one fleet push (5s) the card drops back out of its section. Quit that session entirely: same.
11. Restart the app with a categorised session still running: it is still in its category.

**Categories at launch**

12. Open the launch dropdown, type a category, launch. The card appears under that header **straight away**, from the pending binding — there is no session id yet, and it should not matter. Watch it for a minute or two. When the first prompt is typed and discovery resolves the session id, the card must not flash, jump, or briefly appear twice: the upgrade is meant to be invisible. If you see it blink, the row key is changing and the pid-key rule has been broken somewhere.
13. Launch with a category and never prompt: the card stays under its header for the whole life of the app. Quit and relaunch the app: the card is uncategorised again, because the binding was never storage — but the NAME is still in the picker, because typing it created it. Neither is a bug; both are the design.
14. Launch with a category, then quit the session before prompting: the card and its header go together, and the name stays in the picker attached to nothing. Open any card menu: Delete is ENABLED for it, and one click removes it. That is the state David's delete rule was written for.
15. Switch the provider to Codex: the name field is disabled with its reason, and the category field is still usable.
16. Launch two sessions back to back under two different categories: each lands in its own.
17. Type a category, then close the dropdown without launching: reopening it shows an empty field.

**Order and drag**

18. Drag a row up and down. It lands where it was dropped, and it is still there after quitting and relaunching.
19. Drag a STACK. It moves with its members, still folded.
20. Try to drag a member OUT of an open stack: the stack row moves, not the member.
21. Try to drag a row into a different category section: the drop is refused (no-drop cursor), and nothing moves.
22. Tab to a card's `...` menu and use Move up / Move down with the keyboard alone. The row moves the same one place a drop would. The first row offers no Move up; the last offers no Move down.
23. A session that starts waiting while you watch changes colour and wording but does NOT change position.

**The setting, and the narrow rail**

24. Turn the setting off. Stacks unfold into one card per session — and that is ALL that changes: category headers are still there, the cards are still in David's order, and drag still works. If turning it off wipes a category or re-sorts by activity, that is the bug this item exists to catch.
25. With stacking off, drag two cards from the same folder into a new order, then restart the app. Their order is NOT kept, and that is expected — those rows are keyed by pid because they have no folder key of their own. Everything else keeps its place. Confirm nothing looks broken, only reset.
26. At the 140px minimum rail width, a 32-character category name, a deep path and a folded stack face all stay inside their row with no horizontal scrollbar.
27. Open a card menu on a card that is NOT the last in the rail, with a category assigned: the menu still paints above the card below it (the `menu-open` stacking fix), and the category panel does too.
