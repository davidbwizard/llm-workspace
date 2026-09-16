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
//
// THESE TWO ARE LOAD-BEARING FOR THE BRACKETED-PASTE PATH, not just hygiene.
// Do not narrow them without reading this.
//
// sendKeysFor (src/main/ipc.ts) delivers multi-line text by pasting it
// between bracketed-paste markers, and the receiving program treats
// everything up to the END marker as inert text. That is the entire reason
// newlines may be allowed on that path -- and it holds only while a message
// cannot write the end marker itself. The marker is ESC [ 2 0 1 ~, and the
// only bytes that can begin one are ESC (\x1b, inside the \x0e-\x1f range
// below) and the 8-bit CSI (\x9b, inside C1). Stop stripping either and a
// message body containing ESC [ 2 0 1 ~ closes the paste early, after which
// its remainder reaches the session as live keystrokes.
//
// Pinned by "strips the escape bytes a message would need to close its own
// bracketed paste" in tests/main/outbound.test.ts.
const C0_EXCEPT_TAB_NEWLINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const C1_CONTROLS = /[\x80-\x9f]/g;
const NEWLINE = /[\r\n]/;

/** A newline typed into a pane submits the current line, so multi-line text
 *  typed with `send-keys -l` becomes several submissions -- a way to smuggle
 *  a second message past what the UI showed as one reply. That is why the
 *  default here refuses rather than silently collapsing, and it stays the
 *  default.
 *
 *  `multiline` is the one opt-in, used by exactly one caller: sendKeysFor's
 *  bracketed-paste path (src/main/ipc.ts), which does not type the text at
 *  all -- tmux loads it into a buffer and pastes it, and Claude Code takes
 *  the embedded newlines as part of one pasted message instead of
 *  submitting on each of them (measured 2026-09-15). Every other rule is
 *  identical on both paths: non-empty, the 4,000 character cap, and
 *  control-character stripping, all applied before the text reaches tmux.
 *
 *  That newline-safety depends on the foreground program having requested
 *  bracketed paste mode (xterm mode 2004); only a program that asked for it
 *  gets told the text is pasted at all. Claude Code was measured doing so
 *  on 2026-09-15. Codex has never been measured on this path -- if it (or
 *  any other foreground program) has not requested mode 2004, tmux's paste
 *  degrades to raw text with the newlines still embedded, and lines 2..n
 *  each run as their own submission, which is the exact failure this
 *  refusal exists to prevent. */
export function sanitizeOutbound(raw: unknown, opts: { multiline?: boolean } = {}): OutboundResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  if (!opts.multiline && NEWLINE.test(raw)) return { ok: false, reason: 'contains_newline' };
  if (raw.length > MAX_REPLY_CHARS) return { ok: false, reason: 'too_long' };
  const stripped = raw.replace(C0_EXCEPT_TAB_NEWLINE, '').replace(C1_CONTROLS, '');
  // One newline convention reaches tmux: a pasted CRLF would otherwise
  // arrive as a stray carriage return inside the buffer.
  const text = opts.multiline ? stripped.replace(/\r\n?/g, '\n') : stripped;
  // A message that is nothing but line breaks has nothing to deliver. On
  // the single-line path this is just the length check it always was.
  if ((opts.multiline ? text.replace(/\n/g, '') : text).length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, text };
}
