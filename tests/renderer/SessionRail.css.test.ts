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
