import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Comments can contain the same names the assertions below look for (e.g. a
// comment justifying db.close() would satisfy that assertion even if the
// call itself were deleted). Strip them so every assertion matches only
// code that actually runs -- same pattern as tests/main/security.test.ts.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

const main = strip(readFileSync('src/main/index.ts', 'utf8'));

// Extracts the body of a top-level `function <name>(...) { ... }`
// declaration by counting braces from its first `{` to the matching `}` --
// good enough for this file's straightforward structure (no strings or
// regexes containing unbalanced braces inside the functions this is used
// on). Lets the tests below distinguish "this call site is inside the
// guarded function" from "this call site merely appears somewhere in the
// file", which a plain substring/indexOf check on `main` as a whole cannot.
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const openAt = src.indexOf('{', start);
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openAt + 1, i);
    }
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

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
// timer was declared inside a closure nested in whenReady's callback, unreachable from
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
// hidden inside a nested closure would be unreachable from before-quit,
// exactly the bug the shutdown-gap tests above exist to catch for
// pushTimer. These pin the same shape for discoveryTimer.
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

// ingestAll is synchronous and, against the real index, blocks the main
// thread for hundreds of ms -- long enough that a fleet:list request
// arriving while it runs waits out however much is left (JS cannot preempt
// a running synchronous call). The fix is to never START ingestAll until
// the renderer's first fleet:list reply is already on its way out, rather
// than hoping a setImmediate deferral wins a timing race against it. These
// pin the mechanism that makes that ordering a real, structural guarantee:
// ingestAll has exactly one call site, and it lives inside an idempotent
// function that only ever runs after registerIpc's fleet:list handler has
// triggered it (or, as a fallback, after the window has actually loaded).
describe('deferred ingest: answer before ingesting, not after', () => {
  it('calls ingestAll from exactly one place: inside the guarded startBackgroundWork', () => {
    const total = (main.match(/ingestAll\(db, roots\(\)\)/g) ?? []).length;
    const inBody = (functionBody(main, 'startBackgroundWork').match(/ingestAll\(db, roots\(\)\)/g) ?? []).length;
    expect(total).toBe(1);
    expect(inBody).toBe(1);
  });

  it('guards startBackgroundWork with an idempotency flag it actually sets', () => {
    const body = functionBody(main, 'startBackgroundWork');
    expect(body).toMatch(/if\s*\(\s*backgroundStarted/);
    expect(body).toMatch(/backgroundStarted\s*=\s*true/);
  });

  it('passes startBackgroundWork into registerIpc, so fleet:list can trigger it after answering', () => {
    // Not anchored on a trailing `)` -- registerIpc also takes a third
    // argument (session:kill's post-kill refresh callback), so this only
    // pins that db and startBackgroundWork are passed, in that order, as
    // registerIpc's first two arguments.
    expect(main).toMatch(/registerIpc\(db,\s*startBackgroundWork/);
  });

  it('falls back to starting background work once the window has actually loaded, in case fleet:list is never called', () => {
    expect(main).toMatch(/did-finish-load['"]?\s*,\s*startBackgroundWork\)/);
  });

  it('pushes an update after ingestAll, reflecting whatever it found', () => {
    const body = functionBody(main, 'startBackgroundWork');
    const ingestAt = body.indexOf('ingestAll(db, roots())');
    const pushAt = body.indexOf('pushFleet(mainWindow)');
    expect(ingestAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(ingestAt);
  });

  it('starts process discovery eagerly, not gated behind startBackgroundWork/ingestAll', () => {
    const body = functionBody(main, 'startBackgroundWork');
    expect(body).not.toMatch(/refreshLiveProcesses\(/);
    expect(main).toMatch(/refreshLiveProcesses\(\)\.then\(/);
  });

  // A process starting or ending, or its transcript changing, between
  // sweeps is something only this trigger can surface -- every sweep
  // refreshes pushFleet's enrichment cache and pushes now, not just the
  // first.
  it('pushes an update after every discovery sweep, not only the first', () => {
    const sweepBody = main.slice(main.search(/refreshLiveProcesses\(\)\.then\(/), main.search(/refreshLiveProcesses\(\)\.then\(/) + 300);
    expect(sweepBody).toMatch(/refreshLiveProcesses\(\)\.then\(\s*processes\s*=>\s*{/);
    const refreshAt = sweepBody.search(/refreshPushEnrichment\(db,\s*processes\)/);
    const pushAt = sweepBody.search(/pushFleet\(mainWindow\)/);
    expect(refreshAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(refreshAt); // cache refreshed BEFORE the push reads it
    const declAt = main.search(/const\s+pushAfterDiscoverySweep\s*=/);
    expect(declAt).toBeGreaterThan(-1);
    // Called once immediately (the "first sweep" case) AND wired as the
    // interval's own callback (every subsequent sweep) -- not just handed
    // to setInterval, which would skip the first tick for 5s.
    expect(main).toMatch(/pushAfterDiscoverySweep\(\);/);
    expect(main).toMatch(/discoveryTimer\s*=\s*setInterval\(pushAfterDiscoverySweep,\s*5000\)/);
  });
});

// Quick answers final review I1: the spool tick is the trigger that sees a
// PermissionRequest land after the status file already said waiting, so it
// must push the watched conversation pane as well as the fleet.
describe('spool tick', () => {
  it('passes the sessions it ingested to notifySessionChanged', () => {
    const body = functionBody(main, 'startBackgroundWork');
    const tick = body.slice(body.search(/spoolTimer\s*=\s*setInterval\(/));
    expect(tick).toMatch(/ingestSpool\(db,\s*paths\.spool,\s*'claude',\s*touched\)/);
    expect(tick).toMatch(/notifySessionChanged\(touched\)/);
  });
});

// A write that outwaits better-sqlite3's 5s busy timeout throws
// SQLITE_BUSY. ingestSpool does not catch that (src/hooks/spool.ts: the
// stmt.run loop is bare), and an interval callback has no caller to catch
// it either -- so before this it became an unhandled exception and took the
// whole main process down. Unlikely while one instance runs, steadily less
// so with a packaged build beside a dev one (KNOWN_ISSUES, 2026-09-22).
// ingestAll is the same shape: it catches PER FILE, but a throw from the
// corpus walk itself escapes, and there it would also skip the watcher and
// the spool timer that follow it.
//
// Text/structure checks only, the same limitation this whole file has --
// index.ts imports `app` from 'electron', which is a path-string stub under
// plain-Node vitest, so its real startup path cannot be executed here.
describe('a failed ingest is handled, not thrown into the main process', () => {
  it('wraps the spool tick ingest, logs the reason, and leaves it to the next tick', () => {
    const body = functionBody(main, 'startBackgroundWork');
    const tick = body.slice(body.search(/spoolTimer\s*=\s*setInterval\(/));
    // try { ... ingestSpool(...) ... } catch (err) { console.error(..., err ...) }
    expect(tick).toMatch(/try\s*{[^}]*ingestSpool\(/);
    expect(tick).toMatch(/catch\s*\((\w+)\)\s*{\s*console\.error\([^;]*\1/);
  });

  it('wraps the startup ingest so a throw cannot skip the watcher and the spool timer', () => {
    const body = functionBody(main, 'startBackgroundWork');
    expect(body).toMatch(/try\s*{\s*ingestAll\(db,\s*roots\(\)\);\s*}\s*catch\s*\((\w+)\)\s*{\s*console\.error\([^;]*\1/);
    // Still ahead of the watcher and the spool timer, and still before the
    // push -- wrapping it must not reorder startup.
    const ingestAt = body.indexOf('ingestAll(db, roots())');
    expect(body.indexOf('startWatcher(')).toBeGreaterThan(ingestAt);
    expect(body.search(/spoolTimer\s*=\s*setInterval\(/)).toBeGreaterThan(ingestAt);
  });

  it('still pushes whatever a failed spool tick managed to write before it threw', () => {
    const body = functionBody(main, 'startBackgroundWork');
    const tick = body.slice(body.search(/spoolTimer\s*=\s*setInterval\(/));
    // Rows already written are committed, so the push condition reads
    // `touched` as well as the return value, not the return value alone.
    expect(tick).toMatch(/touched\.size\s*>\s*0/);
  });
});

// Quick answers final review M9: a failed chmod of the spool folder is
// logged with its error, never swallowed.
describe('spool folder permissions', () => {
  it('logs a failure to tighten the spool folder instead of ignoring it', () => {
    expect(main).toMatch(/chmodSync\(paths\.spool,\s*0o700\);\s*}\s*catch\s*\((\w+)\)\s*{\s*console\.error\([^)]*\1\)/);
  });
});
