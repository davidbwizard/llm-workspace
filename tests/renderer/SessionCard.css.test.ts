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

  // Two motions, two meanings: working SPINS (progress), waiting PULSES
  // (attention). Swapping them would be a lie -- a turning ring on a
  // session that is blocked on the person says work is happening.
  it('spins the working icon and pulses the waiting one, never the reverse', () => {
    expect(css).toMatch(/@keyframes stateicon-spin/);
    expect(css).toMatch(/@keyframes stateicon-pulse/);
    expect(css).toMatch(/\.state\.working \.stateicon\s*\{[^}]*animation:\s*stateicon-spin/);
    expect(css).toMatch(/\.state\.waiting_permission \.stateicon[^{]*\{[^}]*animation:\s*stateicon-pulse/);
    const working = css.match(/\.state\.working \.stateicon\s*\{([^}]*)\}/)![1];
    expect(working).not.toMatch(/stateicon-pulse/);
    const waiting = css.match(/\.state\.waiting_permission \.stateicon[^{]*\{([^}]*)\}/)![1];
    expect(waiting).not.toMatch(/stateicon-spin/);
  });

  // Idle and error are resting states. Animating them would spend the
  // eye's attention on the two states that are not asking for it.
  it('leaves idle and error still', () => {
    for (const state of ['idle', 'error']) {
      const rule = new RegExp(`\\.state\\.${state} \\.stateicon[^{]*\\{([^}]*)\\}`, 'g');
      for (const match of css.matchAll(rule)) expect(match[1]).not.toMatch(/animation:\s*stateicon-/);
    }
  });

  // 1 -> .3 is David's chosen depth, the same range the strip's dot
  // already pulses through, so the app has one pulse depth and not two.
  // Pinned because it is a decision, not an arbitrary number.
  it('pulses waiting through the depth David picked', () => {
    const framesMatch = css.match(/@keyframes stateicon-pulse\s*\{([\s\S]*?)\n\}/);
    expect(framesMatch?.[1]).toBeTruthy();
    const opacities = [...(framesMatch?.[1] ?? '').matchAll(/opacity:\s*([\d.]+)/g)]
      .map(m => Number(m[1]));
    expect(Math.max(...opacities)).toBe(1);
    expect(Math.min(...opacities)).toBe(0.3);
  });

  // theme.css carries a blanket `* { animation:none !important }` under the
  // same query, so this is belt and braces -- asserted anyway so the
  // component stays correct on its own rather than by a rule defined in
  // another file, which is the same call WorkingStrip.css made.
  it('stops both motions for anyone who asked for less', () => {
    const reduced = css.match(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toMatch(/\.state\.working \.stateicon\s*\{[^}]*animation:\s*none/);
    expect(reduced![1]).toMatch(/\.state\.waiting_permission \.stateicon[^{]*\{[^}]*animation:\s*none/);
    // Stopped mid-pulse would leave the critical marker dimmed forever.
    expect(reduced![1]).toMatch(/\.state\.waiting_permission \.stateicon[^{]*\{[^}]*opacity:\s*1/);
  });
});
