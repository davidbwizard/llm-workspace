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

// A watcher event arriving under 250ms before quit used to fire its
// coalesced pushFleet call against an already-closed db: the coalescing
// timer was declared inside the setImmediate closure, unreachable from
// before-quit, and before-quit closed db without nulling it, so the `if
// (db)` guard at the timer's fire site stayed true for a stale, closed
// handle rather than becoming falsy. Both halves matter together --
// clearing the timer stops an ALREADY-scheduled push from firing at all;
// nulling db protects a push scheduled by a watcher event that slips in
// after before-quit runs (watcher.close() here is fire-and-forget, not
// awaited, so that window is real).
//
// These are text/structure checks only, the same limitation this whole
// file has (it reads source, not behaviour) -- they prove the shape is
// present (declared where before-quit can reach it, cleared there, db
// nulled after close), not that the race is actually closed at runtime.
// Proving that would mean executing index.ts's real quit path, which
// isn't reachable here: it imports `app`/`BrowserWindow` from 'electron',
// which is a path-string stub under plain-Node vitest (see ipc.ts's own
// note on this same limitation), not something these tests can drive.
describe('shutdown gap: the coalescing timer and a closed db', () => {
  it('declares the coalescing timer at module scope, not inside the deferred closure', () => {
    const declarations = main.match(/\blet\s+pushTimer\b/g) ?? [];
    expect(declarations).toHaveLength(1); // not re-declared locally inside the closure
    expect(main.indexOf('let pushTimer')).toBeLessThan(main.indexOf('whenReady('));
  });

  it('clears the coalescing timer in the quit path, and nulls db after closing it', () => {
    const quitBlock = main.slice(main.indexOf("on('before-quit'"));
    expect(quitBlock).toMatch(/clearTimeout\(pushTimer\)/);
    const closeAt = quitBlock.indexOf('db?.close()');
    const nullAt = quitBlock.search(/db\s*=\s*null/);
    expect(closeAt).toBeGreaterThan(-1);
    expect(nullAt).toBeGreaterThan(closeAt); // null AFTER close, not before
  });
});

// Live process discovery (src/discovery/live.ts) refreshes on its own
// interval, the same lifecycle shape spoolTimer already has -- a timer
// hidden inside the setImmediate closure would be unreachable from
// before-quit, exactly the bug the shutdown-gap tests above exist to catch
// for pushTimer. These pin the same shape for discoveryTimer.
describe('process discovery timer', () => {
  it('declares the discovery timer at module scope, not inside the deferred closure', () => {
    const declarations = main.match(/\blet\s+discoveryTimer\b/g) ?? [];
    expect(declarations).toHaveLength(1);
    expect(main.indexOf('let discoveryTimer')).toBeLessThan(main.indexOf('whenReady('));
  });

  it('clears the discovery timer in the quit path', () => {
    const quitBlock = main.slice(main.indexOf("on('before-quit'"));
    expect(quitBlock).toMatch(/clearInterval\(discoveryTimer\)/);
  });

  it('refreshes the process cache on an interval via refreshLiveProcesses', () => {
    expect(main).toMatch(/refreshLiveProcesses\(\)/);
    expect(main).toMatch(/discoveryTimer\s*=\s*setInterval\(/);
  });
});
