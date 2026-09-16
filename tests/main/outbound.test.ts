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
});
