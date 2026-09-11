// Under plain-Node vitest (no electron-rebuild here), node_modules/electron
// is a stub whose default export is a path string, so this named import
// binds ipcMain to undefined rather than throwing. That stays harmless only
// because ipcMain is dereferenced inside registerIpc's body, never at module
// scope -- a test that imports and calls registerIpc directly will throw.
import { ipcMain, type BrowserWindow } from 'electron';
import type { Db } from '../store/db.ts';
import { fleetState, type SessionState } from '../fleet/state.ts';
import { sanitizeForTerminal } from '../config.ts';

export interface FleetPayload { version: 1; generatedAt: string; sessions: SessionState[] }

// Unicode bidirectional overrides (U+202A-U+202E: LRE, RLE, PDF, LRO, RLO)
// and isolates (U+2066-U+2069: LRI, RLI, FSI, PDI) -- e.g. U+202E
// RIGHT-TO-LEFT OVERRIDE, the classic filename-spoofing trick. Their effect
// is UNBOUNDED -- each re-orders how every character after it is DISPLAYED,
// until a matching pop or the end of the string, without changing the text
// itself. Inert in a terminal -- sanitizeForTerminal never touches them --
// but not in a renderer, so what the user reads can differ from what the
// agent actually wrote. This is the Trojan Source set.
//
// Written as \u escapes, deliberately -- not as the literal characters. An
// earlier version of this file used the literal characters, which made the
// set unreviewable (nobody can tell U+200B from U+200C by looking at a
// blank space) and, worse, made this file itself a Trojan Source vector:
// an unterminated LRE/RLO with no matching PDF reorders how the REST of
// the file displays in an editor, diff viewer or review tool. Do not
// "tidy" these back into literal characters.
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/g;
// Zero-width, no script role: zero-width space, word joiner, and the
// byte-order mark. Deliberately NOT included here: ZWNJ/ZWJ (U+200C/U+200D)
// are load-bearing for Persian, Arabic and Indic scripts (ZWNJ) and for
// emoji sequences (ZWJ) -- stripping them silently corrupts correct text,
// which is worse than leaving them, since it happens on honest content
// every day rather than only under attack. LRM/RLM (U+200E/U+200F) are
// also excluded: unlike the override/isolate set above, they only bias
// adjacent neutral characters, not an unbounded span, so they cannot
// reorder arbitrary following text the way BIDI_CONTROL's set can.
//
// Written as \u escapes for the same reason as BIDI_CONTROL above.
const ZERO_WIDTH_FORMATTING = /[\u200b\u2060\ufeff]/g;

/** sanitizeForTerminal (src/config.ts) strips terminal escape sequences and
 *  control characters -- correct for the terminal it was written for. It
 *  does not touch bidi overrides or zero-width formatting characters,
 *  because neither does anything on a terminal. Both do something on a
 *  renderer: this app exists to show faithfully what an agent said, so
 *  display integrity is the product, and provider text can quote arbitrary
 *  file content -- a realistic way such characters arrive. */
function sanitizeForDisplay(s: string): string {
  return sanitizeForTerminal(s).replace(BIDI_CONTROL, '').replace(ZERO_WIDTH_FORMATTING, '');
}

/** Provider text crosses into the renderer here. It is sanitised at this
 *  boundary rather than in a component, so a new component cannot forget
 *  (spec §11.2). React escapes HTML, but control and bidi/zero-width
 *  characters are a separate problem and travel fine through JSX. */
export function buildFleetPayload(db: Db): FleetPayload {
  const sessions = fleetState(db).map(s => ({
    ...s,
    lastProse: s.lastProse === null ? null : sanitizeForDisplay(s.lastProse),
    project: sanitizeForDisplay(s.project),
    cwd: s.cwd === null ? null : sanitizeForDisplay(s.cwd),
    blocker: s.blocker ? { ...s.blocker, text: sanitizeForDisplay(s.blocker.text) } : null,
  }));
  return { version: 1, generatedAt: new Date().toISOString(), sessions };
}

/** The complete set of channels main answers. Adding one means adding it to
 *  the preload's enumerated list as well; tests/main/ipc.test.ts asserts
 *  they match. */
export function registerIpc(db: Db): void {
  ipcMain.handle('fleet:list', () => buildFleetPayload(db));
}

export function pushFleet(db: Db, win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('fleet:update', buildFleetPayload(db));
}
