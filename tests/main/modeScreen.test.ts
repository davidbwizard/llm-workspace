import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readModeScreen } from '../../src/main/modeScreen.ts';
import type { Mode } from '../../src/core/mode.ts';

/** The mode detector, against real captures. Spec §5: "a check that matches
 *  on every mode proves nothing" -- so the point of this file is not that
 *  each fixture matches, it is that the reader returns a DIFFERENT answer
 *  for each mode of each provider, and NOTHING for a screen it cannot
 *  identify.
 *
 *  Every fixture in tests/fixtures/modes/ is a real `tmux capture-pane -p`
 *  of a throwaway pane taken 2026-09-21 (Claude Code v2.1.278, codex-cli
 *  0.154.0), redacted the same way the quick-answers screens are. */

const modes = (f: string) => readFileSync(`tests/fixtures/modes/${f}`, 'utf8');
const screens = (f: string) => readFileSync(`tests/fixtures/quick-answers/screens/${f}`, 'utf8');

const CLAUDE_FIXTURES: [string, Mode][] = [
  ['claude-auto.txt', 'auto'],
  ['claude-manual.txt', 'manual'],
  ['claude-accept-edits.txt', 'acceptEdits'],
  ['claude-plan.txt', 'plan'],
];

const CODEX_FIXTURES: [string, Mode][] = [
  ['codex-default.txt', 'default'],
  ['codex-plan.txt', 'plan'],
];

describe('readModeScreen: one fixture per mode per provider', () => {
  it.each(CLAUDE_FIXTURES)('reads %s as %s', (file, mode) => {
    expect(readModeScreen(modes(file), 'claude')).toEqual({ mode });
  });

  it.each(CODEX_FIXTURES)('reads %s as %s', (file, mode) => {
    expect(readModeScreen(modes(file), 'codex')).toEqual({ mode });
  });

  // The separation claim itself, stated as an assertion rather than left
  // implicit in four passing cases above: four real captures, four
  // different answers, no duplicates.
  it('separates Claude\'s four modes -- four fixtures, four distinct answers', () => {
    const read = CLAUDE_FIXTURES.map(([f]) => readModeScreen(modes(f), 'claude').mode);
    expect(read).toEqual(['auto', 'manual', 'acceptEdits', 'plan']);
    expect(new Set(read).size).toBe(4);
  });

  it('separates Codex\'s two modes -- two fixtures, two distinct answers', () => {
    const read = CODEX_FIXTURES.map(([f]) => readModeScreen(modes(f), 'codex').mode);
    expect(read).toEqual(['default', 'plan']);
    expect(new Set(read).size).toBe(2);
  });
});

describe('readModeScreen: screens it must refuse', () => {
  // A real Codex screen: the "/" command popup REPLACES the footer, so the
  // mode genuinely is not on screen. Measured 2026-09-21.
  it('refuses the Codex slash-command popup, which hides the footer', () => {
    expect(readModeScreen(modes('codex-slash-popup.txt'), 'codex').mode).toBeNull();
  });

  it('refuses a plain shell pane', () => {
    expect(readModeScreen(modes('plain-shell.txt'), 'claude').mode).toBeNull();
    expect(readModeScreen(modes('plain-shell.txt'), 'codex').mode).toBeNull();
  });

  // Claude Code's own trust prompt, before the composer exists at all.
  it('refuses Claude\'s trust prompt', () => {
    expect(readModeScreen(screens('00-trust.txt'), 'claude').mode).toBeNull();
  });

  it('refuses an empty capture', () => {
    expect(readModeScreen('', 'claude').mode).toBeNull();
    expect(readModeScreen('   \n\n  \n', 'codex').mode).toBeNull();
  });

  // A footer shaped exactly like Claude's, carrying a mode name this app
  // does not know: reported as unknown, never rounded to the nearest one.
  it('refuses a Claude footer whose mode name it does not know', () => {
    const read = readModeScreen('⏸ yolo mode on (shift+tab to cycle) · ← 3 agents\n', 'claude');
    expect(read).toEqual({ mode: null, why: 'unrecognised_mode' });
  });
});

describe('readModeScreen: the two providers do not read each other', () => {
  it.each(CLAUDE_FIXTURES)('reads nothing from %s as Codex', (file) => {
    expect(readModeScreen(modes(file), 'codex').mode).toBeNull();
  });

  it.each(CODEX_FIXTURES)('reads nothing from %s as Claude', (file) => {
    expect(readModeScreen(modes(file), 'claude').mode).toBeNull();
  });
});

