import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FAVOURITES_STORAGE_KEY, MAX_FAVOURITES, normalizeFavourites, getFavourites, addFavourite,
  removeFavourite, isFavourite, subscribeFavourites, reloadFavourites, lastSegment,
} from '../../src/renderer/state/favourites.ts';

// Follows settings.ts's own store shape exactly (see settings.test.ts) --
// the app's first shared renderer store, and this is its second: a module-
// scoped singleton so every reader (LaunchBar, MainPane's header,
// OpenSessionCard's own menu) sees the identical list the moment any one of
// them writes it, with no IPC and no context provider.
beforeEach(() => {
  localStorage.clear();
  reloadFavourites();
});

describe('normalizeFavourites', () => {
  it('keeps absolute-path strings, in order', () => {
    expect(normalizeFavourites(['/a', '/b'])).toEqual(['/a', '/b']);
  });

  it('drops anything that is not a non-empty absolute-path string', () => {
    expect(normalizeFavourites(['/a', 42, null, 'relative', '', '/b'])).toEqual(['/a', '/b']);
  });

  it('dedupes, keeping the first occurrence', () => {
    expect(normalizeFavourites(['/a', '/b', '/a'])).toEqual(['/a', '/b']);
  });

  it('caps at MAX_FAVOURITES', () => {
    const many = Array.from({ length: 20 }, (_, i) => `/p${i}`);
    expect(normalizeFavourites(many)).toHaveLength(MAX_FAVOURITES);
  });

  it.each([['null', null], ['an object', {}], ['a string', '/a'], ['a number', 3]])(
    'returns no favourites for %s', (_label, raw) => {
      expect(normalizeFavourites(raw)).toEqual([]);
    });
});

describe('the favourites store', () => {
  it('starts empty with nothing stored', () => {
    expect(getFavourites()).toEqual([]);
  });

  it('adds a path, persists it, and is idempotent', () => {
    addFavourite('/a');
    expect(getFavourites()).toEqual(['/a']);
    addFavourite('/a');
    expect(getFavourites()).toEqual(['/a']);
    reloadFavourites();
    expect(getFavourites()).toEqual(['/a']);
    expect(JSON.parse(localStorage.getItem(FAVOURITES_STORAGE_KEY)!)).toEqual(['/a']);
  });

  it('ignores an empty path', () => {
    addFavourite('');
    expect(getFavourites()).toEqual([]);
  });

  it('removes a path, and is a no-op for one that was never there', () => {
    addFavourite('/a');
    removeFavourite('/b');
    expect(getFavourites()).toEqual(['/a']);
    removeFavourite('/a');
    expect(getFavourites()).toEqual([]);
  });

  it('reports whether a path is currently a favourite', () => {
    addFavourite('/a');
    expect(isFavourite('/a')).toBe(true);
    expect(isFavourite('/b')).toBe(false);
  });

  it('refuses to add past the cap, leaving the existing favourites untouched', () => {
    for (let i = 0; i < MAX_FAVOURITES; i++) addFavourite(`/p${i}`);
    expect(getFavourites()).toHaveLength(MAX_FAVOURITES);
    addFavourite('/one-more');
    expect(getFavourites()).toHaveLength(MAX_FAVOURITES);
    expect(getFavourites()).not.toContain('/one-more');
  });

  it('still allows removing at the cap', () => {
    for (let i = 0; i < MAX_FAVOURITES; i++) addFavourite(`/p${i}`);
    removeFavourite('/p0');
    expect(getFavourites()).toHaveLength(MAX_FAVOURITES - 1);
  });

  it('ignores a corrupt blob rather than throwing', () => {
    localStorage.setItem(FAVOURITES_STORAGE_KEY, '{not json');
    expect(() => reloadFavourites()).not.toThrow();
    expect(getFavourites()).toEqual([]);
  });

  // localStorage throws in a locked-down or private-mode context. A
  // favourite is a UI convenience, never worth taking a card's menu (or the
  // launch bar) down over -- same reasoning as settings.ts's own
  // never-throws test.
  it('never throws when localStorage itself is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => addFavourite('/a')).not.toThrow();
    expect(() => reloadFavourites()).not.toThrow();
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('notifies subscribers on a real change, and not on a no-op', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeFavourites(cb);
    addFavourite('/a');
    expect(cb).toHaveBeenCalledTimes(1);
    addFavourite('/a'); // already there
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    addFavourite('/b');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('hands out a stable snapshot until something actually changes', () => {
    const before = getFavourites();
    addFavourite(''); // no-op
    expect(getFavourites()).toBe(before);
    addFavourite('/a');
    expect(getFavourites()).not.toBe(before);
  });
});

describe('lastSegment', () => {
  it('returns the final path segment', () => {
    expect(lastSegment('/Users/me/proj')).toBe('proj');
  });

  it('falls back to the path itself when there is no segment at all', () => {
    expect(lastSegment('/')).toBe('/');
  });
});
