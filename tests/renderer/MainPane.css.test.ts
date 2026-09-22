import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// David's own bug report against the real, running window: the header row
// ("All sessions", the folder path, the context chip, the Conversation/
// Terminal toggle) clips the toggle off the right edge ("Term...") in a
// narrow window, because every child shrinks together instead of only the
// path giving up space.
const CSS_PATH = 'src/renderer/components/MainPane.css';
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('MainPane.css: only the header path shrinks', () => {
  it('lets .panetitle both grow and shrink, and actually clip when it does', () => {
    const rule = blockAfter('.panetitle {');
    expect(rule).toMatch(/flex:\s*1\s+1\s+auto\b/);
    expect(rule).toMatch(/min-width:\s*0\b/);
    expect(rule).toMatch(/overflow:\s*hidden\b/);
    expect(rule).toMatch(/white-space:\s*nowrap\b/);
  });

  // The leading-ellipsis trick: an RTL box puts text-overflow's ellipsis at
  // the visual LEFT edge, so the tail of the path -- the actual project
  // folder -- survives truncation instead of an ever-longer, useless
  // "/Users/name/Doc…" prefix. unicode-bidi:plaintext keeps the path's own
  // slash-delimited segments resolved as the true left-to-right text they
  // are, so the direction:rtl box must never actually reorder a character.
  it('truncates from the start without reordering the path\'s own characters', () => {
    const rule = blockAfter('.panetitle {');
    expect(rule).toMatch(/direction:\s*rtl\b/);
    expect(rule).toMatch(/unicode-bidi:\s*plaintext\b/);
    expect(rule).toMatch(/text-align:\s*left\b/);
  });

  it('never lets the back button, the toggle, or the chip shrink', () => {
    expect(blockAfter('.paneback {')).toMatch(/flex:\s*none\b/);
    expect(blockAfter('.seg {')).toMatch(/flex:\s*none\b/);
    expect(blockAfter('.panehead .ctxchip {')).toMatch(/flex:\s*none\b/);
  });
});

// A session name is free text up to SESSION_NAME_MAX. The header's whole
// job is carrying the folder path the rail cannot fit (spec §3.7), so a
// long name must give way rather than crowd it out. jsdom computes no
// layout, so the stylesheet is the only place this can be pinned.
describe('MainPane.css: a long session name never crowds out the folder path', () => {
  const rule = blockAfter('.panename {');

  it('truncates instead of pushing the row wider', () => {
    expect(rule).toMatch(/overflow:\s*hidden\b/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis\b/);
    expect(rule).toMatch(/white-space:\s*nowrap\b/);
  });

  it('is allowed to shrink, and is capped so it cannot eat the path', () => {
    expect(rule).toMatch(/min-width:\s*0\b/);
    expect(rule).toMatch(/max-width:\s*\d/);
    expect(rule).not.toMatch(/flex:\s*none\b/);
  });
});
