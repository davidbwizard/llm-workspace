/** Outbound, renderer -> a live process's keyboard. The inverse of
 *  sanitizeForDisplay (src/main/ipc.ts:82), which exists to stop agent text
 *  harming a VIEWER. "Safe to display" is not "safe to type": here the danger
 *  is the receiving program acting on a control byte -- Ctrl-C, Ctrl-D, a bare
 *  ESC a TUI treats as cancel, a bracketed-paste introducer. Never reuse
 *  sanitizeForTerminal for this; it is tuned for the opposite direction. */

export const MAX_REPLY_CHARS = 4000;

export type OutboundRefusal = 'empty' | 'too_long' | 'contains_newline';
export type OutboundResult = { ok: true; text: string } | { ok: false; reason: OutboundRefusal };

// Tab (\t) is deliberately absent -- it is ordinary typed input. Newlines are
// handled separately and explicitly, before stripping, so they refuse loudly
// rather than vanishing.
const C0_EXCEPT_TAB_NEWLINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const C1_CONTROLS = /[\x80-\x9f]/g;
const NEWLINE = /[\r\n]/;

/** A newline typed into a pane submits the current line, so multi-line text
 *  becomes several submissions -- a way to smuggle a second message past what
 *  the UI showed as one reply. Refuse; do not silently collapse. */
export function sanitizeOutbound(raw: unknown): OutboundResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  if (NEWLINE.test(raw)) return { ok: false, reason: 'contains_newline' };
  if (raw.length > MAX_REPLY_CHARS) return { ok: false, reason: 'too_long' };
  const text = raw.replace(C0_EXCEPT_TAB_NEWLINE, '').replace(C1_CONTROLS, '');
  if (text.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, text };
}
