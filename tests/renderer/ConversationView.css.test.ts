import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The visual-distinction feature (user vs assistant turns must read apart
// at a glance, and not by colour alone) is CSS-only -- jsdom does not
// compute real layout or paint colour, so there is no way to render a turn
// and observe an actual border width or font weight (the same gap
// SessionRail.css.test.ts and theme.test.ts already work around for this
// codebase). Reading the stylesheet directly and asserting on the
// properties that take effect is that same established technique.
const CSS_PATH = 'src/renderer/components/ConversationView.css';
// Comments are stripped before any assertion runs against real text, not
// text a comment merely happens to quote -- same defect and same fix as
// theme.test.ts and SessionRail.css.test.ts.
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The first `{ ... }` block following `selector`'s first real occurrence.
 *  Assumes no nested braces inside the block, true for every rule in this
 *  file. `selector` includes the trailing `{` so e.g. '.turn {' cannot
 *  match inside '.turn.user {' or '.turn .turn-text {'. */
function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('ConversationView.css: user and assistant turns are visually distinguishable', () => {
  const base = blockAfter('.turn {');
  const user = blockAfter('.turn.user {');
  const baseSaid = blockAfter('.turn .turn-text {');
  const userSaid = blockAfter('.turn.user .turn-text {');

  // The structural cue: a margin rule whose WIDTH (present vs absent), not
  // merely its colour, sets user turns apart -- still visible with colour
  // removed entirely (greyscale, or a colourblind viewer).
  it('gives user turns a margin rule that the shared/assistant rule does not have', () => {
    expect(user).toMatch(/border-left:\s*[1-9]/); // a real, nonzero width
    expect(base).not.toMatch(/border-left/); // absent from the rule assistant turns fall back to
  });

  // The second, independent-of-colour cue: Karla is a variable font
  // (200-800, see the @font-face rule in theme.css), so a heavier
  // font-weight here is a real cut change, not a faked bold.
  it('gives user turns a heavier weight than assistant turns, independent of colour', () => {
    expect(userSaid).toMatch(/font-weight:\s*[5-9]\d\d/); // heavier than normal (400)
    expect(baseSaid).not.toMatch(/font-weight/);
  });

  // Colour layered on TOP of the structural cues above, not instead of
  // them -- this only proves the color rules still exist, never on its own.
  it('backs the structural cues with the app\'s existing ink/ink-2 pair and its one emphasis colour', () => {
    expect(user).toMatch(/var\(--accent\)/);
    expect(userSaid).toMatch(/color:\s*var\(--ink\)\s*;/);
    expect(baseSaid).toMatch(/color:\s*var\(--ink-2\)\s*;/);
  });

  it('uses theme tokens for every colour here, never a hardcoded hex', () => {
    expect(user).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(userSaid).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('ConversationView.css: markdown replies and steps', () => {
  it('turns pre-wrap off for markdown, so newlines between block elements do not become blank lines', () => {
    expect(blockAfter('.turn-text.md {')).toMatch(/white-space:\s*normal/);
  });

  it('styles code blocks with the mono font and theme tokens, scrolling instead of overflowing', () => {
    const pre = blockAfter('.turn-text.md pre {');
    expect(pre).toMatch(/var\(--f-mono\)/);
    expect(pre).toMatch(/background:\s*var\(--/);
    expect(pre).toMatch(/overflow-x:\s*auto/);
  });

  it('styles tables with theme-token borders', () => {
    expect(blockAfter('.turn-text.md th, .turn-text.md td {')).toMatch(/border:\s*1px solid var\(--line\)/);
  });

  it('dims expanded steps relative to the reply', () => {
    expect(blockAfter('.steps-list {')).toMatch(/color:\s*var\(--muted\)/);
  });

  it('uses no hardcoded hex anywhere in the stylesheet', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

// Stylesheets are global in this app. Every message here used class "said",
// which SessionCard.css also styles with a 2-line clamp and overflow:hidden
// -- so every reply longer than two lines was cut off in the real window,
// while jsdom (no layout) passed every test. Guard the class names, since
// the clipping itself cannot be observed here.
describe('ConversationView.css: no class name shared with the card stylesheets', () => {
  const classesIn = (path: string): Set<string> => {
    const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...text.matchAll(/([^{}]+)\{[^}]*\}/g)].map(m => m[1]!).join(' ');
    return new Set([...selectors.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]!));
  };
  const mine = classesIn(CSS_PATH);

  for (const card of ['src/renderer/components/SessionCard.css', 'src/renderer/components/OpenSessionCard.css']) {
    it(`shares no class with ${card}`, () => {
      expect([...classesIn(card)].filter(c => mine.has(c))).toEqual([]);
    });
  }
});
