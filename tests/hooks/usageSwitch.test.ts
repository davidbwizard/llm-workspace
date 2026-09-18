import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { resolvePaths, type Paths } from '../../src/config.ts';
import {
  usageSwitchState, setUsageSwitch, stableStatusLinePath, statusLineCommand, refreshStatusLineIfInstalled,
  FOREIGN_STATUS_LINE,
} from '../../src/hooks/usageSwitch.ts';
import { setHooks, hooksState } from '../../src/hooks/switch.ts';

// The real repo files -- read-only, never written to. Standing in for main's
// copy of src/hooks/statusline.sh, exactly as the Quick answers switch tests
// do for helper.sh.
const SOURCE = resolve('src/hooks/statusline.sh');
const HELPER_SOURCE = resolve('src/hooks/helper.sh');

let home: string;
let paths: Paths;
const asRoot = process.getuid?.() === 0;

function fileId(path: string): { ino: number; mtimeMs: number } {
  const st = statSync(path);
  return { ino: st.ino, mtimeMs: st.mtimeMs };
}
function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}
function tempFilesIn(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.tmp'));
}

beforeEach(() => {
  // Every path here is inside a fresh mkdtemp directory. Nothing in this
  // file reads or writes the real ~/.claude or ~/.llm-workspace.
  home = mkdtempSync(join(tmpdir(), 'llmws-usage-switch-'));
  paths = resolvePaths(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function userSettings() {
  return {
    model: 'opus',
    hooks: {
      Notification: [{ hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/claude-notify.sh', timeout: 5 }] }],
    },
  };
}
function writeSettings(obj: unknown, mode = 0o600) {
  mkdirSync(dirname(paths.claudeSettings), { recursive: true });
  writeFileSync(paths.claudeSettings, JSON.stringify(obj, null, 2) + '\n');
  chmodSync(paths.claudeSettings, mode);
}
function readSettings(): any {
  return JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
}

describe('stable path and command', () => {
  it('is <home>/.llm-workspace/bin/statusline.sh, run through sh with the path single-quoted', () => {
    expect(stableStatusLinePath('/home/me')).toBe('/home/me/.llm-workspace/bin/statusline.sh');
    expect(statusLineCommand('/home/me')).toBe("sh '/home/me/.llm-workspace/bin/statusline.sh'");
  });

  it("escapes a single quote in the home path the same way the hooks' command does", () => {
    expect(statusLineCommand("/home/o'neil")).toBe("sh '/home/o'\\''neil/.llm-workspace/bin/statusline.sh'");
  });
});

describe('setUsageSwitch(on)', () => {
  it('adds our statusLine, keeps every other setting deep-equal, and keeps the file mode', () => {
    writeSettings(userSettings(), 0o600);

    const result = setUsageSwitch(paths, true, SOURCE);

    expect(result).toEqual({ installed: true, error: null });
    const after = readSettings();
    expect(after.statusLine).toEqual({ type: 'command', command: statusLineCommand(home) });
    const { statusLine: _ours, ...rest } = after;
    expect(rest).toEqual(userSettings());
    expect(modeOf(paths.claudeSettings)).toBe(0o600);
    expect(tempFilesIn(dirname(paths.claudeSettings))).toEqual([]);
  });

  it('copies the script, byte-equal, to the stable path inside a 0700 bin directory', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);

    const stable = stableStatusLinePath(home);
    expect(readFileSync(stable)).toEqual(readFileSync(SOURCE));
    expect(modeOf(dirname(stable))).toBe(0o700);
    expect(readdirSync(dirname(stable)).some(f => f.includes('.tmp'))).toBe(false);
  });

  // M4: the statusline snapshot folder itself (where the helper writes one
  // JSON file per session) is tightened here, in main -- not left to the
  // helper's own `mkdir -p` (umask-dependent, and never revisits a folder
  // that already exists looser than that).
  it('creates the statusline snapshot folder at 0700', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    expect(modeOf(paths.statusLineDir)).toBe(0o700);
  });

  it('tightens an existing, looser statusline snapshot folder to 0700', () => {
    writeSettings(userSettings());
    mkdirSync(paths.statusLineDir, { recursive: true });
    chmodSync(paths.statusLineDir, 0o755);

    setUsageSwitch(paths, true, SOURCE);

    expect(modeOf(paths.statusLineDir)).toBe(0o700);
  });

  it('creates settings.json when it is missing', () => {
    expect(existsSync(paths.claudeSettings)).toBe(false);
    expect(setUsageSwitch(paths, true, SOURCE)).toEqual({ installed: true, error: null });
    expect(readSettings()).toEqual({ statusLine: { type: 'command', command: statusLineCommand(home) } });
  });

  it("refuses the user's own status line: says so, and leaves settings.json byte-unchanged", () => {
    const theirs = { ...userSettings(), statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 1 } };
    writeSettings(theirs);
    const before = readFileSync(paths.claudeSettings, 'utf8');
    const id = fileId(paths.claudeSettings);

    const result = setUsageSwitch(paths, true, SOURCE);

    expect(result).toEqual({ installed: false, error: FOREIGN_STATUS_LINE });
    expect(FOREIGN_STATUS_LINE).toBe('You already have a status line in settings.json -- not replaced.');
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
    expect(fileId(paths.claudeSettings)).toEqual(id);
    // Nothing of ours is left behind for a refusal either.
    expect(existsSync(stableStatusLinePath(home))).toBe(false);
  });

  it('refuses a status line that runs our script from a different path', () => {
    writeSettings({ statusLine: { type: 'command', command: "sh '/elsewhere/.llm-workspace/bin/statusline.sh'" } });
    const before = readFileSync(paths.claudeSettings, 'utf8');
    expect(setUsageSwitch(paths, true, SOURCE).error).toBe(FOREIGN_STATUS_LINE);
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });

  it('does not rewrite settings.json when our statusLine is already there, but restores a missing script copy', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    const id = fileId(paths.claudeSettings);
    rmSync(stableStatusLinePath(home));

    const result = setUsageSwitch(paths, true, SOURCE);

    expect(result).toEqual({ installed: true, error: null });
    expect(fileId(paths.claudeSettings)).toEqual(id);
    expect(readFileSync(stableStatusLinePath(home))).toEqual(readFileSync(SOURCE));
  });

  it('returns the parse error and leaves an unparseable settings.json byte-unchanged', () => {
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    const bad = '{ this is not json';
    writeFileSync(paths.claudeSettings, bad);

    const result = setUsageSwitch(paths, true, SOURCE);

    expect(result).toEqual({
      installed: false, error: 'settings.json is not valid JSON -- fix it by hand, then try again.',
    });
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(bad);
  });

  it('refuses valid JSON that is not an object, leaving it byte-unchanged', () => {
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    writeFileSync(paths.claudeSettings, '[1, 2]\n');
    const result = setUsageSwitch(paths, true, SOURCE);
    expect(result.installed).toBe(false);
    expect(result.error).toMatch(/not a JSON object/);
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe('[1, 2]\n');
  });

  it.skipIf(asRoot)('refuses an unreadable settings.json with the read error, writing nothing', () => {
    writeSettings(userSettings());
    const before = readFileSync(paths.claudeSettings, 'utf8');
    chmodSync(paths.claudeSettings, 0o000);
    try {
      const result = setUsageSwitch(paths, true, SOURCE);
      expect(result.installed).toBe(false);
      expect(result.error).toMatch(/^Could not read settings\.json: .*EACCES/);
      expect(modeOf(paths.claudeSettings)).toBe(0o000);
      expect(tempFilesIn(dirname(paths.claudeSettings))).toEqual([]);
    } finally {
      chmodSync(paths.claudeSettings, 0o600);
    }
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });

  it.skipIf(asRoot)('reports a write failure with its real message', () => {
    writeSettings(userSettings());
    const before = readFileSync(paths.claudeSettings, 'utf8');
    const dir = dirname(paths.claudeSettings);
    chmodSync(dir, 0o500);
    try {
      const result = setUsageSwitch(paths, true, SOURCE);
      expect(result.installed).toBe(false);
      expect(result.error).toMatch(/^Could not write settings\.json: .*EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });

  it('reports a missing script source without touching settings.json', () => {
    writeSettings(userSettings());
    const before = readFileSync(paths.claudeSettings, 'utf8');
    const result = setUsageSwitch(paths, true, join(home, 'no-such-statusline.sh'));
    expect(result.installed).toBe(false);
    expect(result.error).toMatch(/^Could not install the status line script: .*ENOENT/);
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });
});

describe('setUsageSwitch(off)', () => {
  it('removes exactly our statusLine and keeps everything else deep-equal and the mode', () => {
    writeSettings(userSettings(), 0o640);
    setUsageSwitch(paths, true, SOURCE);

    const result = setUsageSwitch(paths, false, SOURCE);

    expect(result).toEqual({ installed: false, error: null });
    expect(readSettings()).toEqual(userSettings());
    expect(modeOf(paths.claudeSettings)).toBe(0o640);
  });

  it("leaves the user's own statusLine alone and writes nothing", () => {
    const theirs = { ...userSettings(), statusLine: { type: 'command', command: '~/.claude/statusline.sh' } };
    writeSettings(theirs);
    const id = fileId(paths.claudeSettings);

    const result = setUsageSwitch(paths, false, SOURCE);

    expect(result).toEqual({ installed: false, error: null });
    expect(fileId(paths.claudeSettings)).toEqual(id);
    expect(readSettings()).toEqual(theirs);
  });

  it('writes nothing when there is no statusLine at all', () => {
    writeSettings(userSettings());
    const id = fileId(paths.claudeSettings);
    expect(setUsageSwitch(paths, false, SOURCE)).toEqual({ installed: false, error: null });
    expect(fileId(paths.claudeSettings)).toEqual(id);
  });

  it('tolerates a missing settings.json -- no error, nothing created', () => {
    expect(setUsageSwitch(paths, false, SOURCE)).toEqual({ installed: false, error: null });
    expect(existsSync(paths.claudeSettings)).toBe(false);
    expect(existsSync(dirname(paths.claudeSettings))).toBe(false);
  });

  it('returns the parse error and leaves an unparseable settings.json byte-unchanged', () => {
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    const bad = '{ "statusLine": ';
    writeFileSync(paths.claudeSettings, bad);
    expect(setUsageSwitch(paths, false, SOURCE)).toEqual({
      installed: false, error: 'settings.json is not valid JSON -- fix it by hand, then try again.',
    });
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(bad);
  });

  it.skipIf(asRoot)('refuses an unreadable settings.json with the read error', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    chmodSync(paths.claudeSettings, 0o000);
    try {
      const result = setUsageSwitch(paths, false, SOURCE);
      expect(result.error).toMatch(/^Could not read settings\.json: .*EACCES/);
      expect(tempFilesIn(dirname(paths.claudeSettings))).toEqual([]);
    } finally {
      chmodSync(paths.claudeSettings, 0o600);
    }
    expect(readSettings().statusLine).toEqual({ type: 'command', command: statusLineCommand(home) });
  });

  it.skipIf(asRoot)('reports a write failure with its real message and still reads as on', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    const before = readFileSync(paths.claudeSettings, 'utf8');
    const dir = dirname(paths.claudeSettings);
    chmodSync(dir, 0o500);
    try {
      const result = setUsageSwitch(paths, false, SOURCE);
      expect(result.installed).toBe(true);
      expect(result.error).toMatch(/^Could not write settings\.json: .*EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });
});

describe('usageSwitchState', () => {
  it('is re-read from the file: on after install, off after a hand edit removes it', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    expect(usageSwitchState(paths)).toEqual({ installed: true, error: null });

    writeSettings(userSettings());
    expect(usageSwitchState(paths)).toEqual({ installed: false, error: null });
  });

  it("is off for the user's own status line", () => {
    writeSettings({ statusLine: { type: 'command', command: '~/.claude/statusline.sh' } });
    expect(usageSwitchState(paths)).toEqual({ installed: false, error: null });
  });

  it('is off when settings.json is missing or unparseable', () => {
    expect(usageSwitchState(paths)).toEqual({ installed: false, error: null });
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    writeFileSync(paths.claudeSettings, '{ nope');
    expect(usageSwitchState(paths)).toEqual({ installed: false, error: null });
  });
});

describe('independence from the Quick answers switch', () => {
  it('turning either switch on or off leaves the other one as it was', () => {
    writeSettings(userSettings());
    setHooks(paths, true, HELPER_SOURCE);
    setUsageSwitch(paths, true, SOURCE);
    expect(hooksState(paths).installed).toBe(true);
    expect(usageSwitchState(paths).installed).toBe(true);

    setUsageSwitch(paths, false, SOURCE);
    expect(hooksState(paths).installed).toBe(true);
    expect(readSettings().statusLine).toBeUndefined();

    setUsageSwitch(paths, true, SOURCE);
    setHooks(paths, false, HELPER_SOURCE);
    expect(usageSwitchState(paths).installed).toBe(true);
    // The two scripts share the bin folder but never each other's file.
    expect(readdirSync(join(home, '.llm-workspace/bin')).sort()).toEqual(['helper.sh', 'statusline.sh']);
  });
});

describe('refreshStatusLineIfInstalled', () => {
  it('does nothing when the switch is off', () => {
    writeSettings(userSettings());
    refreshStatusLineIfInstalled(paths, SOURCE);
    expect(existsSync(stableStatusLinePath(home))).toBe(false);
    expect(existsSync(paths.statusLineDir)).toBe(false);
  });

  it('refreshes a stale copy, and leaves a fresh one alone', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    const stable = stableStatusLinePath(home);
    writeFileSync(stable, '#!/bin/sh\n# old version\n');

    refreshStatusLineIfInstalled(paths, SOURCE);
    expect(readFileSync(stable)).toEqual(readFileSync(SOURCE));
    const id = fileId(stable);
    refreshStatusLineIfInstalled(paths, SOURCE);
    expect(fileId(stable)).toEqual(id);
  });

  it('never throws, even when the source is missing', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => refreshStatusLineIfInstalled(paths, join(home, 'missing.sh'))).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  // Review finding: turnOn only tightens the statusline snapshot folder at
  // the moment the switch is flipped on -- a folder loosened by hand (or
  // left over from before this app enforced 0700) between app launches
  // stays loose until the switch is toggled again. main/index.ts calls
  // this function on EVERY app start when the switch is already installed
  // (mirroring the spool folder's own startup re-chmod in
  // src/main/index.ts's app.whenReady), so this is where that same
  // re-tightening belongs for the statusline folder too.
  it('re-tightens an existing, looser statusline folder to 0700 on every call, not just turnOn', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    chmodSync(paths.statusLineDir, 0o755);

    refreshStatusLineIfInstalled(paths, SOURCE);

    expect(modeOf(paths.statusLineDir)).toBe(0o700);
  });

  it('creates the statusline folder at 0700 if it is missing entirely', () => {
    writeSettings(userSettings());
    setUsageSwitch(paths, true, SOURCE);
    rmSync(paths.statusLineDir, { recursive: true, force: true });

    refreshStatusLineIfInstalled(paths, SOURCE);

    expect(modeOf(paths.statusLineDir)).toBe(0o700);
  });
});
