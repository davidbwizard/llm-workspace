import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS_PATH = 'src/renderer/components/UsagePopover.css';
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('UsagePopover.css: theme tokens only', () => {
  it('declares every colour through var(--token), never a literal hex or rgb', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/i);
  });

  it('reuses the app\'s existing floating-panel elevation token', () => {
    expect(css).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
  });
});

// David's own bug report against the real, running window: the popover
// opens with its left edge at the Usage button and runs off the window's
// right edge, clipping the % text on each bar row. LaunchBar.css.test.ts
// covers the anchor side of the fix (right:0, opening leftward); this pins
// the other half -- the popover must never grow wider than the window
// itself, whatever width the window is resized down to.
describe('UsagePopover.css: never wider than the viewport', () => {
  it('caps width at min(360px, viewport minus a 32px margin)', () => {
    const rule = css.slice(css.indexOf('.usagepop {'), css.indexOf('.usagesection'));
    expect(rule).toMatch(/max-width:\s*min\(\s*360px\s*,\s*calc\(100vw\s*-\s*32px\)\s*\)/);
  });
});
