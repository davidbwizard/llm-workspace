// Whether this person has already been through the first-run screen.
//
// Per-viewer UI state, stored the same way settings.ts and favourites.ts
// store theirs (namespaced localStorage, validated on every read, writes
// best-effort). It is deliberately NOT in main: nothing before the renderer
// exists needs it, unlike the appearance mirror (src/main/appearance.ts),
// which exists only because BrowserWindow's first frame is painted before
// the renderer does.
//
// There is no node import anywhere in this file, and there must not be:
// a value import from main blanks the whole window, and
// tests/renderer/bundle.test.ts now asserts it.

export const FIRST_RUN_STORAGE_KEY = 'llmws.firstRunSeen';

/** True once they have clicked past the first-run screen at least once.
 *  Anything other than the exact stored marker reads as false -- a value
 *  left by an older version, or edited by hand, should cost at most one
 *  extra showing of a screen, never a silently skipped one. */
export function hasSeenFirstRun(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_STORAGE_KEY) === '1';
  } catch {
    // Private window, blocked site data, or a throwing accessor. Showing
    // the screen again is the safe failure: it is a screen someone can
    // dismiss, and the alternative is never showing it to someone who
    // needs it.
    return false;
  }
}

/** Best-effort, like every preference write in this app: a failed write
 *  costs one extra showing on the next launch, never this session. */
export function markFirstRunSeen(): void {
  try { localStorage.setItem(FIRST_RUN_STORAGE_KEY, '1'); } catch { /* best-effort only */ }
}
