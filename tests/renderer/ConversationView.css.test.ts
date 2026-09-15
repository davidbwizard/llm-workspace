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
 *  match inside '.turn.user {' or '.turn .said {'. */
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
  const baseSaid = blockAfter('.turn .said {');
  const userSaid = blockAfter('.turn.user .said {');

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
