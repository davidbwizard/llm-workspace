import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// David's own bug report against the real, running window: the Usage
// popover opens with its LEFT edge at the button and runs off the window's
// right edge, clipping the % text on each bar row. .usagewrap is already
// the positioned ancestor (position:relative) the popover anchors against
// -- same shape as OpenSessionCard.css's .cardmenu/.cardmenu-list, which
// anchors its own dropdown with right:0 for exactly this reason (that menu
// opens downward and leftward for the same off-window reason, David's
// separate bug report captured in OpenSessionCard.css.test.ts). The fix
// here is the same move: right:0 instead of left:0, so the popover's RIGHT
// edge lines up with the button's right edge and it grows leftward, inside
// the window, instead of past it.
const CSS_PATH = 'src/renderer/components/LaunchBar.css';
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('LaunchBar.css: the Usage popover opens leftward, inside the window', () => {
  const rule = blockAfter('.usagewrap .usagepop {');

  it('anchors its right edge to the button\'s right edge', () => {
    expect(rule).toMatch(/right:\s*0\b/);
  });

  it('never anchors the left edge -- that is the regression (opens rightward, off-window)', () => {
    expect(rule).not.toMatch(/left:\s*0\b/);
  });
});
