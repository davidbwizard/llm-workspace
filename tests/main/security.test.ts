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
      // The dependency checks (first-run design §3-§5). Read-only and
      // argument-free: checks:get returns main's cached sweep, checks:run
      // re-probes. Neither takes anything from the renderer, and the only
      // commands either can cause to run are the fixed `--version`/`doctor`
      // list pinned in tests/main/checks.test.ts -- no renderer input
      // reaches a spawn, and no probe ever sends a prompt to a model.
      'checks:get', 'checks:run',
      // Read-only: which answer the person has already given about the
      // hooks install (first-run design §6).
      'consent:get',
      'dialog:directory',
      'fleet:history', 'fleet:list',
      // Quick answers switch: main re-probes settings.json fresh on every
      // call (src/hooks/switch.ts) and writes it only through the existing
      // atomic, mode-preserving, exact-command-match install/uninstall
      // path -- see tests/hooks/switch.test.ts.
      // 'hooks:decline' records a no and writes nothing to settings.json.
      // 'hooks:preview' is read-only: it reports what an install WOULD add
      // and issues the token without which hooks:set cannot install at all
      // (first-run design §6) -- so the app cannot edit a file the person
      // owns without having just shown them what it would put there.
      'hooks:decline', 'hooks:get', 'hooks:preview', 'hooks:set',
      // Quick answers: main re-derives the prompt and checks the answer and
      // the pane before any key -- see tests/main/answer.test.ts's guards.
      'session:answer',
      // session:image and session:attachments: read-only; their checks live
      // in src/main/images.ts and src/main/attachments.ts.
      'session:attach', 'session:attachments',
      // Codex answers: main resolves the pid to the subscribed thread and
      // derives the response from its live server request, never renderer
      // supplied permissions or a raw JSON-RPC payload.
      'session:codex:answer',
      'session:conversation', 'session:detach',
      // The only channels where a string a MODEL wrote reaches an OS call.
      // Every check is in src/main/files.ts (tests/main/files.test.ts), and
      // the call itself is shell.showItemInFolder -- asserted below.
      'session:file:open', 'session:file:probe',
      'session:image', 'session:keys',
      'session:kill', 'session:launch',
      // The mode switcher: the renderer names a pid and a mode name and
      // nothing else. Main resolves the provider itself, checks the mode
      // against THAT provider's list, refuses mid-turn or with a prompt
      // card up, reads the pane before pressing, and sends only BTab --
      // the single constant the tmux key allowlist gained for it. See
      // tests/main/mode.test.ts's guards and tests/main/tmux.test.ts.
      'session:mode:set',
      'session:raw', 'session:reattach',
      'session:resize', 'session:resume', 'session:reveal',
      // Bytes only; checked and written by src/main/staging.ts.
      'session:stage-file', 'session:stage-image',
      // Which pid's conversation is on screen -- see the dedicated
      // watchSessionFor pid-validation tests below.
      'session:watch',
      // Usage and context: usage:get takes no argument and only reads; the
      // switch writes settings.json only through the Quick answers switch's
      // own path (tests/hooks/usageSwitch.test.ts).
      'usage:get', 'usage:switch:get', 'usage:switch:set',
    ]);
  });
});

/** The file viewer deliberately lets a path an agent wrote reach an OS
 *  call. shell.openPath hands that path to the file's DEFAULT APPLICATION,
 *  which for a .command, .app, .scpt or .webloc is arbitrary code execution
 *  straight out of transcript text; shell.showItemInFolder only selects it
 *  in Finder. The distinction is the whole feature, so it is asserted on
 *  source here rather than left to review -- same reasoning as the posture
 *  checks above. */
describe('a model-written path never reaches the OS default application', () => {
  const files = readFileSync('src/main/files.ts', 'utf8');
  const sources = ['src/main/ipc.ts', 'src/main/files.ts', 'src/main/index.ts', 'src/preload/index.ts']
    .map(f => strip(readFileSync(f, 'utf8')));

  it('reveals in Finder', () => {
    expect(strip(readFileSync('src/main/ipc.ts', 'utf8'))).toMatch(/shell\.showItemInFolder/);
  });

  it('calls openPath nowhere', () => {
    for (const src of sources) expect(src).not.toMatch(/openPath/);
  });

  it('keeps electron out of the module that resolves the path at all', () => {
    // No electron import means no openPath, no dialog and no BrowserWindow
    // in reach of the one module that turns renderer text into a path --
    // the reveal call is injected instead (its `reveal` dependency).
    expect(files).not.toMatch(/from\s*'electron'/);
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
