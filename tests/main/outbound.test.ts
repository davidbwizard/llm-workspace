import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, MAX_REPLY_CHARS } from '../../src/main/outbound.ts';

describe('sanitizeOutbound', () => {
  it('passes ordinary prose through unchanged', () => {
    expect(sanitizeOutbound('yes, commit it')).toEqual({ ok: true, text: 'yes, commit it' });
  });

  it('strips C0 controls, including ESC', () => {
    const r = sanitizeOutbound('a\x1bb\x03c\x07d');
    expect(r).toEqual({ ok: true, text: 'abcd' });
  });

  it('strips C1 controls', () => {
    expect(sanitizeOutbound('a\x85b\x9bc')).toEqual({ ok: true, text: 'abc' });
  });

  it('refuses embedded newlines rather than silently submitting twice', () => {
    expect(sanitizeOutbound('line one\nline two')).toEqual({ ok: false, reason: 'contains_newline' });
    expect(sanitizeOutbound('line one\r\nline two')).toEqual({ ok: false, reason: 'contains_newline' });
  });

  it('refuses text over the cap', () => {
    expect(sanitizeOutbound('x'.repeat(MAX_REPLY_CHARS + 1))).toEqual({ ok: false, reason: 'too_long' });
    expect(sanitizeOutbound('x'.repeat(MAX_REPLY_CHARS)).ok).toBe(true);
  });

  it('refuses anything that is not a string, and anything empty after stripping', () => {
    expect(sanitizeOutbound(42)).toEqual({ ok: false, reason: 'empty' });
    expect(sanitizeOutbound(null)).toEqual({ ok: false, reason: 'empty' });
    expect(sanitizeOutbound('\x1b\x03')).toEqual({ ok: false, reason: 'empty' });
  });

  it('leaves tab alone -- it is ordinary typed input, not a control action', () => {
    expect(sanitizeOutbound('a\tb')).toEqual({ ok: true, text: 'a\tb' });
  });

  // The refusal above is load-bearing for the KEYSTROKE path and stays the
  // default: `send-keys -l` types the text, and a newline submits early, so
  // a two-line message would send its first line and run the rest as a
  // second prompt. The allowance below exists for one caller -- the
  // bracketed-paste path in sendKeysFor -- and is opt-in, so no existing
  // call site changes behaviour.
  it('allows newlines only when the caller opts in', () => {
    expect(sanitizeOutbound('line one\nline two')).toEqual({ ok: false, reason: 'contains_newline' });
    expect(sanitizeOutbound('line one\nline two', { multiline: true }))
      .toEqual({ ok: true, text: 'line one\nline two' });
  });

  it('normalises CRLF and CR to LF on the multiline path, so one convention reaches tmux', () => {
    expect(sanitizeOutbound('a\r\nb\rc', { multiline: true })).toEqual({ ok: true, text: 'a\nb\nc' });
  });

  it('still strips every other control character on the multiline path', () => {
    expect(sanitizeOutbound('a\x1bb\nc\x03d', { multiline: true })).toEqual({ ok: true, text: 'ab\ncd' });
  });

  it('still caps the multiline path at MAX_REPLY_CHARS', () => {
    const long = `${'x'.repeat(MAX_REPLY_CHARS)}\ny`;
    expect(sanitizeOutbound(long, { multiline: true })).toEqual({ ok: false, reason: 'too_long' });
  });

  it('refuses a multiline message that is nothing but line breaks', () => {
    expect(sanitizeOutbound('\n\n\n', { multiline: true })).toEqual({ ok: false, reason: 'empty' });
  });

  // DO NOT DELETE OR RELAX THIS, and do not relax the control stripping it
  // guards. The stripping above looks like ordinary hygiene, but it is what
  // makes the whole bracketed-paste path SAFE, and the two live in
  // different files (the paste is built in src/main/ipc.ts's sendKeysFor).
  //
  // sendKeysFor delivers multi-line text by pasting it between
  // bracketed-paste markers. The receiving program treats everything up to
  // the END marker as inert pasted text. That is the entire security
  // argument for allowing newlines on that path -- and it holds only
  // because a message cannot contain the end marker itself. ESC (\x1b) and
  // the 8-bit CSI (\x9b) are the only ways to write one, and both are
  // stripped here. Without this, a message body containing ESC [ 2 0 1 ~
  // would close the paste early and everything after it would arrive as
  // live keystrokes in the user's session.
  it('strips the escape bytes a message would need to close its own bracketed paste', () => {
    // The 7-bit end marker, ESC [ 2 0 1 ~ -- ESC gone, so what remains is
    // inert printable text that cannot terminate anything.
    expect(sanitizeOutbound('one\x1b[201~two', { multiline: true }))
      .toEqual({ ok: true, text: 'one[201~two' });
    // The 8-bit CSI form of the same marker.
    expect(sanitizeOutbound('one\x9b201~two', { multiline: true }))
      .toEqual({ ok: true, text: 'one201~two' });
    // And the start marker, which would otherwise let a message open a
    // nested paste the receiving program never agreed to.
    expect(sanitizeOutbound('one\x1b[200~two', { multiline: true }))
      .toEqual({ ok: true, text: 'one[200~two' });
    // No ESC or CSI byte survives on either path, whatever surrounds it.
    for (const raw of ['a\x1bb', 'a\x9bb']) {
      const r = sanitizeOutbound(raw, { multiline: true });
      expect(r.ok && /[\x1b\x9b]/.test(r.text)).toBe(false);
    }
  });
});
