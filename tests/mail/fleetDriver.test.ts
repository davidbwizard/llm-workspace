import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetDriver } from '../../src/mail/fleetDriver.ts';

const recorder = (inMode: '0' | '1') => {
  const calls: string[][] = [];
  const exec = (args: string[]) => {
    calls.push(args);
    return { ok: true as const, stdout: args.includes('#{pane_in_mode}') ? `${inMode}\n` : '' };
  };
  return { calls, exec };
};

describe('fleet session driver', () => {
  it('leaves scroll mode before typing, then presses Enter', () => {
    const { calls, exec } = recorder('1');
    expect(createFleetDriver({ exec }).typeLine('llmws-codex-mail-abc', 'Pass 2: read /x and do what it says.')).toBeNull();
    expect(calls.map(a => a.join(' '))).toEqual([
      'display-message -p -t =llmws-codex-mail-abc: #{pane_in_mode}',
      'send-keys -t =llmws-codex-mail-abc: -X cancel',
      'send-keys -t =llmws-codex-mail-abc: -l -- Pass 2: read /x and do what it says.',
      'send-keys -t =llmws-codex-mail-abc: Enter',
    ]);
  });

  it('types straight in when the pane is not scrolled', () => {
    const { calls, exec } = recorder('0');
    createFleetDriver({ exec }).typeLine('llmws-codex-mail-abc', 'hi');
    expect(calls.some(a => a.includes('-X'))).toBe(false);
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
