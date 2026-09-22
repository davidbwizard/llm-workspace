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
