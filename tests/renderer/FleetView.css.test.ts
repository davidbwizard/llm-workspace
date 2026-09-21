import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Layout-by-CSS again: jsdom evaluates no container query, so what this can
// pin is the mechanism and the rule that must never bend.
const css = readFileSync('src/renderer/components/FleetView.css', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('FleetView.css: the grid card\'s own status-row breakpoint', () => {
  // Measured, not inherited from the rail's numbers: a grid card carries an
  // event count the rail's does not, and at the grid's narrowest possible
  // column (280px, its own minmax floor) the row overflowed by 27px.
  it('makes the grid card its own query container', () => {
    expect(css).toMatch(/\.fleet \.card\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.fleet \.card\s*\{[^}]*container-name:\s*gridcard/);
  });

  it('drops the token count, and only the token count', () => {
    const m = css.match(/@container gridcard \(max-width:\s*\d+px\)\s*\{([^}]*)\}/);
    expect(m, 'no gridcard container query found').toBeTruthy();
    expect(m![1]).toMatch(/\.ctxchip-tok/);
    expect(m![1]).toMatch(/\.ctxchip-sep/);
    expect(m![1]).toMatch(/display:\s*none/);
  });

  // The same rule David set for the rail: "the numbers matter, and this is
  // the one that survives". A grid card is never narrow enough to give up
  // the status word either, so nothing here may hide that.
  it('never hides the percent left or the status word', () => {
    for (const block of css.match(/@container[^{]*\{[\s\S]*?\n\}/g) ?? []) {
      expect(block).not.toMatch(/ctxchip-pct/);
      expect(block).not.toMatch(/state-word/);
    }
  });

  // The rail's breakpoints carry 15px because a classic scrollbar steals
  // width its container query cannot see. A grid card is not a scroll
  // container, so it must NOT copy that headroom -- this pins the
  // difference, which is easy to "tidy" into a bug later.
  it('uses a tighter number than the rail, because a card has no scrollbar', () => {
    const grid = Number(css.match(/@container gridcard \(max-width:\s*(\d+)px\)/)![1]);
    expect(grid).toBeGreaterThan(200);
    expect(grid).toBeLessThan(300);
  });
});
