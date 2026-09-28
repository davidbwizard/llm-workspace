import { describe, expect, it, vi } from 'vitest';
import { codexRelayThreadForPid, waitForCodexThreadId } from '../../src/main/codexRelayControl.ts';

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

// The thread id does not exist when the TUI is spawned: it appears only
// once the TUI has connected through the relay and the App Server has
// answered its thread/start. Anything that needs the id at launch time has
// to wait for it.
describe('waitForCodexThreadId', () => {
  it('resolves the moment the relay publishes an exact id', async () => {
    const answers: (string | false | null)[] = [false, false, THREAD];
    const thread = vi.fn(() => answers.shift() ?? THREAD);
    expect(await waitForCodexThreadId(4821, 1000, { thread, intervalMs: 1 })).toBe(THREAD);
    expect(thread).toHaveBeenCalledTimes(3);
    expect(thread).toHaveBeenCalledWith(4821);
  });

  // Bounded, and a timeout is a plain null rather than a throw -- the
  // caller decides what a missing id costs, and for a launch it costs the
  // name, never the session.
  it('gives up at the timeout instead of waiting forever', async () => {
    const started = Date.now();
    expect(await waitForCodexThreadId(4821, 60, { thread: () => false, intervalMs: 10 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // `false` is "Fleet relay TUI whose exact thread is not available yet",
  // which is worth waiting through; `null` is "not a Fleet relay TUI at
  // all", which no amount of waiting will change.
  it('stops immediately when the pid is not a Fleet relay TUI', async () => {
    const thread = vi.fn(() => null);
    expect(await waitForCodexThreadId(4821, 1000, { thread, intervalMs: 1 })).toBeNull();
    expect(thread).toHaveBeenCalledTimes(1);
  });
});
