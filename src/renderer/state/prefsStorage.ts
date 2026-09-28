// Where the preference stores keep their values.
//
// It used to be localStorage, which is keyed by the window's ORIGIN. This
// app has several: the dev app loads http://localhost:5173, the packaged app
// loads file://, and Vite drifts to 5174/5175 whenever a stale dev server
// holds the default. Four origins already held this app's keys on David's
// machine, each a separate empty drawer, so preferences appeared to reset
// for reasons nothing surfaced. src/main/prefs.ts is the store that replaces
// it; this is the renderer's one way in.
//
// Deliberately the same SHAPE localStorage had -- a string in, a string or
// null out -- so every store keeps its own parse and validation exactly as
// written. Only read() and write() move.
//
// There is no node import here and there must not be: a value import from
// main blanks the whole window (the rule settings.ts's own header states).

/** localStorage is still READ, as a fallback, and still WRITTEN when main's
 *  store is unreachable. Two reasons, both real:
 *
 *  - A preload that threw leaves a normal-looking window with no API at all
 *    (Task 5). Dropping every preference write in that state would be a
 *    silent, permanent loss; falling back keeps the app usable.
 *  - Before the one-time migration has run, the person's existing values are
 *    still only in localStorage. Reading it second means they are never
 *    missing, whatever order things happen in.
 */
function fromLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** main's snapshot, read once and synchronously by the preload. Mutated in
 *  place on write so a read straight after a write sees the new value
 *  without waiting for the IPC round trip -- the stores keep their own
 *  `current` too, but nothing should depend on which of the two answers. */
function snapshot(): Record<string, string> | null {
  const prefs = window.fleet?.prefs;
  return prefs !== undefined && prefs !== null ? prefs : null;
}

export function readPref(key: string): string | null {
  const snap = snapshot();
  const stored = snap?.[key];
  return stored !== undefined ? stored : fromLocal(key);
}

/** Best-effort, exactly as localStorage was: a failed write leaves the
 *  in-memory value as the only copy, gone on the next reload. That is
 *  better than throwing and losing the click. */
export function writePref(key: string, value: string): void {
  const api = window.fleet;
  const snap = snapshot();
  if (snap) snap[key] = value;
  if (api?.setPref) {
    void api.setPref(key, value).catch((err: unknown) => {
      console.error('preference write failed:', key, err);
    });
    return;
  }
  // No API at all (a failed preload): keep the old behaviour rather than
  // dropping the write on the floor.
  try { localStorage.setItem(key, value); } catch { /* best-effort only */ }
}

let migrated = false;

/** The one-time move off localStorage, run once per window at startup.
 *
 *  The renderer is the only thing that can read localStorage, so it hands
 *  the whole of it over and main decides what is storable. Main never
 *  overwrites a preference it already holds, so a value already migrated
 *  stays put and an older build running in between cannot undo newer
 *  choices. Nothing is deleted from localStorage either: the cost of
 *  leaving it is a few stale keys, and the cost of a wrong delete is
 *  somebody's favourites.
 *
 *  Reads keep working throughout regardless -- readPref falls back to
 *  localStorage -- so nothing depends on this having finished. */
export function migratePrefsOnce(): void {
  if (migrated) return;
  migrated = true;
  const api = window.fleet;
  if (!api?.migratePrefs) return;
  let incoming: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      const value = localStorage.getItem(key);
      if (value !== null) incoming[key] = value;
    }
  } catch {
    incoming = {};
  }
  if (Object.keys(incoming).length === 0) return;
  void api.migratePrefs(incoming).then(result => {
    // Fold whatever was taken into the snapshot, so a store reading later
    // in this same session sees it without a reload.
    const snap = snapshot();
    if (snap && result && typeof result === 'object' && 'prefs' in result) {
      Object.assign(snap, (result as { prefs: Record<string, string> }).prefs);
    }
  }, (err: unknown) => console.error('preference migration failed:', err));
}
