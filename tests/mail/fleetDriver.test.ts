import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetDriver, livePanePids } from '../../src/mail/fleetDriver.ts';

let inputs: string[] = [];
const recorder = (inMode: '0' | '1') => {
  const calls: string[][] = [];
  let screen = 0;
  inputs = [];
  const exec = (args: string[], input?: string) => {
    calls.push(args);
    if (input !== undefined) inputs.push(input);
    if (args[0] === 'capture-pane') return { ok: true as const, stdout: `screen ${screen++}` };
    return { ok: true as const, stdout: args.includes('#{pane_in_mode}') ? `${inMode}\n` : '' };
  };
  return { calls, exec };
};

describe('fleet session driver', () => {
  it('pastes the pass as bracketed text after leaving scroll mode, then presses Enter', () => {
    const { calls, exec } = recorder('1');
    const line = 'Pass 2: read /x and do what it says.';
    expect(createFleetDriver({ exec, sleepSync: () => {} }).typeLine('llmws-codex-mail-abc', line, false)).toBeNull();
    const verbs = calls.map(a => (a[0] === 'send-keys' ? `send-keys ${a[a.length - 1]}` : a[0]));
    expect(verbs).toEqual(['display-message', 'send-keys cancel', 'capture-pane', 'load-buffer', 'paste-buffer', 'capture-pane', 'send-keys Enter']);
    expect(inputs).toEqual([line]);
    expect(calls.some(a => a.includes('-l'))).toBe(false);
  });

  it('queues with Tab when asked, and stays out of scroll mode handling when not scrolled', () => {
    const { calls, exec } = recorder('0');
    createFleetDriver({ exec, sleepSync: () => {} }).typeLine('llmws-codex-mail-abc', 'hi', true);
    expect(calls.some(a => a.includes('-X'))).toBe(false);
    expect(calls[calls.length - 1]).toEqual(['send-keys', '-t', '=llmws-codex-mail-abc:', 'Tab']);
  });

  it('reads whether a Codex rollout is mid-turn', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-d-')), 'r.jsonl');
    const ev = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } });
    writeFileSync(file, `${ev('task_started')}\n${ev('task_complete')}\n${ev('task_started')}\n`);
    expect(createFleetDriver({}).codexBusy(file)).toBe(true);
    writeFileSync(file, `${ev('task_started')}\n${ev('task_complete')}\n`);
    expect(createFleetDriver({}).codexBusy(file)).toBe(false);
    expect(createFleetDriver({}).codexBusy(join(file, '..', 'missing.jsonl'))).toBe(false);
  });

  it('opens a session through Fleet launch and reports failures', () => {
    const { calls, exec } = recorder('0');
    const driver = createFleetDriver({ exec, panePid: () => 4242 });
    expect(driver.open('codex', '/p', "env X=1 codex 'hi'", 'llmws-codex-mail-abc')).toBeNull();
    expect(calls[0]).toEqual(expect.arrayContaining(['new-session', "env X=1 codex 'hi'"]));
    const failing = createFleetDriver({ exec: () => ({ ok: false as const, error: 'no server' }), panePid: () => null });
    expect(failing.open('codex', '/p', 'codex', 'llmws-codex-mail-abc')).toMatch(/no server/);
  });

  it('reports a missing transcript as size 0', () => {
    const driver = createFleetDriver({});
    expect(driver.size(join(mkdtempSync(join(tmpdir(), 'mail-d-')), 'none.jsonl'))).toBe(0);
  });
});

describe('live pane pids for the mail badges', () => {
  // The badge read runs every few seconds over every recent loop, and a
  // reviewer session is gone once its loop ends. Asking tmux about each gone
  // one printed "can't find session" to the dev pane on every read.
  it('lists sessions once and asks for a pane only on live ones', () => {
    const calls: string[][] = [];
    const exec = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'list-sessions') return { ok: true as const, stdout: 'llmws-codex-mail-live\nworkspace-app\n' };
      return { ok: true as const, stdout: '4242\n' };
    };
    const pidOf = livePanePids(exec);
    expect(pidOf('llmws-codex-mail-live')).toBe(4242);
    expect(pidOf('llmws-codex-mail-gone')).toBeNull();
    expect(pidOf('llmws-claude-gone')).toBeNull();
    expect(calls).toEqual([
      ['list-sessions', '-F', '#{session_name}'],
      ['list-panes', '-t', '=llmws-codex-mail-live:', '-F', '#{pane_pid}'],
    ]);
  });

  it('reads no tmux server as no live sessions', () => {
    const calls: string[][] = [];
    const pidOf = livePanePids(args => { calls.push(args); return { ok: false as const, error: 'no server running' }; });
    expect(pidOf('llmws-codex-mail-live')).toBeNull();
    expect(calls).toEqual([['list-sessions', '-F', '#{session_name}']]);
  });
});
