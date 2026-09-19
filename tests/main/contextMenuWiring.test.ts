import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.ts imports `app`/`BrowserWindow`/`Menu` from 'electron', which is a
// path-string stub under plain-Node vitest (see tests/main/lifecycle.test.ts's
// own note) -- these are text/structure checks only, the same limitation
// that file has, proving the shape is wired up rather than executing it.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
const main = strip(readFileSync('src/main/index.ts', 'utf8'));

describe('main window: right-click edit menu', () => {
  it('imports the pure template builder', () => {
    expect(main).toMatch(/import\s*{\s*contextMenuTemplate\s*}\s*from\s*['"]\.\/contextMenu\.ts['"]/);
  });

  it('listens for context-menu on the window\'s own webContents', () => {
    expect(main).toMatch(/win\.webContents\.on\(\s*['"]context-menu['"]/);
  });

  it('builds the menu from contextMenuTemplate\'s output, not a hand-rolled template', () => {
    const at = main.search(/win\.webContents\.on\(\s*['"]context-menu['"]/);
    expect(at).toBeGreaterThan(-1);
    const body = main.slice(at, at + 800);
    expect(body).toMatch(/contextMenuTemplate\(/);
  });

  it('never pops up an empty menu', () => {
    const at = main.search(/win\.webContents\.on\(\s*['"]context-menu['"]/);
    const body = main.slice(at, at + 800);
    // Some guard against an empty template exists before .popup() is reached.
    expect(body).toMatch(/\.length\s*===\s*0|\.length\s*>\s*0|!items\.length/);
    expect(body).toMatch(/\.popup\(\)/);
  });

  it('replaces a misspelling through the real webContents, keyed to the suggestion label', () => {
    const at = main.search(/win\.webContents\.on\(\s*['"]context-menu['"]/);
    const body = main.slice(at, at + 800);
    expect(body).toMatch(/win\.webContents\.replaceMisspelling\(/);
  });
});
