import { ipcMain, type BrowserWindow } from 'electron';
import type { Db } from '../store/db.ts';
import { fleetState, type SessionState } from '../fleet/state.ts';
import { sanitizeForTerminal } from '../config.ts';

export interface FleetPayload { version: 1; generatedAt: string; sessions: SessionState[] }

// Unicode bidirectional overrides (U+202A-U+202E: LRE, RLE, PDF, LRO, RLO)
// and isolates (U+2066-U+2069: LRI, RLI, FSI, PDI) -- e.g. U+202E
// RIGHT-TO-LEFT OVERRIDE, the classic filename-spoofing trick. Invisible
// characters that re-order how the text around them is DISPLAYED, without
// changing the text itself. Inert in a terminal -- sanitizeForTerminal never
// touches them -- but not in a renderer, so what the user reads can differ
// from what the agent actually wrote.
const BIDI_CONTROL = /[‪-‮⁦-⁩]/g;
// Zero-width formatting characters: invisible in any renderer, used the same
// way -- to hide characters inside what looks like a shorter or different
// string. Zero width space/non-joiner/joiner and the left/right-to-left
// marks (U+200B-U+200F), word joiner (U+2060), and the byte-order mark
// (U+FEFF).
const ZERO_WIDTH_FORMATTING = /[​-‏⁠﻿]/g;

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
