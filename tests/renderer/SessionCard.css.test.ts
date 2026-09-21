import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Layout-by-CSS, which jsdom cannot execute -- same technique and the same
// reasoning as theme.test.ts and SessionRail.css.test.ts. Comments stripped
// so an assertion can only match text that takes effect.
const css = readFileSync('src/renderer/components/SessionCard.css', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('SessionCard.css: the status row floor and shape', () => {
  // Measured: at the fleet grid's narrowest column (280px, its minmax
  // floor) the open-session card's row overflowed its card by 27px and the
  // history card's by 23px -- before the icon existed. Wrapping is what
  // turns that into a second line instead of an overrun, and it has to be
  // on the BASE rule because it is not a rail-only problem.
  it('lets the status row wrap, on every surface and not just the rail', () => {
    expect(css).toMatch(/\.metrics\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  // Colour is the second channel, never the only one: the shapes differ
  // (StatusIcon.tsx), and these hues are the retired dot's own mapping.
  it('owns the status shape for every card that shows one', () => {
    expect(css).toMatch(/\.stateicon\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/\.state\.working \.stateicon\s*\{[^}]*var\(--accent\)/);
    expect(css).toMatch(/\.state\.waiting_permission \.stateicon[^{]*\{[^}]*var\(--critical\)/);
    expect(css).toMatch(/\.state\.error \.stateicon\s*\{[^}]*var\(--signal\)/);
  });

  // The dot was told apart by hue alone, which is exactly what the shapes
  // replaced. Leaving its rules behind would invite it back.
  it('has retired the colour-only dot', () => {
    expect(css).not.toMatch(/\.state \.dot/);
  });
});
