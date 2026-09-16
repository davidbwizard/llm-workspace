import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoredTheme, writeStoredTheme } from '../../src/main/appearance.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'appearance-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the mirrored appearance choice', () => {
  const path = () => join(dir, 'appearance.json');

  it('round-trips each of the three values', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      writeStoredTheme(path(), theme);
      expect(readStoredTheme(path())).toBe(theme);
    }
  });

  // Every failure mode reads as 'system', which is the app's own default
  // and the one answer that is never wrong to fall back to: it hands the
  // decision back to the OS.
  it.each([
    ['no file at all', null],
    ['a corrupt blob', '{not json'],
    ['a value outside the three', '{"theme":"sepia"}'],
    ['the wrong shape entirely', '[]'],
    ['an empty file', ''],
  ])('reads as system for %s', (_label, contents) => {
    if (contents !== null) writeFileSync(path(), contents);
    expect(readStoredTheme(path())).toBe('system');
  });

  it('reads as system when the directory itself does not exist, without throwing', () => {
    expect(readStoredTheme(join(dir, 'nope', 'appearance.json'))).toBe('system');
  });

  it('creates the directory rather than failing on a first run', () => {
    const nested = join(dir, 'fresh', 'appearance.json');
    writeStoredTheme(nested, 'dark');
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('never throws when the path cannot be written', () => {
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    // A directory where the file should be: the write must fail quietly,
    // because an unwritable preference is not worth failing a launch over.
    expect(() => writeStoredTheme(blocked, 'light')).not.toThrow();
  });
});
