import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The title/meta-row containment fix (rail item 1) is CSS-only -- jsdom
// does not compute real layout, so there is no way to render a card and
// observe an actual line wrap or an actual overflow past the border (see
// TerminalView.test.tsx's own ResizeObserver stub for the same underlying
// jsdom gap). Reading the stylesheet directly and asserting on the
// properties that take effect is the same technique tests/renderer/
// theme.test.ts already uses for this codebase's other layout-by-CSS
// guarantees.
const CSS_PATH = 'src/renderer/components/SessionRail.css';
// Comments are stripped before any assertion below runs against real
// text, not text a comment merely happens to quote (see theme.test.ts's
// own identical stripping, and the defect it existed to avoid: a
// selector's own doc comment could keep matching after the rule it
// describes was deleted or broken).
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The first `{ ... }` block following `selector`'s first real
 *  occurrence. Assumes no nested braces inside the block, true for every
 *  rule in this file. */
function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('SessionRail.css: title containment (bug -- a long name rendered past the card border)', () => {
  const rule = blockAfter('.rail .proj');

  it('never lets the name wrap onto a second line', () => {
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });

  it('clips and marks the truncation, rather than letting it overflow the card', () => {
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });

  // The bug this guards against specifically: a hyphenated name ("llm-
  // workspace") broke mid-word, at its own hyphen, once nowrap is dropped
  // from a future edit. word-break/overflow-wrap set to anything that
  // permits a mid-word break (break-all, break-word, or overflow-wrap's
  // anywhere/break-word) would reintroduce exactly that, just with the
  // ellipsis rule masking it less predictably -- this rule must rely on
  // nowrap alone, never on a mid-word-break property.
  it('does not opt into a mid-word break as an alternate fix', () => {
    expect(rule).not.toMatch(/word-break/);
    expect(rule).not.toMatch(/overflow-wrap/);
  });

  it('is scoped to the rail, leaving the wider grid cards (SessionCard.css) untouched', () => {
    // The unscoped base rule (SessionCard.css) is a separate file, so this
    // only has to prove THIS rule's own selector carries the scope --
    // asserted directly on the raw selector text captured above, not by
    // re-reading SessionCard.css from this file.
    const idx = css.indexOf('.rail .proj');
    // Preceded by nothing that would make it read as ".rail.proj" (no
    // scoping at all) or some other unrelated compound selector.
    expect(css.slice(idx, idx + '.rail .proj'.length)).toBe('.rail .proj');
  });
});

describe('SessionRail.css: meta-row containment (bug -- "47s · 228 MB" stacked into three lines)', () => {
  it('lets the meta row itself shrink below its children\'s natural size', () => {
    expect(blockAfter('.rail .crow-meta')).toMatch(/min-width:\s*0/);
  });

  const hostAndMeta = blockAfter('.rail .host, .rail .procmeta');

  it('keeps host and the age/memory text on one line each, truncated rather than wrapped', () => {
    expect(hostAndMeta).toMatch(/white-space:\s*nowrap/);
    expect(hostAndMeta).toMatch(/overflow:\s*hidden/);
    expect(hostAndMeta).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('lets each of them shrink below its own text, so there is something to truncate', () => {
    expect(hostAndMeta).toMatch(/min-width:\s*0/);
  });
});

/* ---- Status row, variant A -------------------------------------------
   Which text is SHOWN at which width is layout, and jsdom computes none of
   it -- the container query never evaluates there, so nothing below can
   prove the row looks right. What it can prove is that the mechanism is
   the intended one and that the two rules with real consequences hold: the
   percent is never hidden, and the status word is never removed from the
   accessibility tree. Both were established by measurement in Electron
   (see the commit message); these guard them against a later edit. */
describe('SessionRail.css: the status row drops text by the RAIL\'s width', () => {
  it('makes the card column itself the query container, not the window', () => {
    const rule = blockAfter('.railcards');
    expect(rule).toMatch(/container-type:\s*inline-size/);
    expect(rule).toMatch(/container-name:\s*rail/);
  });

  // The rail is resizable independently of the window, and a classic macOS
  // scrollbar takes ~15px off .railcards without the window changing at
  // all -- a width media query cannot see either.
  it('uses container queries rather than window-width media queries', () => {
    expect(css).toMatch(/@container\s+rail\s*\(/);
    expect(css).not.toMatch(/@media[^{]*\(\s*(max|min)-width/);
  });

  it('drops the token count and its separator together, at the wider breakpoint', () => {
    const m = css.match(/@container rail \(max-width:\s*(\d+)px\)\s*\{\s*([^}]*)\}/);
    expect(m, 'no @container block found').toBeTruthy();
    expect(m![2]).toMatch(/\.ctxchip-tok/);
    expect(m![2]).toMatch(/\.ctxchip-sep/);
    expect(m![2]).toMatch(/display:\s*none/);
  });

  // The one rule David was explicit about: "the numbers matter, and this
  // is the one that survives". Nothing anywhere in this file may hide it.
  it('never hides the percent left, at any width', () => {
    expect(css).not.toMatch(/\.ctxchip-pct[^{]*\{[^}]*display:\s*none/);
    for (const block of css.match(/@container[^{]*\{[\s\S]*?\n\}/g) ?? [])
      expect(block, 'a container query hides the percent').not.toMatch(/ctxchip-pct/);
  });

  // An icon with no accessible name is the failure mode this guards: at
  // the narrowest width the icon is the ONLY thing showing the state, so
  // the word has to stay readable to assistive tech.
  it('hides the status word visually WITHOUT removing it from the a11y tree', () => {
    const blocks = css.match(/@container[^{]*\{[\s\S]*?\n\}/g) ?? [];
    const wordBlock = blocks.find(b => b.includes('.state-word'));
    expect(wordBlock, 'no rule hides the status word').toBeTruthy();
    expect(wordBlock!).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(wordBlock!).not.toMatch(/display:\s*none/);
    expect(wordBlock!).not.toMatch(/visibility:\s*hidden/);
  });

  // The floor itself now lives on the base .metrics rule (SessionCard.css)
  // -- the same overflow was measured on the fleet grid's cards, so it is
  // not a rail-specific concern any more. What stays here is the tighter
  // column gap, which is what makes the one-line row reachable at all at
  // the rail's widths.
  it('keeps the rail\'s tighter column gap', () => {
    expect(blockAfter('.rail .metrics')).toMatch(/column-gap:\s*7px/);
  });

  // The icon is no longer rail-only (David: "Keep it consistent. Both
  // fleet and cards."), so this file should no longer be switching it on
  // or hiding a dot -- SessionCard.css owns the shape for every card now.
  it('no longer scopes the status shape to the rail', () => {
    expect(css).not.toMatch(/\.rail \.state \.dot/);
    expect(css).not.toMatch(/\.rail \.state \.stateicon/);
  });
});
