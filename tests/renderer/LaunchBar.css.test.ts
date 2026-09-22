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

// The launch-options panel is the Launch split button's own dropdown. It
// opens from the far right of the bar, so it has exactly the off-window
// problem the Usage popover above was reported for -- pinned the same way,
// here rather than after a second bug report.
describe('LaunchBar.css: the launch-options panel', () => {
  it('opens leftward, inside the window, like the Usage popover', () => {
    const rule = blockAfter('.launchdrop {');
    expect(rule).toMatch(/right:\s*0\b/);
    expect(rule).not.toMatch(/left:\s*0\b/);
    expect(rule).toMatch(/position:\s*absolute/);
  });

  it('hangs off a positioned wrapper, which is also the outside-click boundary', () => {
    expect(blockAfter('.launchsplit {')).toMatch(/position:\s*relative/);
  });

  // .metrics on the cards has overflowed three times this week for want of
  // exactly this: the panel is a fixed 290px and its field must scroll its
  // own text rather than stretch. Without min-width:0 a long typed name
  // grows the input, the panel, and the bar behind it.
  it('keeps a long typed name inside the field instead of widening the bar', () => {
    expect(blockAfter('.launchdrop input {')).toMatch(/min-width:\s*0\b/);
  });

  // The two halves have to read as one control, not two buttons touching.
  it('squares the seam between the two halves of the split button', () => {
    expect(blockAfter('.launchsplit .launchgo {')).toMatch(/border-radius:\s*6px 0 0 6px/);
    expect(blockAfter('.launchmore {')).toMatch(/border-radius:\s*0 6px 6px 0/);
  });
});
