import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GROUPS_STORAGE_KEY, MAX_CATEGORY_LENGTH, MAX_CATEGORIES, DEFAULT_GROUPS, normalizeGroups,
  getGroups, categoryNames, categoryOfSession, assignCategory, renameCategory, deleteCategory,
  categoryInUse, pruneAssignments, isStackOpen, toggleStack, orderIndex, rememberKeys, moveRow,
  subscribeGroups, reloadGroups, categoryForRow,
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
    // A before/after string comparison would pass even without the guard --
    // the reconstructed object is content-identical either way. A spy on
    // the write itself is what actually proves the early return fires.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    pruneAssignments(['s1']);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
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
    // Same reasoning as pruneAssignments' own no-write test just above:
    // a string comparison can't tell a skipped write from an identical one,
    // so this spies on the write itself.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    rememberKeys(['/a']);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
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
