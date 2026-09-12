import { describe, it, expect } from 'vitest';
import {
  sendLiteral, sendKeyName, hasSession, capturePane, pipePane, TMUX_NAME, type KeyName,
} from '../../src/main/tmux.ts';

function spy() {
  const calls: string[][] = [];
  return { calls, exec: (args: string[]) => { calls.push(args); return { ok: true as const, stdout: '' }; } };
}

describe('tmux argv construction', () => {
  it('sends message text with -l, as its own argv element', () => {
    const s = spy();
    sendLiteral('llmws-claude-abc', 'C-c', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', 'C-c']);
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
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', 'Enter']);
  });

  // The `KeyName` union stops this at compile time; this test proves the
  // allowlist ALSO holds at runtime, for a caller reached through a
  // boundary (e.g. IPC) that has already widened the type back to string.
  it('refuses a key name outside the allowlist, even past the type', () => {
    const s = spy();
    // Cast deliberately: the KeyName union stops this at compile time for a
    // typed caller, so proving the runtime guard requires bypassing it, the
    // way a value arriving through an `unknown`-typed IPC boundary would.
    expect(() => sendKeyName('llmws-claude-abc', 'Escape' as unknown as KeyName, s.exec)).toThrow();
    expect(s.calls).toHaveLength(0);
  });

  // Exact expected form, not just a startsWith('=') prefix check -- the
  // weaker check would have passed on a bare '=name' too, which is exactly
  // what shipped and then failed "can't find pane" against a real tmux
  // server for every target-PANE command (send-keys, capture-pane,
  // pipe-pane). Verified live: the ':' is required, not decorative.
  it('targets exactly, never by prefix, with the trailing : a real tmux server requires', () => {
    const s = spy();
    hasSession('llmws-claude-abc', s.exec);
    capturePane('llmws-claude-abc', 2000, s.exec);
    for (const c of s.calls) {
      const t = c[c.indexOf('-t') + 1]!;
      expect(t).toBe('=llmws-claude-abc:');
    }
  });

  it('rejects a name that is not ours', () => {
    expect(TMUX_NAME.test('llmws-claude-abc123')).toBe(true);
    expect(TMUX_NAME.test('other-session')).toBe(false);
    expect(TMUX_NAME.test('llmws-claude-a;rm -rf /')).toBe(false);
    expect(TMUX_NAME.test('llmws-claude-a:0.1')).toBe(false);
  });
});

describe('pipePane', () => {
  it('starts piping with -O, targeting =name, the command as its own argv element', () => {
    const s = spy();
    pipePane('llmws-claude-abc', 'cat >> /tmp/x.fifo', s.exec);
    expect(s.calls[0]).toEqual(['pipe-pane', '-O', '-t', '=llmws-claude-abc:', 'cat >> /tmp/x.fifo']);
  });

  it('stops piping when called with no command', () => {
    const s = spy();
    pipePane('llmws-claude-abc', undefined, s.exec);
    expect(s.calls[0]).toEqual(['pipe-pane', '-t', '=llmws-claude-abc:']);
  });

  it('refuses a name this app did not generate', () => {
    expect(() => pipePane('not-ours', undefined)).toThrow();
    expect(() => pipePane('not-ours', 'cat')).toThrow();
  });
});
