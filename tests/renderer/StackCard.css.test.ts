import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// jsdom computes no layout and this repo's vitest config stubs CSS imports,
// so there is no way to render a stack and observe a real height animation
// or a real hidden subtree -- the same gap OpenSessionCard.css.test.ts,
// SessionRail.css.test.ts and ConversationView.css.test.ts already work
// around. Reading the stylesheet and asserting on the properties that take
// effect is that same established technique. StackCard.test.tsx separately
// proves the members stay mounted and the `open` class tracks the prop;
// that DOM test and this one together stand in for "the motion is right in
// the window". Neither alone would catch a regression.
const CSS_PATH = 'src/renderer/components/StackCard.css';
// Comments stripped first, so every assertion below runs against real
// declarations rather than text a comment happens to quote -- same defect
// and same fix as theme.test.ts and the other css tests in this directory.
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The first `{ ... }` block following `selector`'s first real occurrence.
 *  `selector` includes the trailing `{` so '.stackmembers {' cannot match
 *  inside '.stackmembers-inner {'. */
function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('the stack open/close motion', () => {
  it('declares the approved duration, easing and stagger in one place', () => {
    const root = blockAfter('.stack {');
    expect(root).toMatch(/--dur:\s*220ms/);
    expect(root).toMatch(/--ease:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
    expect(root).toMatch(/--stag:\s*30ms/);
  });

  // A hard-coded max-height either clips a deep stack or leaves dead air
  // under a shallow one. 0fr -> 1fr animates to CONTENT height.
  it('animates height with grid-template-rows, never max-height', () => {
    expect(blockAfter('.stackmembers {')).toMatch(/grid-template-rows:\s*0fr/);
    expect(blockAfter('.stack.open .stackmembers {')).toMatch(/grid-template-rows:\s*1fr/);
    expect(css).not.toMatch(/max-height/);
  });

  it('gives the collapsing grid an inner overflow-hidden wrapper', () => {
    const inner = blockAfter('.stackmembers-inner {');
    expect(inner).toMatch(/overflow:\s*hidden/);
    // Without min-height:0 a grid item refuses to shrink below its content,
    // and the 0fr row never actually collapses.
    expect(inner).toMatch(/min-height:\s*0/);
  });

  // The a11y half: always-rendered members would otherwise sit in the
  // accessibility tree and the tab order while folded.
  it('hides the folded subtree with visibility, not display', () => {
    expect(blockAfter('.stackmembers {')).toMatch(/visibility:\s*hidden/);
    expect(blockAfter('.stack.open .stackmembers {')).toMatch(/visibility:\s*visible/);
    // display:none would remove it from the a11y tree too, but it also kills
    // the transition outright -- the whole reason visibility is the tool.
    expect(css).not.toMatch(/display:\s*none/);
  });

  it('delays hiding until the collapse finishes, and shows immediately on open', () => {
    expect(blockAfter('.stackmembers {')).toMatch(/visibility\s+0s\s+linear\s+var\(--dur\)/);
    expect(blockAfter('.stack.open .stackmembers {')).toMatch(/visibility\s+0s\s+linear\s+0s/);
  });

  it('staggers members in by their index', () => {
    expect(blockAfter('.stack.open .stackmember {'))
      .toMatch(/transition-delay:\s*calc\(var\(--stag\)\s*\*\s*var\(--i\)\)/);
  });

  // Arriving staggers; leaving does not. The base rule's shorthand carries
  // an implicit 0 delay, and the closing transition reads the delay from the
  // state it is moving TO -- so this is what makes the exit move together.
  it('leaves no stagger on the way out', () => {
    const base = blockAfter('.stackmember {');
    expect(base).toMatch(/transition:\s*opacity\s+var\(--dur\)\s+var\(--ease\)/);
    expect(base).not.toMatch(/transition-delay/);
  });

  it('turns the chevron on the same duration and curve, so nothing arrives out of step', () => {
    expect(blockAfter('.stackchev {')).toMatch(/transition:\s*transform\s+var\(--dur\)\s+var\(--ease\)/);
    expect(blockAfter('.stack.open .stackchev {')).toMatch(/transform:\s*rotate\(180deg\)/);
  });

  // The rail already puts 6px between rows. A stack's margin-bottom is added
  // ON TOP of that, so any of it the sheets do not occupy becomes extra air
  // and the stack sits further from the next card than a plain card does --
  // which is exactly how it looked before these were tied together (8px of
  // margin over a 5px peek left 9px where every other row had 6px).
  //
  // Asserted as the RELATIONSHIP, not as three matching numbers: numbers are
  // what drifted, so a test that merely restates them would have passed
  // happily while the gap was wrong.
  it('hangs the margin exactly as far as the lowest sheet, so the rhythm is even', () => {
    expect(blockAfter('.stack {')).toMatch(/margin-bottom:\s*var\(--deepest-sheet\)/);
    expect(blockAfter('.stack {')).toMatch(/--deepest-sheet:\s*var\(--sheet-1\)/);
    expect(blockAfter('.stack.deep {')).toMatch(/--deepest-sheet:\s*var\(--sheet-2\)/);
    // And the sheets position themselves from the same two variables, so
    // moving a sheet moves the margin with it.
    expect(blockAfter('.stack::after {')).toMatch(/bottom:\s*calc\(var\(--sheet-1\) \* -1\)/);
    expect(blockAfter('.stack.deep::before {')).toMatch(/bottom:\s*calc\(var\(--sheet-2\) \* -1\)/);
  });

  // A margin on .stackmembers survives the grid row collapsing to 0fr, so it
  // left a dead band under a FOLDED card -- and the deck's sheets, positioned
  // from the bottom of the whole component, floated away from the card by
  // exactly that much. The gap above the members therefore has to live inside
  // the clipped area, where collapsing takes it with them.
  it('keeps the gap above the members inside the clip, so a folded card has no dead band', () => {
    expect(blockAfter('.stackmembers {')).not.toMatch(/margin:\s*\d+px\s+0\s+0/);
    expect(blockAfter('.stackmembers-inner {')).toMatch(/padding-top:\s*8px/);
  });

  // The sheets stand for members you cannot see. Once the stack is open you
  // can see them, and the deck would also be sitting under the expanded list
  // rather than under the card.
  it('hides the deck once the stack is open', () => {
    expect(blockAfter('.stack.open::after, .stack.open::before {')).toMatch(/opacity:\s*0/);
  });

  // Found by hand-testing the running app, which is the only place it shows:
  // jsdom computes no layout, so nothing in this suite can see a rotation
  // happening about the wrong point.
  //
  // .stacktoggle is a COLUMN flex container, so its cross axis is horizontal
  // and the default align-items:stretch blows .stackchev out to the full
  // width of the card. The 12px glyph then sits at the left edge of a ~250px
  // box, and rotate(180deg) turns about the BOX centre -- half a card away --
  // so the arrow swings across in a semicircle instead of turning in place.
  // `flex: none` does not help; it governs the main (vertical) axis.
  it('sizes the chevron box to its content, so the mark turns in place and does not arc', () => {
    // Any of these keeps the box hugging the glyph; `stretch` is the one that
    // breaks it, and `flex: none` is NOT a substitute (wrong axis).
    expect(blockAfter('.stackchev {')).toMatch(/align-self:\s*(center|flex-end|flex-start)/);
    expect(blockAfter('.stackchev {')).not.toMatch(/align-self:\s*stretch/);
  });

  // A stack face and a plain card sit next to each other in one column, so a
  // different internal rhythm reads as inconsistent padding even when the
  // padding is byte-identical -- which is exactly how it looked when the
  // chevron had its own row and the gap was 6px against the card's 10px.
  // The rail defaults to compact. While this component ignored that setting
  // it rendered full-size among cards that had shrunk, which is what read as
  // a stack having more padding than its neighbours -- the paddings were
  // byte-identical all along. These values MIRROR OpenSessionCard.css's own
  // `.card.compact`; they are not independently chosen.
  it('shrinks with the rail in compact mode, to the same numbers a card uses', () => {
    expect(blockAfter('.stack.compact > .stackface {')).toMatch(/padding:\s*10px 12px 11px/);
    expect(blockAfter('.stack.compact .stacktoggle {')).toMatch(/gap:\s*7px/);
    expect(blockAfter('.stack.compact .stackname {')).toMatch(/font-size:\s*15px/);
  });

  it('spaces its rows like a plain card does, and keeps the chevron on the top row', () => {
    expect(blockAfter('.stacktoggle {')).toMatch(/gap:\s*10px/);
    expect(blockAfter('.stackchev {')).toMatch(/margin-left:\s*auto/);
    expect(blockAfter('.stacktop {')).toMatch(/align-self:\s*stretch/);
  });

  // theme.css's blanket reduced-motion rule is `* { animation:none }` plus
  // `.card, .btn { transition:none }` -- it does NOT cover .stack's
  // transitions, so this block is load-bearing rather than belt and braces.
  it('stops the motion under prefers-reduced-motion, without stranding the members', () => {
    const idx = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(idx, 'no reduced-motion block').toBeGreaterThanOrEqual(0);
    const block = css.slice(idx, css.indexOf('}\n}', idx) + 3);
    expect(block).toMatch(/\.stackmembers/);
    expect(block).toMatch(/\.stackmember\b/);
    expect(block).toMatch(/\.stackchev/);
    expect(block).toMatch(/transition:\s*none/);
    // Only the transition goes. If this block touched visibility, a
    // reduced-motion user would open the stack onto nothing.
    expect(block).not.toMatch(/visibility/);
    expect(block).not.toMatch(/opacity/);
  });
});
