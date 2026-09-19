import { useSyncExternalStore } from 'react';

/** Favourite folders (quick-wins): a JSON array of absolute path strings,
 *  namespaced like this app's own settings/rail-width preferences (a
 *  per-viewer UI convenience, never fleet state -- nothing here belongs in
 *  the store/db). Follows settings.ts's own store shape exactly -- one
 *  module-scoped singleton, so LaunchBar's star and chip row, MainPane's
 *  header star, and OpenSessionCard's own "add/remove folder" menu item all
 *  read and write the SAME list. Adding a favourite from any one of them
 *  shows up in the other two with no reload, the same way a Settings change
 *  reaches every consumer of useSettings().
 *
 *  There is no node import anywhere in this file, and there must not be: a
 *  value import from main blanks the whole window (same rule settings.ts's
 *  own doc comment states). */

export const FAVOURITES_STORAGE_KEY = 'llmws.favourites';
export const MAX_FAVOURITES = 12;

/** Validates on every read, not just on write -- the stored value could
 *  have been left behind by an older version of this app, or edited by
 *  hand: only non-empty, absolute-path strings survive, deduped (keeping
 *  the first occurrence), capped at MAX_FAVOURITES. Anything else (not an
 *  array, wrong element type, a relative path) is dropped rather than
 *  trusted. Exported for direct unit testing, same as settings.ts's own
 *  normalizeSettings. */
export function normalizeFavourites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
  return Array.from(new Set(valid)).slice(0, MAX_FAVOURITES);
}

function read(): string[] {
  try {
    const rawText = localStorage.getItem(FAVOURITES_STORAGE_KEY);
    if (rawText === null) return [];
    return normalizeFavourites(JSON.parse(rawText));
  } catch {
    return [];
  }
}

/** Best-effort only: a failed write leaves `current` (already updated) as
 *  the only copy of the change, gone on the next reload -- still better
 *  than throwing and losing the click entirely. */
function write(list: string[]): void {
  try { localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(list)); } catch { /* best-effort only */ }
}

let current: string[] = read();
const listeners = new Set<() => void>();

/** A STABLE array identity until something actually changes -- required by
 *  useSyncExternalStore, which re-renders forever if the snapshot is a new
 *  array each call. */
export function getFavourites(): string[] {
  return current;
}

function commit(next: string[]): void {
  current = next;
  write(next);
  for (const listener of listeners) listener();
}

/** A no-op on an empty path, on one already favourited, and once
 *  MAX_FAVOURITES is already reached -- the one place all three rules live,
 *  so every caller (the star buttons, the card-menu item) gets the same
 *  cap/dedupe behaviour for free rather than re-checking it themselves. */
export function addFavourite(path: string): void {
  if (path === '' || current.includes(path) || current.length >= MAX_FAVOURITES) return;
  commit([...current, path]);
}

/** A no-op for a path that isn't currently a favourite -- removing at the
 *  cap must still work (unlike adding), so this never checks MAX_FAVOURITES. */
export function removeFavourite(path: string): void {
  if (!current.includes(path)) return;
  commit(current.filter(p => p !== path));
}

export function isFavourite(path: string): boolean {
  return current.includes(path);
}

export function subscribeFavourites(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-reads from storage and notifies -- for tests, which write localStorage
 *  directly and need the module to see it (same as settings.ts's own
 *  reloadSettings); harmless in production, where nothing calls it. */
export function reloadFavourites(): void {
  current = read();
  for (const listener of listeners) listener();
}

/** React 18's own external-store hook -- no context provider, and every
 *  consumer (LaunchBar, MainPane, OpenSessionCard) sees the same array the
 *  moment any one of them writes it. */
export function useFavourites(): string[] {
  return useSyncExternalStore(subscribeFavourites, getFavourites, getFavourites);
}

/** The label shown for a favourite everywhere it appears (a chip, the
 *  header star's accessible name, the card-menu item): the folder's last
 *  path segment. A bare "/" (no segment at all) falls back to the path
 *  itself rather than an empty label -- unreachable in practice
 *  (normalizeFavourites only ever keeps strings starting with "/", and "/"
 *  itself is a legal absolute path). */
export function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
