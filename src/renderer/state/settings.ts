import { useSyncExternalStore } from 'react';

/** The four per-viewer preferences the settings modal owns, and the app's
 *  first shared renderer store.
 *
 *  Follows SessionRail's existing localStorage pattern exactly (see
 *  RAIL_WIDTH_STORAGE_KEY there): one `llmws:` namespaced key, a JSON
 *  object, every read wrapped in try/catch, every value validated against
 *  its allowed set with a fallback to the default, and a write that
 *  swallows errors. The rail's own `llmws:rail-width` key stays where it is
 *  -- this store does not absorb it.
 *
 *  Nothing here crosses IPC except the appearance value, which main needs
 *  for nativeTheme and the window's first paint (src/main/appearance.ts).
 *  There is no node import anywhere in this file, and there must not be:
 *  a value import from main blanks the whole window. */

export type Appearance = 'system' | 'light' | 'dark';
export type TextSize = 14 | 15 | 16 | 17;
export type MessageStyle = 'a' | 'c';
/** One setting with four values rather than two booleans, so "Both on but
 *  Fleet off" is not a state that can exist. */
export type CompactCards = 'off' | 'sidebar' | 'fleet' | 'both';
/** Whether sessions sharing a folder collapse into one rail row.
 *
 *  FOLDER STACKING ONLY. Categories and David's own row order apply either
 *  way -- "not auto movement for the cards" was stated unconditionally, and
 *  a category he set must not disappear because he turned stacking off. So
 *  'off' means no stacks, not a rollback of the whole feature. */
export type GroupSessions = 'on' | 'off';

export type Settings = {
  appearance: Appearance;
  textSize: TextSize;
  messageStyle: MessageStyle;
  compactCards: CompactCards;
  groupSessions: GroupSessions;
};

export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];
export const TEXT_SIZES: readonly TextSize[] = [14, 15, 16, 17];
export const MESSAGE_STYLES: readonly MessageStyle[] = ['a', 'c'];
export const COMPACT_CARDS: readonly CompactCards[] = ['off', 'sidebar', 'fleet', 'both'];
export const GROUP_SESSIONS: readonly GroupSessions[] = ['on', 'off'];

export const SETTINGS_STORAGE_KEY = 'llmws:settings';

/** Every default is a decision David made against the rendered mockup on
 *  2026-09-15, not a placeholder: 16px reading size, style A (the accent
 *  rule down the agent's replies), compact cards in both places, and
 *  appearance following the OS until told otherwise. */
export const DEFAULT_SETTINGS: Settings = {
  appearance: 'system', textSize: 16, messageStyle: 'a', compactCards: 'both', groupSessions: 'on',
};

function pick<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

/** Untrusted in the ordinary sense: this is a blob on disk, and a value
 *  rendered verbatim would put an unknown appearance on the root element or
 *  an arbitrary number in a CSS size. Each field is checked on its own, so
 *  one bad value costs one default rather than the whole object. */
export function normalizeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_SETTINGS;
  const r = raw as Record<string, unknown>;
  return {
    appearance: pick(APPEARANCES, r.appearance, DEFAULT_SETTINGS.appearance),
    textSize: pick(TEXT_SIZES, r.textSize, DEFAULT_SETTINGS.textSize),
    messageStyle: pick(MESSAGE_STYLES, r.messageStyle, DEFAULT_SETTINGS.messageStyle),
    compactCards: pick(COMPACT_CARDS, r.compactCards, DEFAULT_SETTINGS.compactCards),
    groupSessions: pick(GROUP_SESSIONS, r.groupSessions, DEFAULT_SETTINGS.groupSessions),
  };
}

function read(): Settings {
  try {
    const rawText = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (rawText === null) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(rawText));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function write(s: Settings): void {
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s)); } catch { /* best-effort only */ }
}

function same(a: Settings, b: Settings): boolean {
  return a.appearance === b.appearance && a.textSize === b.textSize
    && a.messageStyle === b.messageStyle && a.compactCards === b.compactCards
    && a.groupSessions === b.groupSessions;
}

let current: Settings = read();
const listeners = new Set<() => void>();

/** A STABLE object identity until something actually changes -- required by
 *  useSyncExternalStore, which re-renders forever if the snapshot is a new
 *  object each call. */
export function getSettings(): Settings {
  return current;
}

export function setSettings(patch: Partial<Settings>): void {
  const next = normalizeSettings({ ...current, ...patch });
  if (same(next, current)) return;
  current = next;
  write(next);
  for (const listener of listeners) listener();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-reads from storage and notifies. Exists for tests, which write
 *  localStorage directly and need the module to see it; harmless in
 *  production, where nothing calls it. */
export function reloadSettings(): void {
  current = read();
  for (const listener of listeners) listener();
}

/** React 18's own external-store hook -- no state library, no context
 *  provider, and every consumer sees the same object the moment the modal
 *  writes it. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}

/** Whether cards are compact in one of the two places that show them.
 *  Reading the four-value setting in one place keeps the rail and the grid
 *  from drifting into two slightly different interpretations. */
export function compactIn(s: Settings, place: 'sidebar' | 'fleet'): boolean {
  return s.compactCards === 'both' || s.compactCards === place;
}
