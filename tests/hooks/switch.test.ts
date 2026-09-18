import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { resolvePaths, type Paths } from '../../src/config.ts';
import { hooksState, setHooks, stableHelperPath, refreshHelperIfInstalled } from '../../src/hooks/switch.ts';

// The real repo file -- read-only, never written to. Standing in for
// "main's copy of src/hooks/helper.sh" (the `helperSource` argument),
// exactly as design §4 describes it: setHooks never touches the app's own
// install location, only a caller-supplied source path.
const HELPER_SOURCE = resolve('src/hooks/helper.sh');

let home: string;
let paths: Paths;

// Permission-based failures below (an unreadable file, a read-only folder)
// cannot be produced as root, which can read and write through them.
const asRoot = process.getuid?.() === 0;

/** Identity of the file on disk: an atomic write renames a new file over
 *  the old one, so an unchanged inode proves nothing was written. */
function fileId(path: string): { ino: number; mtimeMs: number } {
  const st = statSync(path);
  return { ino: st.ino, mtimeMs: st.mtimeMs };
}

function tempFilesIn(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.tmp'));
}

beforeEach(() => {
  // Hard safety rule: every path here is inside a fresh mkdtemp directory.
  // Nothing in this file ever reads or writes the real ~/.claude or
  // ~/.llm-workspace.
  home = mkdtempSync(join(tmpdir(), 'llmws-quickanswers-'));
  paths = resolvePaths(home);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

// The user's own three hooks (spec: block-env-read.sh, block-destructive-bash.sh,
// claude-notify.sh), spread across two events the way a real config would.
function userHooksConfig() {
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/block-destructive-bash.sh', timeout: 5 }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/block-env-read.sh', timeout: 5 }] },
      ],
      Notification: [
        { hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/claude-notify.sh', timeout: 5 }] },
      ],
    },
  };
}

function writeUserSettings(mode: number) {
  mkdirSync(dirname(paths.claudeSettings), { recursive: true });
  writeFileSync(paths.claudeSettings, JSON.stringify(userHooksConfig(), null, 2) + '\n');
  chmodSync(paths.claudeSettings, mode);
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('stableHelperPath', () => {
  it('is <home>/.llm-workspace/bin/helper.sh', () => {
    expect(stableHelperPath('/home/me')).toBe('/home/me/.llm-workspace/bin/helper.sh');
  });
});

describe('setHooks(on)', () => {
  it('adds a fragment whose command runs the stable helper, keeps the user\'s three hooks deep-equal, and keeps the file mode', () => {
    writeUserSettings(0o600);
    const before = userHooksConfig();

    const result = setHooks(paths, true, HELPER_SOURCE);

    expect(result).toEqual({ installed: true, error: null });

    const after = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    // The user's own three entries survive byte-for-byte in content --
    // `Notification` is also one of our own installed events, so its array
    // now holds the user's original entry PLUS ours, not just the user's.
    for (const entry of before.hooks.PreToolUse) {
      expect(after.hooks.PreToolUse.some((e: any) => JSON.stringify(e) === JSON.stringify(entry))).toBe(true);
    }
    for (const entry of before.hooks.Notification) {
      expect(after.hooks.Notification.some((e: any) => JSON.stringify(e) === JSON.stringify(entry))).toBe(true);
    }

    const stable = stableHelperPath(home);
    const ourCommand = `sh '${stable}'`;
    const allCommands = Object.values(after.hooks).flat().flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(allCommands).toContain(ourCommand);

    // File mode kept exactly as it was (0600), not the default a fresh
    // write would produce.
    expect(modeOf(paths.claudeSettings)).toBe(0o600);
  });

  it('copies the helper atomically to the stable path, byte-equal to the source, inside a 0700 bin directory', () => {
    writeUserSettings(0o600);
    setHooks(paths, true, HELPER_SOURCE);

    const stable = stableHelperPath(home);
    expect(existsSync(stable)).toBe(true);
    expect(readFileSync(stable)).toEqual(readFileSync(HELPER_SOURCE));
    expect(modeOf(dirname(stable))).toBe(0o700);
    // No leftover temp file from the atomic copy.
    expect(readdirSync(dirname(stable)).some((f: string) => f.includes('.tmp'))).toBe(false);
  });

  it('creates settings.json when it is missing', () => {
    // .claude does not even exist yet in this fresh temp home.
    expect(existsSync(paths.claudeSettings)).toBe(false);

    const result = setHooks(paths, true, HELPER_SOURCE);

    expect(result).toEqual({ installed: true, error: null });
    expect(existsSync(paths.claudeSettings)).toBe(true);
    const after = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    const stable = stableHelperPath(home);
    const allCommands = Object.values(after.hooks).flat().flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(allCommands).toContain(`sh '${stable}'`);
  });

  it('returns an error and leaves the file byte-unchanged when settings.json does not parse', () => {
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    const bad = '{ this is not json';
    writeFileSync(paths.claudeSettings, bad);

    const result = setHooks(paths, true, HELPER_SOURCE);

    expect(result.installed).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).not.toBeNull();
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(bad);
  });

  // Residual fix: planInstall (install.ts) assumes each hooks[event] it
  // reads is already an array (`??=` leaves a present-but-wrong value
  // alone, then calls .some() on it) -- valid JSON, but a shape it cannot
  // work with, must return an error rather than throw a TypeError out of
  // setHooks.
  it('returns an error and leaves the file byte-unchanged when a hooks event is not an array', () => {
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    const bad = JSON.stringify({ hooks: { SessionStart: 'not-an-array' } }, null, 2) + '\n';
    writeFileSync(paths.claudeSettings, bad);

    const result = setHooks(paths, true, HELPER_SOURCE);

    expect(result.installed).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).not.toBeNull();
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(bad);
  });
});

