import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, type Paths } from '../../src/config.ts';
import {
  readConsent, recordConsent, previewHooksInstall, commitHooksInstall,
  resetPendingConsent, uninstallHooks, CONSENT_REQUIRED,
} from '../../src/hooks/consent.ts';
import { hooksState } from '../../src/hooks/switch.ts';

let home = '';
let paths: Paths;
let helperSource = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'llmw-consent-'));
  paths = resolvePaths(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  helperSource = join(home, 'helper-source.sh');
  writeFileSync(helperSource, '#!/bin/sh\necho hook\n');
  resetPendingConsent();
});

afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const settings = () => JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
const writeSettings = (o: unknown) => writeFileSync(paths.claudeSettings, JSON.stringify(o, null, 2) + '\n');

describe('showing what will be written, before writing it', () => {
  // Design §6. On the author's own machine this is invisible; on a
  // stranger's it is an app modifying a config file they own.
  it('names the exact file it will write to', () => {
    const preview = previewHooksInstall(paths);
    expect(preview.file).toBe(join(home, '.claude/settings.json'));
    expect(preview.error).toBeNull();
  });

  it('names the helper script it will install, and where', () => {
    const preview = previewHooksInstall(paths);
    expect(preview.helperPath).toBe(join(home, '.llm-workspace/bin/helper.sh'));
  });

  it('lists every entry it will add, with the JSON that will appear in the file', () => {
    const preview = previewHooksInstall(paths);
    expect(preview.additions.length).toBeGreaterThan(0);
    for (const a of preview.additions) {
      expect(a.event.length).toBeGreaterThan(0);
      // Parseable JSON, and the command inside it is the one that will
      // actually be written -- not a description of it.
      const parsed = JSON.parse(a.json);
      expect(parsed.hooks[0].command).toContain(preview.helperPath);
    }
    expect(preview.additions.some(a => a.event === 'PreToolUse' && a.matcher !== null)).toBe(true);
  });

  it('writes absolutely nothing while previewing', () => {
    previewHooksInstall(paths);
    expect(existsSync(paths.claudeSettings)).toBe(false);
    expect(existsSync(join(home, '.llm-workspace/bin/helper.sh'))).toBe(false);
  });

  it('shows nothing to add when it is already installed', () => {
    const first = previewHooksInstall(paths);
    commitHooksInstall(paths, first.token!, helperSource);
    const again = previewHooksInstall(paths);
    expect(again.installed).toBe(true);
    expect(again.additions).toEqual([]);
  });

  it('refuses to preview an unparseable settings.json rather than guessing', () => {
    writeFileSync(paths.claudeSettings, '{ not json');
    const preview = previewHooksInstall(paths);
    expect(preview.error).not.toBeNull();
    expect(preview.token).toBeNull();
  });
});

describe('consent is a gate in front of the write, not a dialog beside it', () => {
  it('refuses to install without a token from a preview', () => {
    const result = commitHooksInstall(paths, 'made-up-token', helperSource);
    expect(result.error).toBe(CONSENT_REQUIRED);
    expect(result.installed).toBe(false);
    // The point of the gate: nothing was written at all.
    expect(existsSync(paths.claudeSettings)).toBe(false);
  });

  it('refuses an empty or missing token', () => {
    expect(commitHooksInstall(paths, '', helperSource).error).toBe(CONSENT_REQUIRED);
    expect(existsSync(paths.claudeSettings)).toBe(false);
  });

  it('installs when the token came from a preview', () => {
    const preview = previewHooksInstall(paths);
    const result = commitHooksInstall(paths, preview.token!, helperSource);
    expect(result.error).toBeNull();
    expect(result.installed).toBe(true);
    expect(hooksState(paths).installed).toBe(true);
  });

  it('spends the token: the same one cannot write twice', () => {
    const preview = previewHooksInstall(paths);
    expect(commitHooksInstall(paths, preview.token!, helperSource).error).toBeNull();
    // A second write needs a second showing.
    expect(commitHooksInstall(paths, preview.token!, helperSource).error).toBe(CONSENT_REQUIRED);
  });

  it('writes exactly what the preview showed, not a freshly recomputed plan', () => {
    const preview = previewHooksInstall(paths);
    // Someone else edits settings.json between the showing and the yes.
    writeSettings({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'their-own-thing' }] }] } });
    const result = commitHooksInstall(paths, preview.token!, helperSource);
    // Refused, not silently applied over content the person never saw.
    expect(result.error).toMatch(/again/i);
    expect(result.installed).toBe(false);
    // And their entry survived untouched.
    expect(settings().hooks.SessionStart[0].hooks[0].command).toBe('their-own-thing');
  });
});

