import { describe, expect, it } from 'vitest';
import { codexRelayThreadForPid } from '../../src/main/codexRelayControl.ts';

const THREAD = '01a0da0c-2964-76a2-bf2e-dbcbb26243df';

describe('codexRelayThreadForPid', () => {
  const deps = {
    nameForPid: () => 'llmws-codex-relay-857a5c44',
    hasSession: () => true,
    readOption: (_name: string, option: string) =>
      option === '@llmws-codex-connected' ? '1' : THREAD,
  };

  it('returns an exact ID only while the TUI and its own relay are connected', () => {
    expect(codexRelayThreadForPid(4821, deps)).toBe(THREAD);
    expect(codexRelayThreadForPid(4821, { ...deps, hasSession: name => name !== 'fleet-codex-relay-857a5c44' })).toBe(false);
    expect(codexRelayThreadForPid(4821, { ...deps, readOption: () => '0' })).toBe(false);
    expect(codexRelayThreadForPid(4821, { ...deps, nameForPid: () => 'llmws-claude-857a5c44' })).toBeNull();
  });

  it('rejects malformed IDs from tmux', () => {
    expect(codexRelayThreadForPid(4821, { ...deps, readOption: (_name, option) =>
      option === '@llmws-codex-connected' ? '1' : 'old-id\nmalicious' })).toBe(false);
  });
});
