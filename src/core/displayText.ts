// Pure text normalization shared by IPC display fields and renderer read receipts.

// Matches a complete CSI sequence: ESC '[', then parameter bytes (0x30-0x3F),
// then intermediate bytes (0x20-0x2F), then one final byte (0x40-0x7E).
// Covers cursor moves and erase-line/erase-display among others.
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Matches a complete OSC sequence: ESC ']', any bytes, terminated by either
// BEL (the classic terminator) or ST (ESC '\', the more "correct" one).
// Covers window-title (OSC 0/2) and clipboard-write (OSC 52) among others.
const OSC_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// C0 controls (0x00-0x1F, including any ESC that survived the two regexes
// above -- e.g. a truncated sequence with no terminator at all) and DEL
// (0x7F). `stream` prints one line per event, so an embedded newline or tab
// is itself unwanted -- none of these are kept.
const C0_AND_DEL = /[\x00-\x1f\x7f]/g;
// C1 controls (0x80-0x9F) -- the 8-bit single-byte equivalents of ESC-prefixed
// sequences (e.g. 0x9B is an alternate encoding of CSI).
const C1_CONTROLS = /[\x80-\x9f]/g;

/** Strip control characters and terminal escape sequences from untrusted
 *  provider text before it reaches a terminal (or, later, a UI that renders
 *  it raw). Transcript text embeds raw tool output -- literal file contents,
 *  command output, anything a tool returned -- so a crafted file read by an
 *  agent can carry a CSI erase-line, an OSC clipboard write or title
 *  set, or a deliberately truncated escape sequence meant to leave the
 *  terminal in a pending state. Order matters: complete CSI/OSC sequences
 *  are removed first, while their leading ESC is still there to anchor the
 *  match; only what's left over (including any ESC that was never part of
 *  a complete sequence) is caught by the blanket C0/DEL/C1 strip. */
export function sanitizeForTerminal(s: string): string {
  return s
    .replace(CSI_SEQUENCE, '')
    .replace(OSC_SEQUENCE, '')
    .replace(C0_AND_DEL, '')
    .replace(C1_CONTROLS, '');
}

// Unicode bidirectional overrides (U+202A-U+202E: LRE, RLE, PDF, LRO, RLO)
// and isolates (U+2066-U+2069: LRI, RLI, FSI, PDI) -- e.g. U+202E
// RIGHT-TO-LEFT OVERRIDE, the classic filename-spoofing trick. Their effect
// is UNBOUNDED -- each re-orders how every character after it is DISPLAYED,
// until a matching pop or the end of the string, without changing the text
// itself. Inert in a terminal -- sanitizeForTerminal never touches them --
// but not in a renderer, so what the user reads can differ from what the
// agent actually wrote. This is the Trojan Source set.
//
// Written as \u escapes, deliberately -- not as the literal characters. An
// earlier version of this file used the literal characters, which made the
// set unreviewable (nobody can tell U+200B from U+200C by looking at a
// blank space) and, worse, made this file itself a Trojan Source vector:
// an unterminated LRE/RLO with no matching PDF reorders how the REST of
// the file displays in an editor, diff viewer or review tool. Do not
// "tidy" these back into literal characters.
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/g;
// Zero-width, no script role: zero-width space, word joiner, and the
// byte-order mark. Deliberately NOT included here: ZWNJ/ZWJ (U+200C/U+200D)
// are load-bearing for Persian, Arabic and Indic scripts (ZWNJ) and for
// emoji sequences (ZWJ) -- stripping them silently corrupts correct text,
// which is worse than leaving them, since it happens on honest content
// every day rather than only under attack. LRM/RLM (U+200E/U+200F) are
// also excluded: unlike the override/isolate set above, they only bias
// adjacent neutral characters, not an unbounded span, so they cannot
// reorder arbitrary following text the way BIDI_CONTROL's set can.
//
// Written as \u escapes for the same reason as BIDI_CONTROL above.
const ZERO_WIDTH_FORMATTING = /[\u200b\u2060\ufeff]/g;

/** sanitizeForTerminal (src/config.ts) strips terminal escape sequences and
 *  control characters -- correct for the terminal it was written for. It
 *  does not touch bidi overrides or zero-width formatting characters,
 *  because neither does anything on a terminal. Both do something on a
 *  renderer: this app exists to show faithfully what an agent said, so
 *  display integrity is the product, and provider text can quote arbitrary
 *  file content -- a realistic way such characters arrive. */
export function sanitizeForDisplay(s: string): string {
  return sanitizeForTerminal(s).replace(BIDI_CONTROL, '').replace(ZERO_WIDTH_FORMATTING, '');
}