describe('asking once, and taking no for an answer', () => {
  it('has no decision recorded before anyone is asked', () => {
    expect(readConsent(paths.consent).hooks).toBeUndefined();
  });

  it('remembers a no, so the app stops asking', () => {
    recordConsent(paths.consent, 'declined');
    expect(readConsent(paths.consent).hooks?.decision).toBe('declined');
  });

  it('records a yes when the install actually succeeds', () => {
    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token!, helperSource);
    expect(readConsent(paths.consent).hooks?.decision).toBe('granted');
  });

  it('does not record consent for an install that failed', () => {
    const preview = previewHooksInstall(paths);
    writeSettings({ hooks: { SessionStart: [] } }); // changes the file under it
    commitHooksInstall(paths, preview.token!, helperSource);
    expect(readConsent(paths.consent).hooks).toBeUndefined();
  });

  it('a declined answer never writes to settings.json', () => {
    recordConsent(paths.consent, 'declined');
    expect(existsSync(paths.claudeSettings)).toBe(false);
  });

  it('survives a consent file that is missing, empty or corrupt', () => {
    expect(readConsent(join(home, 'nope.json'))).toEqual({});
    writeFileSync(join(home, 'empty.json'), '');
    expect(readConsent(join(home, 'empty.json'))).toEqual({});
    writeFileSync(join(home, 'bad.json'), '{{{');
    expect(readConsent(join(home, 'bad.json'))).toEqual({});
    writeFileSync(join(home, 'array.json'), '[1,2]');
    expect(readConsent(join(home, 'array.json'))).toEqual({});
  });

  it('lets a declined answer be changed later', () => {
    recordConsent(paths.consent, 'declined');
    const preview = previewHooksInstall(paths);
    expect(commitHooksInstall(paths, preview.token!, helperSource).installed).toBe(true);
    expect(readConsent(paths.consent).hooks?.decision).toBe('granted');
  });
});

describe('a clean uninstall removes what it added and nothing else', () => {
  it('removes every entry it installed', () => {
    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token!, helperSource);
    expect(hooksState(paths).installed).toBe(true);

    const result = uninstallHooks(paths);
    expect(result.error).toBeNull();
    expect(result.installed).toBe(false);
    expect(settings().hooks ?? {}).toEqual({});
  });

  it('leaves the person\'s own hooks exactly as they were', () => {
    const mine = { type: 'command', command: 'sh /home/me/my-own-hook.sh', timeout: 9 };
    writeSettings({
      hooks: {
        SessionStart: [{ hooks: [mine] }],
        // An event we never touch at all.
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
      otherSetting: { kept: true },
    });

    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token!, helperSource);
    uninstallHooks(paths);

    const after = settings();
    expect(after.hooks.SessionStart).toEqual([{ hooks: [mine] }]);
    expect(after.hooks.PreCompact).toEqual([{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
    expect(after.otherSetting).toEqual({ kept: true });
  });

  it('never removes a hook that merely mentions the helper path', () => {
    // Exact command match only. Someone whose own script takes our helper
    // as an argument keeps their hook.
    const helper = join(home, '.llm-workspace/bin/helper.sh');
    const theirs = { type: 'command', command: `sh /their/wrapper.sh '${helper}'` };
    writeSettings({ hooks: { SessionStart: [{ hooks: [theirs] }] } });

    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token!, helperSource);
    uninstallHooks(paths);

    expect(settings().hooks.SessionStart).toEqual([{ hooks: [theirs] }]);
  });

  it('needs no token: removing what we added is always allowed', () => {
    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token!, helperSource);
    resetPendingConsent();
    expect(uninstallHooks(paths).error).toBeNull();
    expect(hooksState(paths).installed).toBe(false);
  });

  it('is a no-op when there is nothing of ours to remove', () => {
    expect(uninstallHooks(paths).error).toBeNull();
    expect(existsSync(paths.claudeSettings)).toBe(false);
  });

  it('records the decision as declined, so uninstalling stops the asking too', () => {
    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token!, helperSource);
    uninstallHooks(paths);
    expect(readConsent(paths.consent).hooks?.decision).toBe('declined');
  });
});

/** Codex has its own hook system (codex-cli 0.156.1: twelve events, config
 *  in ~/.codex/hooks.json, same shape as Claude's). Installing there means
 *  a SECOND file the person owns, so design §6's promise -- show every file
 *  and what goes in it, before writing -- has to stretch to cover it. */