describe('readModeScreen: the traps this had to survive', () => {
  // THE trap, and it is not hypothetical: a real in-repo capture
  // (quick-answers fixture 03) carries the right-aligned notice "auto mode
  // unavailable for this model" on the SAME line as "manual mode on". A
  // reader that searched the footer for "auto mode" would claim Auto on a
  // session that is actually on Manual -- §5's named worst failure.
  it('reads manual, not auto, when the footer also says "auto mode unavailable for this model"', () => {
    const capture = screens('03-after-trust.txt');
    expect(capture).toContain('auto mode unavailable for this model');
    expect(readModeScreen(capture, 'claude')).toEqual({ mode: 'manual' });
  });

  // Measured: `manual mode on` prints WITHOUT the `(shift+tab to cycle)`
  // hint the other three carry (§3.1). Matching the hint would read three
  // modes and refuse the fourth.
  it('reads manual even though its footer carries no shift+tab hint', () => {
    const capture = modes('claude-manual.txt');
    expect(capture).not.toContain('manual mode on (shift+tab');
    expect(readModeScreen(capture, 'claude')).toEqual({ mode: 'manual' });
  });

  // Measured: the leading glyph splits the four states into PAIRS, not four
  // (auto and accept edits show the double play mark; manual and plan a
  // pause mark). Reading the glyph alone identifies nothing.
  it('does not read the mode from the leading glyph, which only splits the four into pairs', () => {
    expect(modes('claude-auto.txt')).toContain('⏵⏵ auto mode on');
    expect(modes('claude-accept-edits.txt')).toContain('⏵⏵ accept edits on');
    expect(modes('claude-manual.txt')).toContain('⏸ manual mode on');
    expect(modes('claude-plan.txt')).toContain('⏸ plan mode on');
  });

  // Measured on a 48-column pane: the footer's right-hand notice wraps onto
  // its OWN line below the mode line, so the mode footer is NOT the last
  // non-blank line of the capture.
  it('finds the footer when a wrapped notice sits below it', () => {
    const capture = modes('claude-narrow-auto-wrapped.txt');
    const lastNonBlank = capture.split('\n').filter(l => l.trim() !== '').pop();
    expect(lastNonBlank).toContain('/effort');
    expect(lastNonBlank).not.toContain('auto mode on');
    expect(readModeScreen(capture, 'claude')).toEqual({ mode: 'auto' });
  });

  it('reads a narrow pane whose footer is truncated mid-line', () => {
    expect(readModeScreen(modes('claude-narrow-manual.txt'), 'claude')).toEqual({ mode: 'manual' });
  });

  // Codex right-aligns the Plan label and truncates the PATH to make room,
  // so the label itself loses its "(shift+tab to cycle)" hint on a narrow
  // pane and keeps it on a wide one -- the same "match the name, never the
  // hint" rule §3.1 states for Claude.
  it('reads Codex plan with and without the label\'s shift+tab hint', () => {
    expect(modes('codex-plan.txt')).toContain('Plan mode');
    expect(modes('codex-plan.txt')).not.toContain('Plan mode (shift+tab');
    expect(modes('codex-plan-home.txt')).toContain('Plan mode (shift+tab to cycle)');
    expect(readModeScreen(modes('codex-plan.txt'), 'codex')).toEqual({ mode: 'plan' });
    expect(readModeScreen(modes('codex-plan-home.txt'), 'codex')).toEqual({ mode: 'plan' });
  });

  // The Codex footer's left half is the model and its reasoning effort,
  // which the Plan switch itself changes (xhigh -> medium). Keying on it
  // would make the reader disagree with itself across a switch.
  //
  // The case that PROVES the reader is not keyed on it is the fourth
  // fixture: `codex -c model_reasoning_effort=medium`, captured in DEFAULT
  // mode with `medium` in the footer. Without it, "medium means plan" reads
  // both of the two fixtures above correctly and survives the whole suite
  // -- which is exactly the "matches, but does not separate" failure §5
  // warns about, caught here by mutation rather than by argument.
  it('does not key on the Codex model or effort, which the switch itself changes', () => {
    expect(modes('codex-default.txt')).toContain('xhigh');
    expect(modes('codex-plan.txt')).toContain('medium');
    expect(modes('codex-default-medium.txt')).toContain('medium');
    expect(readModeScreen(modes('codex-default.txt'), 'codex')).toEqual({ mode: 'default' });
    expect(readModeScreen(modes('codex-plan.txt'), 'codex')).toEqual({ mode: 'plan' });
    // Same effort word as the plan fixture, opposite mode.
    expect(readModeScreen(modes('codex-default-medium.txt'), 'codex')).toEqual({ mode: 'default' });
  });

  // Every other real Claude capture in the repo that carries a footer, read
  // as a group: a busy pane ("esc to interrupt") still reports its mode,
  // and no capture in the set reads as anything but the mode its own footer
  // names.
  it.each([
    ['20-ask-after-submit.txt', 'manual'],
    ['41-ask3-key5-chat.txt', 'manual'],
    ['51-perm-bash-after-1.txt', 'manual'],
    ['55-perm-bash2-after-no.txt', 'manual'],
    ['70-s2-start.txt', 'manual'],
    ['72-s2-bash-after-2.txt', 'manual'],
    ['74-s2-bash-esc.txt', 'manual'],
    ['76-s2-btab2-footer.txt', 'plan'],
    ['97-ask-one-after-key2.txt', 'manual'],
  ] as [string, Mode][])('reads the quick-answers capture %s as %s', (file, mode) => {
    expect(readModeScreen(screens(file), 'claude')).toEqual({ mode });
  });
});
