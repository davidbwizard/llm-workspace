import { describe, it, expect } from 'vitest';
import { sendLiteral, sendKeyName, hasSession, capturePane, TMUX_NAME } from '../../src/main/tmux.ts';

function spy() {
  const calls: string[][] = [];
  return { calls, exec: (args: string[]) => { calls.push(args); return { ok: true as const, stdout: '' }; } };
}

describe('tmux argv construction', () => {
  it('sends message text with -l, as its own argv element', () => {
    const s = spy();
    sendLiteral('llmws-claude-abc', 'C-c', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc', '-l', 'C-c']);
  });

  it('never concatenates text with a following Enter', () => {
    const s = spy();
    sendLiteral('llmws-claude-abc', 'hello', s.exec);
    for (const arg of s.calls[0]!) expect(arg).not.toMatch(/hello.*Enter/);
    expect(s.calls).toHaveLength(1);
  });

  it('sends a key name without -l, in its own call', () => {
    const s = spy();
    sendKeyName('llmws-claude-abc', 'Enter', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc', 'Enter']);
  });

  it('targets exactly, never by prefix', () => {
    const s = spy();
    hasSession('llmws-claude-abc', s.exec);
    capturePane('llmws-claude-abc', 2000, s.exec);
    for (const c of s.calls) {
      const t = c[c.indexOf('-t') + 1]!;
      expect(t.startsWith('=')).toBe(true);
    }
  });

  it('rejects a name that is not ours', () => {
    expect(TMUX_NAME.test('llmws-claude-abc123')).toBe(true);
    expect(TMUX_NAME.test('other-session')).toBe(false);
    expect(TMUX_NAME.test('llmws-claude-a;rm -rf /')).toBe(false);
    expect(TMUX_NAME.test('llmws-claude-a:0.1')).toBe(false);
  });
});
