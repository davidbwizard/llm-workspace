import type { Provider } from '../core/types.ts';
import type { Mode } from '../core/mode.ts';

/** Pure screen reader for the permission mode. Spec: docs/superpowers/specs/
 *  2026-09-21-mode-switcher-design.md §3 and §5.
 *
 *  Takes the pane text from `capturePane` and says which mode the pane is
 *  reporting -- or nothing at all. §5's rule governs everything here: a mode
 *  this reader cannot identify is reported as unknown, and the chip then
 *  shows nothing rather than a guess. Claiming "Manual" on a session that is
 *  actually on Auto is the worst failure this feature has.
 *
 *  Everything below was measured 2026-09-21 against live throwaway panes
 *  (Claude Code v2.1.278, codex-cli 0.154.0). The fixtures those captures
 *  became are in tests/fixtures/modes/. */

export type ModeUnreadable = 'no_footer_on_screen' | 'unrecognised_mode';
export type ModeScreenRead = { mode: Mode } | { mode: null; why: ModeUnreadable };

/** How many non-blank lines up from the bottom the footer is looked for.
 *
 *  Not just the last one, and this is measured rather than defensive: on a
 *  48-column pane Claude Code wraps the footer's right-hand notice
 *  ("◉ xhigh · /effort") onto its OWN line BELOW the mode line, so the
 *  mode footer is not the last non-blank line of the capture
 *  (tests/fixtures/modes/claude-narrow-auto-wrapped.txt). Three lines
 *  covers that with room to spare.
 *
 *  Bounded, and scanned from the BOTTOM up, for one reason: an agent's own
 *  transcript can contain a line shaped like a footer -- this very design
 *  document quotes one -- and the real footer is always below any such line.
 *  Scanning up from the bottom finds the real one first, and stopping after
 *  three lines means a quoted footer scrolled up in the transcript cannot be
 *  picked up when there is no real footer on screen at all. */
const FOOTER_SCAN_LINES = 3;

/** Claude's footer: a leading glyph, the mode name, then the word "on".
 *
 *  The NAME is what is matched, and nothing else, for two measured reasons
 *  (§3.1):
 *  - `manual mode on` prints WITHOUT the `(shift+tab to cycle)` hint the
 *    other three carry, so keying on the hint would read three of the four.
 *  - The glyph splits the four states into PAIRS, not four: `auto` and
 *    `accept edits` show ⏵⏵, `manual` and `plan` show ⏸. The glyph is
 *    required here only as an anchor proving this line is the footer; it is
 *    never consulted for WHICH mode, and the pairing is deliberately not
 *    validated, so a future glyph change degrades to "unknown" rather than
 *    to a wrong answer.
 *
 *  The name is captured non-greedily and looked up in CLAUDE_MODE_BY_NAME
 *  below, rather than being spelled out in this pattern, so a name this app
 *  does not know reads as `unrecognised_mode` instead of silently looking
 *  like "no footer". */
const CLAUDE_FOOTER = /^(?:⏵⏵|⏸)\s+(.+?)\s+on(?:\s|$)/;

const CLAUDE_MODE_BY_NAME: Record<string, Mode> = {
  'auto mode': 'auto',
  'manual mode': 'manual',
  'accept edits': 'acceptEdits',
  'plan mode': 'plan',
};

/** Codex's footer: the model and its reasoning effort, " · ", then the
 *  working directory -- `gpt-5.6-sol xhigh fast · /private/tmp/...` or
 *  `gpt-5.6-sol medium fast · ~/.llmws-modeprobe` (both measured; the
 *  directory renders absolute or ~-abbreviated, never relative).
 *
 *  The anchor is the separator followed by a path, NOT the model or the
 *  effort word: the Plan switch CHANGES the effort (xhigh -> medium and
 *  back, §3.2), so a reader keyed on it would disagree with itself across
 *  the very switch it exists to confirm. It is also what keeps this reader
 *  off Claude's footer, whose own " · " is followed by "? for shortcuts" or
 *  "← 3 agents", never by a path. */
const CODEX_FOOTER = /^[^·]+ · (?:\/|~\/)/;

/** Codex's Plan label, right-aligned at the end of the footer.
 *
 *  Measured both ways: on a wide pane it reads `Plan mode (shift+tab to
 *  cycle)`, and on a narrow one Codex truncates the PATH to make room and
 *  drops the hint, leaving `Plan mode` with a single space before it. So the
 *  name is matched and the hint is optional -- the same rule §3.1 states for
 *  Claude's own footer.
 *
 *  IMPORTANT, and it is a property of what Codex prints rather than a
 *  shortcut taken here: in Default mode the footer carries NO label at all.
 *  Default is therefore read as "the footer is on screen and it does not say
 *  Plan". That is exact for 0.154.0, where Shift+Tab reaches exactly two
 *  states (measured: six presses, three round trips), but it does mean a
 *  THIRD state introduced by a future Codex, labelled some other way, would
 *  read as Default rather than as unknown. The accepted residual is a
 *  working directory whose own last characters are "Plan mode". */
const CODEX_PLAN_LABEL = /(?:^|\s)Plan mode(?: \(shift\+tab to cycle\))?$/;

/** The last FOOTER_SCAN_LINES non-blank lines, bottom first. */
function candidateLines(capture: string): string[] {
  const lines: string[] = [];
  const all = capture.split('\n');
  for (let i = all.length - 1; i >= 0 && lines.length < FOOTER_SCAN_LINES; i--) {
    const line = (all[i] ?? '').trim();
    if (line !== '') lines.push(line);
  }
  return lines;
}

function readClaude(lines: string[]): ModeScreenRead {
  for (const line of lines) {
    const m = CLAUDE_FOOTER.exec(line);
    if (!m) continue;
    const mode = CLAUDE_MODE_BY_NAME[m[1] ?? ''];
    // A footer whose shape is right but whose name is not one of the four:
    // stop here rather than keep scanning up. This IS the footer, and the
    // honest answer about it is that this app does not know the mode --
    // continuing would risk answering from a stale line above it.
    return mode ? { mode } : { mode: null, why: 'unrecognised_mode' };
  }
  return { mode: null, why: 'no_footer_on_screen' };
}

function readCodex(lines: string[]): ModeScreenRead {
  for (const line of lines) {
    if (!CODEX_FOOTER.test(line)) continue;
    return { mode: CODEX_PLAN_LABEL.test(line) ? 'plan' : 'default' };
  }
  return { mode: null, why: 'no_footer_on_screen' };
}

export function readModeScreen(capture: string, provider: Provider): ModeScreenRead {
  const lines = candidateLines(capture);
  return provider === 'claude' ? readClaude(lines) : readCodex(lines);
}
