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
});
