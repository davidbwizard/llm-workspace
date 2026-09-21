import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The chip's stylesheet, ported from the approved mockup (Permission Mode
 *  Switcher, 2026-09-21, layout C).
 *
 *  These assertions cover exactly what a file test can: that the values
 *  came from the app's own tokens rather than hard-coded colours, and that
 *  the four colour slots §2 names are the four the mockup used. They do
 *  NOT prove the chip looks right -- jsdom computes no layout and renders
 *  no colour -- so the look still needs a pair of eyes in the running app.
 *  Same limitation, same treatment, as ContextChip.css.test.ts. */

const CSS_PATH = 'src/renderer/components/ModeChip.css';
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('ModeChip.css: theme tokens only', () => {
  it('declares every colour through var(--token), never a literal hex or rgb', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/i);
  });

  // §2: neutral --muted for the ask-first mode, --accent for edits,
  // --ag-purple for plan/read-only, --critical for the unrestricted one.
  it.each([
    ['manual', '--muted'],
    ['edits', '--accent'],
    ['plan', '--ag-purple'],
    ['auto', '--critical'],
  ])('gives the %s slot var(%s)', (slot, token) => {
    expect(css).toMatch(new RegExp(`\\.modechip\\[data-mode="${slot}"\\][^}]*--m:\\s*var\\(${token}\\)`));
    expect(css).toMatch(new RegExp(`\\.modemenu button i\\[data-tone="${slot}"\\][^}]*background:\\s*var\\(${token}\\)`));
  });
});

describe('ModeChip.css: the mockup\'s own rules', () => {
  // The values David approved, not re-derived from the picture.
  it('keeps the chip a pill in the mode\'s own colour', () => {
    expect(css).toMatch(/\.modechip > button\s*\{[^}]*border-radius:\s*999px/);
    expect(css).toMatch(/\.modechip > button\s*\{[^}]*color:\s*var\(--m\)/);
    expect(css).toMatch(/\.modechip > button\s*\{[^}]*background:\s*var\(--m-soft\)/);
    expect(css).toMatch(/\.modechip \.dot\s*\{[^}]*background:\s*var\(--m\)/);
  });

  // Layout C: the chip is in the composer's foot, so the menu opens
  // upward. A menu that opened downward from there would be off-screen.
  it('opens the menu upward from the chip', () => {
    expect(css).toMatch(/\.modemenu\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.modemenu\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\)/);
    expect(css).not.toMatch(/\.modemenu\s*\{[^}]*\btop:/);
  });

  it('lifts the menu off the pane with the shared pop shadow', () => {
    expect(css).toMatch(/\.modemenu\s*\{[^}]*box-shadow:\s*var\(--shadow-pop\)/);
    expect(css).toMatch(/\.modemenu\s*\{[^}]*background:\s*var\(--surface\)/);
  });

  it('marks the current row the way the mockup does', () => {
    expect(css).toMatch(/\.modemenu button\[aria-checked="true"\]\s*\{[^}]*background:\s*var\(--raised\)/);
    expect(css).toMatch(/\.modemenu button\[aria-checked="true"\]\s*\{[^}]*font-weight:\s*600/);
  });

  // This window runs under a CSP with no 'unsafe-inline', so the mockup's
  // inline `style="background:..."` on each menu dot had to become a
  // class. If that ever regresses to an inline style the dots silently
  // lose their colour, which is exactly what the assertion above about
  // i[data-tone] is protecting.
  it('has a colourless slot for the Permissions row, which is not a mode', () => {
    expect(css).toMatch(/\.modemenu button i\[data-tone="none"\]\s*\{[^}]*background:\s*none/);
  });
});

describe('ConversationView.css: the composer foot the chip sits in', () => {
  const conv = readFileSync('src/renderer/components/ConversationView.css', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('is a row under the message box', () => {
    expect(conv).toMatch(/\.convfoot\s*\{[^}]*display:\s*flex/);
    expect(conv).toMatch(/\.convfoot\s*\{[^}]*align-items:\s*center/);
  });

  // The chip draws nothing for an unknown mode or a session this app did
  // not launch, and an empty flex row would still claim its own margin --
  // the composer would gain a gap for no visible reason.
  it('collapses to nothing when the chip drew nothing', () => {
    expect(conv).toMatch(/\.convfoot:empty\s*\{[^}]*display:\s*none/);
  });

  // --signal, not --critical: --critical is this app's "waiting on you"
  // colour (OpenSessionCard.css) and must stay unambiguous.
  it('shows a failed switch in --signal, not --critical', () => {
    expect(css).toMatch(/\.modemsg\s*\{[^}]*color:\s*var\(--signal\)/);
    expect(css).not.toMatch(/\.modemsg\s*\{[^}]*color:\s*var\(--critical\)/);
  });
});
