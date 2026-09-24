import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, type Paths } from '../../src/config.ts';
import { codexHookApproved, snakeEvent } from '../../src/hooks/codexTrust.ts';

let home = '';
let paths: Paths;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'llmw-codextrust-'));
  paths = resolvePaths(home);
  mkdirSync(join(home, '.codex'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const writeConfig = (body: string) => writeFileSync(join(home, '.codex/config.toml'), body);

describe('snakeEvent', () => {
  it('spells an event the way Codex spells it in its state keys', () => {
    expect(snakeEvent('PermissionRequest')).toBe('permission_request');
    expect(snakeEvent('PreToolUse')).toBe('pre_tool_use');
    expect(snakeEvent('Stop')).toBe('stop');
  });
});

describe('codexHookApproved', () => {
  it('is false when Codex has no record of our hook', () => {
    writeConfig('[hooks.state]\n');
    expect(codexHookApproved(paths, 'PermissionRequest')).toBe(false);
  });

  it('is true once Codex has trusted a hook of ours on that event', () => {
    writeConfig(
      `[hooks.state]\n\n[hooks.state."${paths.codexHooks}:permission_request:0:0"]\n`
      + 'trusted_hash = "sha256:abc"\n');
    expect(codexHookApproved(paths, 'PermissionRequest')).toBe(true);
  });

  it('finds the record wherever our entry sits in the file', () => {
    // Where our hook lands depends on what the person already had.
    writeConfig(`[hooks.state."${paths.codexHooks}:permission_request:3:1"]\ntrusted_hash = "sha256:abc"\n`);
    expect(codexHookApproved(paths, 'PermissionRequest')).toBe(true);
  });

  it('does not mistake a DIFFERENT file\'s trusted hook for ours', () => {
    // A plugin's own hooks.json is trusted under its own path.
    writeConfig('[hooks.state."plugin@official:hooks/hooks.json:permission_request:0:0"]\n'
      + 'trusted_hash = "sha256:abc"\n');
    expect(codexHookApproved(paths, 'PermissionRequest')).toBe(false);
  });

  it('does not mistake another EVENT on our file for the one asked about', () => {
    writeConfig(`[hooks.state."${paths.codexHooks}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`);
    expect(codexHookApproved(paths, 'PermissionRequest')).toBe(false);
  });

  it('reads a missing config as not approved, never as approved', () => {
    // The conservative answer: prompt the person to check rather than
    // quietly claim an approval nothing shows.
    expect(codexHookApproved(paths, 'PermissionRequest')).toBe(false);
  });
});