describe('the Codex half of the same consent', () => {
  const codexDir = () => join(home, '.codex');
  const giveCodex = (hooks?: unknown) => {
    mkdirSync(codexDir(), { recursive: true });
    if (hooks !== undefined) writeFileSync(paths.codexHooks, JSON.stringify(hooks, null, 2) + '\n');
  };
  const codexFile = () => JSON.parse(readFileSync(paths.codexHooks, 'utf8'));

  it('offers nothing for Codex on a machine that has none', () => {
    // Creating ~/.codex for someone who does not use Codex would be the
    // app making itself at home in a tool they never installed.
    const preview = previewHooksInstall(paths);
    expect(preview.codex).toBeNull();
    commitHooksInstall(paths, preview.token, helperSource);
    expect(existsSync(paths.codexHooks)).toBe(false);
  });

  it('names the Codex file and every entry it would add there', () => {
    giveCodex();
    const preview = previewHooksInstall(paths);
    expect(preview.codex?.file).toBe(join(home, '.codex/hooks.json'));
    expect(preview.codex?.fileExists).toBe(false);
    expect(preview.codex?.additions.map(a => a.event)).toContain('PermissionRequest');
  });

  it('writes both files on one yes', () => {
    giveCodex();
    const preview = previewHooksInstall(paths);
    const result = commitHooksInstall(paths, preview.token, helperSource);
    expect(result.error).toBeNull();
    expect(settings().hooks.PermissionRequest).toHaveLength(1);
    expect(codexFile().hooks.PermissionRequest).toHaveLength(1);
  });

  it('leaves the user\'s own Codex hooks alone, installing and removing', () => {
    const mine = { type: 'command', command: "bash '/u/.codex/hooks/block-destructive-bash.sh'", timeout: 5 };
    giveCodex({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } });
    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token, helperSource);
    expect(codexFile().hooks.PreToolUse[0].hooks[0].command).toContain('block-destructive-bash.sh');

    uninstallHooks(paths);
    const after = codexFile();
    expect(after.hooks.PermissionRequest).toBeUndefined();
    expect(after.hooks.PreToolUse[0].hooks[0].command).toContain('block-destructive-bash.sh');
  });

  it('reports an unreadable Codex file without blocking the Claude install', () => {
    // A broken hooks.json belongs to Codex, not to us. Refusing the whole
    // install over it would let another tool's bad file veto this one.
    giveCodex();
    writeFileSync(paths.codexHooks, '{ not json');
    const preview = previewHooksInstall(paths);
    expect(preview.codex).toBeNull();
    expect(preview.error).toContain('Codex');
    expect(preview.token).not.toBeNull();
    const result = commitHooksInstall(paths, preview.token, helperSource);
    expect(settings().hooks.PermissionRequest).toHaveLength(1);
    expect(result.installed).toBe(true);
  });

  it('never installs a Codex event codex-cli does not have', () => {
    giveCodex();
    const preview = previewHooksInstall(paths);
    const events = preview.codex!.additions.map(a => a.event);
    for (const absent of ['PermissionDenied', 'Notification', 'CwdChanged', 'Elicitation']) {
      expect(events).not.toContain(absent);
    }
  });
});

/** Writing the hook is only half an install: Codex will not run one it has
 *  not been shown, so the screen has to be able to say which. */
describe('whether Codex has approved our hook', () => {
  const giveCodex = () => mkdirSync(join(home, '.codex'), { recursive: true });
  const writeCodexConfig = (body: string) =>
    writeFileSync(join(home, '.codex/config.toml'), body);

  it('says nothing about approval on a machine with no Codex', () => {
    expect(previewHooksInstall(paths).codexApproved).toBeNull();
  });

  it('is false while Codex has no trust record for it', () => {
    giveCodex();
    expect(previewHooksInstall(paths).codexApproved).toBe(false);
  });

  it('is true once Codex has one', () => {
    giveCodex();
    writeCodexConfig(
      `[hooks.state."${paths.codexHooks}:permission_request:0:0"]\ntrusted_hash = "sha256:abc"\n`);
    expect(previewHooksInstall(paths).codexApproved).toBe(true);
  });

  it('stays false right after a successful write -- the write is not the approval', () => {
    giveCodex();
    const preview = previewHooksInstall(paths);
    commitHooksInstall(paths, preview.token, helperSource);
    expect(previewHooksInstall(paths).codexApproved).toBe(false);
  });
});
