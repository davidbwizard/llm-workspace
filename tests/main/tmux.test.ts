import { describe, it, expect } from 'vitest';
import {
  sendLiteral, sendKeyName, hasSession, capturePane, pipePane, paneSize, TMUX_NAME,
  listSessionNames, type KeyName,
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

  // `lines: null` must omit -S entirely rather than pass some sentinel
  // range, since -S is what makes tmux walk back through scrollback in the
  // first place.
  it('omits -S entirely when capturePane is asked for the visible pane only', () => {
    const s = spy();
    capturePane('llmws-claude-abc', null, s.exec);
    expect(s.calls[0]).toEqual(['capture-pane', '-p', '-t', '=llmws-claude-abc:']);
  });

  it('still passes -S -<lines> when a line count is given', () => {
    const s = spy();
    capturePane('llmws-claude-abc', 2000, s.exec);
    expect(s.calls[0]).toEqual(['capture-pane', '-p', '-S', '-2000', '-t', '=llmws-claude-abc:']);
  });
});

describe('paneSize', () => {
  it('queries both dimensions in a single display-message call, against the exact target', () => {
    const s = spy();
    paneSize('llmws-claude-abc', s.exec);
    expect(s.calls[0]).toEqual([
      'display-message', '-p', '-t', '=llmws-claude-abc:', '#{pane_width}x#{pane_height}',
    ]);
  });

  it('parses the WxH reply into numbers', () => {
    expect(paneSize('llmws-claude-abc', () => ({ ok: true, stdout: '126x40\n' })))
      .toEqual({ cols: 126, rows: 40 });
  });

  // A failed query or a reply that doesn't match WxH must read as null, not
  // a guessed size.
  it('reads a failed or unparseable query as null, not a thrown error or a guess', () => {
    expect(paneSize('llmws-claude-abc', () => ({ ok: false, error: 'no such pane' }))).toBeNull();
    expect(paneSize('llmws-claude-abc', () => ({ ok: true, stdout: 'garbage\n' }))).toBeNull();
  });

  it('refuses a name this app did not generate', () => {
    expect(() => paneSize('not-ours')).toThrow();
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

// Bug 3: adoptRunningSessions (src/main/sessions.ts) rebuilds the pid
// registry from the whole tmux server, so this lists every session name --
// no -t target, and therefore nothing to guard() against, unlike every
// other function above.
describe('listSessionNames', () => {
  it('asks for session names alone, with no target', () => {
    const s = spy();
    listSessionNames(s.exec);
    expect(s.calls[0]).toEqual(['list-sessions', '-F', '#{session_name}']);
  });

  it('splits multiple sessions, one per line, dropping any blank trailing line', () => {
    const names = listSessionNames(() => ({ ok: true, stdout: 'llmws-claude-a\nother-session\n' }));
    expect(names).toEqual(['llmws-claude-a', 'other-session']);
  });

  // No server running at all (nothing has ever opened a terminal on this
  // machine) is the ordinary case this must not treat as an error --
  // "nothing to adopt", not a thrown exception or a caller-visible failure.
  it('returns an empty array, not an error, when tmux has no server running', () => {
    expect(listSessionNames(() => ({ ok: false, error: 'no server running on ...' }))).toEqual([]);
  });
});
