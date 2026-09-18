import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { watchSessionFor, type WatchDeps } from '../../src/main/sessionLive.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';

// Comments can contain the same event/option names the assertions below look
// for (e.g. a comment explaining why will-redirect is blocked would satisfy
// the assertion even if the handler were deleted). Strip them so every
// assertion here matches only code that actually runs.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

/** These are not style checks. A renderer with node integration, or a preload
 *  that forwards arbitrary channels, turns untrusted transcript text into
 *  remote code execution (spec §11.1). Asserting on source is deliberate:
 *  these must fail loudly in review, not at runtime. */
describe('renderer security posture', () => {
  const main = strip(readFileSync('src/main/index.ts', 'utf8'));
  const preload = strip(readFileSync('src/preload/index.ts', 'utf8'));

  it('enables context isolation', () => expect(main).toMatch(/contextIsolation:\s*true/));
  it('disables node integration', () => expect(main).toMatch(/nodeIntegration:\s*false/));
  it('enables the sandbox', () => expect(main).toMatch(/sandbox:\s*true/));
  it('denies new windows', () => expect(main).toMatch(/setWindowOpenHandler/));
  it('blocks navigation', () => {
    // will-navigate alone only covers main-frame, user-initiated navigation --
    // will-frame-navigate (subframes) and will-redirect (server redirects)
    // close the other two gaps (spec §11.1). Matched on the registration
    // form -- on('event-name') -- rather than the bare event name, so each
    // assertion confirms that specific handler is actually registered.
    expect(main).toMatch(/on\('will-navigate'/);
    expect(main).toMatch(/on\('will-frame-navigate'/);
    expect(main).toMatch(/on\('will-redirect'/);
  });

  it('exposes no generic invoke from the preload', () => {
    expect(preload).not.toMatch(/ipcRenderer\.invoke\(\s*channel/);
    expect(preload).not.toMatch(/\.\.\.args/);
  });

  it('exposes only the enumerated channels', () => {
    const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]);
    expect(exposed.sort()).toEqual([
      'app:theme',
      'dialog:directory',
      'fleet:history', 'fleet:list',
      // Quick answers switch: main re-probes settings.json fresh on every
      // call (src/hooks/switch.ts) and writes it only through the existing
      // atomic, mode-preserving, exact-command-match install/uninstall
      // path -- see tests/hooks/switch.test.ts.
      'hooks:get', 'hooks:set',
      // Quick answers: main re-derives the prompt and checks the answer and
      // the pane before any key -- see tests/main/answer.test.ts's guards.
      'session:answer',
      // session:image and session:attachments: read-only; their checks live
      // in src/main/images.ts and src/main/attachments.ts.
      'session:attach', 'session:attachments', 'session:conversation', 'session:detach', 'session:image', 'session:keys',
      'session:kill', 'session:launch', 'session:raw', 'session:reattach',
      'session:resize', 'session:resume', 'session:reveal',
      // Bytes only; checked and written by src/main/staging.ts.
      'session:stage-file', 'session:stage-image',
      // Which pid's conversation is on screen -- see the dedicated
      // watchSessionFor pid-validation tests below.
      'session:watch',
    ]);
  });
});

// session:watch's own pid boundary (watchSessionFor, src/main/sessionLive.ts):
// the renderer sends only a pid, and main must revalidate it -- a positive
// integer already present in a real discovery sweep -- before it is ever
// used to build a file path, since that path is what an fs.watch is opened
// on (see watchSessionFor's own doc comment for why the path may never be
// built from renderer-supplied text). These three refusals are the
// security-relevant boundary; watchSessionFor's fuller behaviour
// (coalescing, provider gating, teardown on move) is
// tests/main/sessionLive.test.ts's job, not this file's.
describe('session:watch pid validation', () => {
  const NOOP: WatchDeps = { processes: () => [], buildPayload: () => null, send: () => {} };
  const proc = (pid: number): LiveProcess =>
    ({ pid, provider: 'claude', tty: null, cwd: '/repo', host: 'iterm2', ageSeconds: 60, rssBytes: null });

  it('rejects a non-integer pid', () => {
    expect(watchSessionFor(1.5, NOOP)).toBe(false);
  });

  it('rejects a negative pid', () => {
    expect(watchSessionFor(-4821, NOOP)).toBe(false);
  });

  it('rejects a pid absent from discovery, even though it is a valid positive integer', () => {
    const deps: WatchDeps = { processes: () => [proc(111)], buildPayload: () => null, send: () => {} };
    expect(watchSessionFor(4821, deps)).toBe(false);
  });
});
