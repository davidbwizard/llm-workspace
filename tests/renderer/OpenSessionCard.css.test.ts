import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The compact card's message clamp (mid-task requirement from David,
// looking at the real, running window: "compact cards must still show
// some of the message text, clamped to three lines max") is CSS-only --
// jsdom does not compute real layout, so there is no way to render a card
// and observe an actual line wrap or an actual clipped fourth line (the
// same gap SessionRail.css.test.ts and ConversationView.css.test.ts already
// work around for this codebase). Reading the stylesheet directly and
// asserting on the properties that take effect is that same established
// technique. tests/renderer/OpenSessionCard.test.tsx separately proves the
// element itself renders in the compact variant -- that DOM test and this
// CSS test together are what stand in for "the clamp holds in the window";
// neither one alone would catch a real regression here.
const CSS_PATH = 'src/renderer/components/OpenSessionCard.css';
// Comments are stripped before any assertion below runs against real text,
// not text a comment merely happens to quote -- same defect and same fix
// as theme.test.ts, SessionRail.css.test.ts and ConversationView.css.test.ts.
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The first `{ ... }` block following `selector`'s first real occurrence.
 *  Assumes no nested braces inside the block, true for every rule in this
 *  file. `selector` includes the trailing `{` so e.g. '.compact-said {'
 *  cannot match inside '.compact-said.wait {'. */
function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('OpenSessionCard.css: the compact card clamps its message to three lines', () => {
  const rule = blockAfter('.compact-said {');

  it('clamps to exactly three lines', () => {
    expect(rule).toMatch(/-webkit-line-clamp:\s*3\b/);
  });

  // The clamp count alone does nothing without the box-orient/overflow
  // properties that make -webkit-line-clamp take effect at all -- a rule
  // with the count but not these would render every line, uncapped.
  it('actually enforces the clamp, not just naming a line count', () => {
    expect(rule).toMatch(/display:\s*-webkit-box/);
    expect(rule).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  // The regression this whole rule exists to avoid: the conversation pane
  // once reused SessionCard.css's own .said class for this same purpose,
  // which clamps to two lines -- built for the History card, not this one
  // -- and every reply past two lines was silently cut off in the real
  // window while jsdom, which computes no layout, kept passing every test.
  // This file must never define its compact message clamp by touching
  // `.said` at all (bare, or scoped under `.card.compact`) -- only its own,
  // independent `.compact-said`.
  it('never reaches for SessionCard.css\'s .said to get there', () => {
    expect(css).not.toMatch(/\.said\b/);
  });

  it('keeps the blocked-session colour treatment the full card has, on its own class', () => {
    expect(blockAfter('.compact-said.wait {')).toMatch(/color:\s*var\(--critical\)/);
  });
});

// David's own bug report against the real, running window: the card's
// `...` menu opens downward and the NEXT card in the list paints over it
// ("card action bar is hidden below the card"). jsdom computes no layout or
// paint, so it cannot show one element covering another -- see
// OpenSessionCard.test.tsx's own test for the DOM half of this fix (the
// class tracks OpenSessionCard's menuOpen state exactly). This only pins
// that the stylesheet actually gives the raised card a real, explicit
// stacking order, not merely a class that exists and does nothing.
describe('OpenSessionCard.css: a card with its menu open outranks its siblings', () => {
  it('gives the raised card an explicit, non-auto z-index', () => {
    expect(blockAfter('.card.menu-open {')).toMatch(/z-index:\s*\d+/);
  });
});