describe('setHooks(on) -- read and write failures (final review I3/I5)', () => {
  it.skipIf(asRoot)('refuses an unreadable settings.json: returns the read error and writes nothing', () => {
    writeUserSettings(0o600);
    const before = readFileSync(paths.claudeSettings, 'utf8');
    chmodSync(paths.claudeSettings, 0o000);
    try {
      const result = setHooks(paths, true, HELPER_SOURCE);
      expect(result.installed).toBe(false);
      expect(result.error).toMatch(/^Could not read settings\.json: .*EACCES/);
      expect(modeOf(paths.claudeSettings)).toBe(0o000);
      expect(tempFilesIn(dirname(paths.claudeSettings))).toEqual([]);
    } finally {
      chmodSync(paths.claudeSettings, 0o600);
    }
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });

  it.skipIf(asRoot)('reports a write failure with its real message, not "Settings changed"', () => {
    writeUserSettings(0o600);
    const before = readFileSync(paths.claudeSettings, 'utf8');
    const dir = dirname(paths.claudeSettings);
    chmodSync(dir, 0o500);
    try {
      const result = setHooks(paths, true, HELPER_SOURCE);
      expect(result.installed).toBe(false);
      expect(result.error).toMatch(/^Could not write settings\.json: .*EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });

  // Final review M10: nothing to add means nothing written.
  it('does not rewrite settings.json when every hook is already present', () => {
    writeUserSettings(0o600);
    setHooks(paths, true, HELPER_SOURCE);
    const before = fileId(paths.claudeSettings);

    const result = setHooks(paths, true, HELPER_SOURCE);

    expect(result).toEqual({ installed: true, error: null });
    expect(fileId(paths.claudeSettings)).toEqual(before);
  });
});

describe('setHooks(off)', () => {
  it('leaves the user\'s three hooks deep-equal and removes the owned command', () => {
    writeUserSettings(0o600);
    const before = userHooksConfig();
    setHooks(paths, true, HELPER_SOURCE);

    const result = setHooks(paths, false, HELPER_SOURCE);

    expect(result).toEqual({ installed: false, error: null });
    const after = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
    expect(after.hooks.Notification).toEqual(before.hooks.Notification);
    for (const entry of before.hooks.PreToolUse) {
      expect(after.hooks.PreToolUse.some((e: any) => JSON.stringify(e) === JSON.stringify(entry))).toBe(true);
    }
    const stable = stableHelperPath(home);
    const ourCommand = `sh '${stable}'`;
    const allCommands = Object.values(after.hooks).flat().flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(allCommands).not.toContain(ourCommand);
    expect(modeOf(paths.claudeSettings)).toBe(0o600);
  });

  it('returns the parse error and leaves the file byte-unchanged when settings.json does not parse', () => {
    mkdirSync(dirname(paths.claudeSettings), { recursive: true });
    const bad = '{ this is not json';
    writeFileSync(paths.claudeSettings, bad);

    const result = setHooks(paths, false, HELPER_SOURCE);

    expect(result).toEqual({
      installed: false, error: 'settings.json is not valid JSON -- fix it by hand, then try again.',
    });
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(bad);
  });

  it.skipIf(asRoot)('refuses an unreadable settings.json with the read error, not the parse error', () => {
    writeUserSettings(0o600);
    setHooks(paths, true, HELPER_SOURCE);
    const before = readFileSync(paths.claudeSettings, 'utf8');
    chmodSync(paths.claudeSettings, 0o000);
    try {
      const result = setHooks(paths, false, HELPER_SOURCE);
      expect(result.error).toMatch(/^Could not update settings\.json: .*EACCES/);
      expect(tempFilesIn(dirname(paths.claudeSettings))).toEqual([]);
    } finally {
      chmodSync(paths.claudeSettings, 0o600);
    }
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });

  it.skipIf(asRoot)('reports a write failure with its real message, not the parse error', () => {
    writeUserSettings(0o600);
    setHooks(paths, true, HELPER_SOURCE);
    const before = readFileSync(paths.claudeSettings, 'utf8');
    const dir = dirname(paths.claudeSettings);
    chmodSync(dir, 0o500);
    try {
      const result = setHooks(paths, false, HELPER_SOURCE);
      expect(result.installed).toBe(true);
      expect(result.error).toMatch(/^Could not update settings\.json: .*EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(before);
  });

  // Final review M10: nothing of ours to remove means nothing written.
  it('does not rewrite settings.json when none of our hooks are there', () => {
    writeUserSettings(0o600);
    const before = fileId(paths.claudeSettings);

    const result = setHooks(paths, false, HELPER_SOURCE);

    expect(result).toEqual({ installed: false, error: null });
    expect(fileId(paths.claudeSettings)).toEqual(before);
  });

  it('tolerates a missing settings.json -- no error, nothing created', () => {
    expect(existsSync(paths.claudeSettings)).toBe(false);
    const result = setHooks(paths, false, HELPER_SOURCE);
    expect(result).toEqual({ installed: false, error: null });
    expect(existsSync(paths.claudeSettings)).toBe(false);
  });
});

describe('hooksState', () => {
  it('is true right after install and false right after uninstall', () => {
    writeUserSettings(0o600);
    setHooks(paths, true, HELPER_SOURCE);
    expect(hooksState(paths)).toEqual({ installed: true, error: null });
    setHooks(paths, false, HELPER_SOURCE);
    expect(hooksState(paths)).toEqual({ installed: false, error: null });
  });

  it('reflects a hand edit that removes our entries, without a stored manifest', () => {
    writeUserSettings(0o600);
    setHooks(paths, true, HELPER_SOURCE);
    expect(hooksState(paths).installed).toBe(true);

    // Hand edit: drop everything back to the user's own three hooks.
    writeFileSync(paths.claudeSettings, JSON.stringify(userHooksConfig()));
    expect(hooksState(paths)).toEqual({ installed: false, error: null });
  });

  it('is false when settings.json does not exist', () => {
    expect(hooksState(paths)).toEqual({ installed: false, error: null });
  });
});

describe('refreshHelperIfInstalled', () => {
  it('does nothing when hooks are not installed', () => {
    writeUserSettings(0o600);
    refreshHelperIfInstalled(paths, HELPER_SOURCE);
    expect(existsSync(stableHelperPath(home))).toBe(false);
  });

  it('refreshes the stable copy when its content differs from the source, and leaves it alone when it already matches', () => {
    writeUserSettings(0o600);
    setHooks(paths, true, HELPER_SOURCE);
    const stable = stableHelperPath(home);

    // Simulate a stale copy from an older app version.
    writeFileSync(stable, '#!/bin/sh\n# old version\n');
    refreshHelperIfInstalled(paths, HELPER_SOURCE);
    expect(readFileSync(stable)).toEqual(readFileSync(HELPER_SOURCE));

    // Calling it again when already fresh must not throw or corrupt it.
    refreshHelperIfInstalled(paths, HELPER_SOURCE);
    expect(readFileSync(stable)).toEqual(readFileSync(HELPER_SOURCE));
  });
});
