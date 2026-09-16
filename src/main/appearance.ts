import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The ONE setting main keeps a copy of.
 *
 *  Every other preference lives in the renderer's localStorage and stays
 *  there (src/renderer/state/settings.ts). Appearance is the exception for
 *  a reason that cannot be designed away: BrowserWindow's backgroundColor
 *  is the colour of the window's very first frame, chosen before the
 *  renderer exists, and main cannot read localStorage. Without this mirror
 *  a person who chose Light gets a dark flash on every launch.
 *
 *  Deliberately tiny: one field, three possible values, and every failure
 *  reads as 'system' -- the app's own default, and the one answer that is
 *  never wrong, since it hands the decision back to the OS. */

export type ThemeChoice = 'system' | 'light' | 'dark';

const CHOICES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);

export function readStoredTheme(path: string): ThemeChoice {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'system';
    const theme = (raw as Record<string, unknown>).theme;
    return typeof theme === 'string' && CHOICES.has(theme) ? theme as ThemeChoice : 'system';
  } catch {
    // Missing file, missing directory, unreadable, malformed -- all the
    // same answer, and none of them is worth failing a launch over.
    return 'system';
  }
}

/** Best-effort, like every preference write in this app: an unwritable
 *  home directory costs only the next launch's first frame, never this
 *  session's own theme change or the app itself -- so the failure is never
 *  allowed to throw. Logged rather than swallowed outright, though: a
 *  silent catch here would hide a genuinely broken home directory (full
 *  disk, bad permissions) from the one place -- the main process log --
 *  anyone could ever find it. */
export function writeStoredTheme(path: string, theme: ThemeChoice): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ theme }));
  } catch (err) {
    console.error('writeStoredTheme failed:', err);
  }
}
