import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Comments can contain the same names the assertions below look for (e.g. a
// comment justifying db.close() would satisfy that assertion even if the
// call itself were deleted). Strip them so every assertion matches only
// code that actually runs -- same pattern as tests/main/security.test.ts.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

const main = strip(readFileSync('src/main/index.ts', 'utf8'));

describe('app lifecycle', () => {
  it('opens the index and registers IPC before creating the window', () => {
    const dbAt = main.indexOf('openDb(');
    const ipcAt = main.indexOf('registerIpc(');
    // Matched on the CALL site, `createWindow();` (with the trailing
    // semicolon) -- not the definition `function createWindow(): void {`,
    // which precedes openDb/registerIpc textually and would make winAt the
    // smallest of the three indices regardless of the actual call order.
    const winAt = main.indexOf('createWindow();');
    expect(dbAt).toBeGreaterThan(-1);
    expect(ipcAt).toBeGreaterThan(dbAt);
    expect(winAt).toBeGreaterThan(ipcAt);
  });

  it('coalesces watcher updates rather than pushing per file', () => {
    expect(main).toMatch(/setTimeout|debounce/);
  });

  it('closes the watcher and the database on quit', () => {
    expect(main).toMatch(/before-quit|will-quit/);
    expect(main).toMatch(/\.close\(\)/);
  });
});
