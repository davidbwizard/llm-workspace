import { describe, it, expect } from 'vitest';
import {
  sendLiteral, sendKeyName, hasSession, capturePane, pipePane, paneSize, TMUX_NAME,
  listSessionNames, setSessionOption, loadBuffer, pasteBuffer, deleteBuffer, TMUX_BUFFER,
  type KeyName,
} from '../../src/main/tmux.ts';

function spy() {
  const calls: string[][] = [];
  return { calls, exec: (args: string[]) => { calls.push(args); return { ok: true as const, stdout: '' }; } };
}

describe('tmux argv construction', () => {
  it('sends message text with -l, as its own argv element', () => {
    const s = spy();
    sendLiteral('llmws-claude-abc', 'C-c', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', '--', 'C-c']);
  });

  // Verified against a real tmux 3.7c server (2026-09-17): without "--",
  // text starting with "-" is parsed as send-keys options -- "-tNAME ..."
  // retargeted the send to another session. "--" ends option parsing, and
  // the same text then arrived in the pane literally.
  it('ends option parsing before the text, so a leading "-" is never a tmux option', () => {
    const s = spy();
    sendLiteral('llmws-claude-abc', '-t=llmws-claude-other: hi', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', '--', '-t=llmws-claude-other: hi']);
  });

  // Measured on a real tmux 3.7c server (2026-09-17): an argument ending in
  // ";" is a command separator and the ";" is dropped ("hello;" arrived as
  // "hello"); one ending in "\;" arrives with a literal ";" ("c\;" -> "c;",
  // "q\\;" -> "q\;"); nothing before the end is touched ("a;b", "end\").
  // So only a final ";" is rewritten.
  it.each([
    ['hello;', 'hello\\;'],
    [';', '\\;'],
    ['q\\;', 'q\\\\;'],
    ['semi;;', 'semi;\\;'],
    ['a;b', 'a;b'],
    ['end\\', 'end\\'],
    ['a \\; b', 'a \\; b'],
  ])('sends %j so that it arrives exactly (argv %j)', (text, arg) => {
    const s = spy();
    sendLiteral('llmws-claude-abc', text, s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', '--', arg]);
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

  // Tab is the second real caller: sendKeysFor (ipc.ts) sends it in place of
  // Enter to queue a message rather than submit it into a busy Codex turn.
  it('sends Tab without -l, in its own call', () => {
    const s = spy();
    sendKeyName('llmws-codex-abc', 'Tab', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-codex-abc:', 'Tab']);
  });

  // BTab is tmux's name for Shift+Tab -- the third real caller, setModeFor
  // (src/main/mode.ts), which is the only key either CLI moves its
  // permission mode on (mode-switcher design §4).
  it('sends BTab without -l, in its own call', () => {
    const s = spy();
    sendKeyName('llmws-claude-abc', 'BTab', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', 'BTab']);
  });

  // The allowlist gained exactly ONE constant, and it is a constant this
  // app chooses, never one a caller supplies. Every near-miss spelling of
  // Shift+Tab that an IPC caller might try is still refused, which is the
  // property that makes adding a name to the list safe where widening the
  // function to accept caller-supplied names would not be.
  it('allows BTab and still refuses every other spelling of Shift+Tab', () => {
    const s = spy();
    sendKeyName('llmws-claude-abc', 'BTab', s.exec);
    for (const key of ['S-Tab', 'Shift-Tab', 'BTAB', 'btab', 'Backtab', 'BTab Enter']) {
      expect(() => sendKeyName('llmws-claude-abc', key as unknown as KeyName, s.exec)).toThrow();
    }
    expect(s.calls).toHaveLength(1);
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

  // Quick answers (session:answer) needs digits, Down and Right for
  // Claude's prompts -- and nothing else: Escape, Up, 0 and 7 stay refused.
  it('allows the quick-answer keys and still refuses the rest', () => {
    const s = spy();
    for (const key of ['Down', 'Right', '1', '2', '3', '4', '5', '6'] as KeyName[]) {
      sendKeyName('llmws-claude-abc', key, s.exec);
    }
    expect(s.calls.map(c => c[3])).toEqual(['Down', 'Right', '1', '2', '3', '4', '5', '6']);
    for (const key of ['Escape', 'Up', 'Left', '0', '7', 'C-c', 'BSpace']) {
      expect(() => sendKeyName('llmws-claude-abc', key as unknown as KeyName, s.exec)).toThrow();
    }
    expect(s.calls).toHaveLength(8);
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

// BUG 2 (terminal scroll): tmux's own mouse support defaults off, so the
// wheel does nothing once this app attaches a real client. This is the
// per-session fix -- '-t', never '-g' (which would flip the setting for
// every tmux session on the machine, not just ones this app manages).
describe('setSessionOption', () => {
  it('scopes the option to this session alone, with -t, never -g', () => {
    const s = spy();
    setSessionOption('llmws-claude-abc', 'mouse', 'on', s.exec);
    expect(s.calls[0]).toEqual(['set-option', '-t', '=llmws-claude-abc:', 'mouse', 'on']);
  });

  // Mutation target: a '-t' -> '-g' swap must fail this, since that is
  // exactly the difference between a local setting and editing the user's
  // own tmux config for every session on the machine.
  it('never passes -g', () => {
    const s = spy();
    setSessionOption('llmws-claude-abc', 'mouse', 'on', s.exec);
    expect(s.calls[0]).not.toContain('-g');
  });

  it('targets exactly, with the trailing : a real tmux server requires', () => {
    const s = spy();
    setSessionOption('llmws-claude-abc', 'mouse', 'on', s.exec);
    const t = s.calls[0]![s.calls[0]!.indexOf('-t') + 1]!;
    expect(t).toBe('=llmws-claude-abc:');
  });

  it('refuses a name this app did not generate', () => {
    expect(() => setSessionOption('not-ours', 'mouse', 'on')).toThrow();
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

describe('bracketed paste', () => {
  it('loads the text on stdin, never in an argv a ps on this machine could read', () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const exec = (args: string[], input?: string) => { calls.push({ args, input }); return { ok: true as const, stdout: '' }; };
    expect(loadBuffer('llmws-claude-abc', 'llmws-p123-1', 'line one\nline two', exec).ok).toBe(true);
    expect(calls[0]!.args).toEqual(['load-buffer', '-b', 'llmws-p123-1', '-']);
    expect(calls[0]!.input).toBe('line one\nline two');
    expect(calls[0]!.args.join(' ')).not.toContain('line one');
  });

  it('pastes with -p (bracketed) and -d (delete the buffer), at this session\'s pane', () => {
    const calls: string[][] = [];
    const exec = (args: string[]) => { calls.push(args); return { ok: true as const, stdout: '' }; };
    expect(pasteBuffer('llmws-claude-abc', 'llmws-p123-1', exec).ok).toBe(true);
    expect(calls[0]).toEqual(['paste-buffer', '-p', '-d', '-b', 'llmws-p123-1', '-t', '=llmws-claude-abc:']);
  });

  // Cleanup for the paste-failure path. Server-scoped, so it needs no
  // session target -- and it must still be guarded, because the buffer name
  // is the one thing reaching tmux's grammar here.
  it('deletes a buffer by name alone, with no session target', () => {
    const calls: string[][] = [];
    const exec = (args: string[]) => { calls.push(args); return { ok: true as const, stdout: '' }; };
    expect(deleteBuffer('llmws-p123-1', exec).ok).toBe(true);
    expect(calls[0]).toEqual(['delete-buffer', '-b', 'llmws-p123-1']);
  });

  it('refuses a session name this app did not generate, same guard as every other command here', () => {
    expect(() => loadBuffer('someone-elses', 'llmws-p123-1', 'x')).toThrow(/refusing a tmux name/);
    expect(() => pasteBuffer('someone-elses', 'llmws-p123-1')).toThrow(/refusing a tmux name/);
  });

  // The buffer name reaches tmux's own target grammar, so it gets the same
  // treatment the session name does: anchored, and app-generated. Nothing
  // derived from the message text may ever get there. The shape is two
  // fixed literal segments around digits only -- no letters, so nothing
  // resembling a word a caller might pass by mistake fits, and no shell
  // metacharacter, ':' or '.' can appear at all.
  it('refuses a buffer name this app did not generate', () => {
    expect(() => loadBuffer('llmws-claude-abc', 'default', 'x')).toThrow(/refusing a tmux buffer name/);
    expect(() => pasteBuffer('llmws-claude-abc', '../x', )).toThrow(/refusing a tmux buffer name/);
    expect(() => deleteBuffer('llmws-paste; rm -rf ~')).toThrow(/refusing a tmux buffer name/);
    expect(TMUX_BUFFER.test('llmws-p123-1')).toBe(true);
    expect(TMUX_BUFFER.test('llmws-p1-99999')).toBe(true);
    // The old fixed name is no longer a legal buffer name -- a stale caller
    // that still passes it fails loudly rather than sharing one buffer.
    expect(TMUX_BUFFER.test('llmws-paste')).toBe(false);
    expect(TMUX_BUFFER.test('llmws-paste; rm -rf ~')).toBe(false);
    expect(TMUX_BUFFER.test('../x')).toBe(false);
    expect(TMUX_BUFFER.test('default')).toBe(false);
    expect(TMUX_BUFFER.test('llmws-p123-1:0')).toBe(false);
    expect(TMUX_BUFFER.test('llmws-p123-1.0')).toBe(false);
    expect(TMUX_BUFFER.test('llmws-pa-1')).toBe(false);
  });
});
