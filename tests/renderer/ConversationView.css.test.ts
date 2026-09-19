import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The visual-distinction feature (user vs assistant turns must read apart
// at a glance, and not by colour alone) is CSS-only -- jsdom does not
// compute real layout or paint colour, so there is no way to render a turn
// and observe an actual border width or font weight (the same gap
// SessionRail.css.test.ts and theme.test.ts already work around for this
// codebase). Reading the stylesheet directly and asserting on the
// properties that take effect is that same established technique.
const CSS_PATH = 'src/renderer/components/ConversationView.css';
// Comments are stripped before any assertion runs against real text, not
// text a comment merely happens to quote -- same defect and same fix as
// theme.test.ts and SessionRail.css.test.ts.
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The first `{ ... }` block following `selector`'s first real occurrence.
 *  Assumes no nested braces inside the block, true for every rule in this
 *  file. `selector` includes the trailing `{` so e.g. '.turn {' cannot
 *  match inside '.turn.user {' or '.turn .turn-text {'. */
function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('ConversationView.css: user and agent turns are visually distinguishable', () => {
  const base = blockAfter('.turn {');
  const assistant = blockAfter('.turn.assistant {');
  const baseSaid = blockAfter('.turn .turn-text {');
  const userSaid = blockAfter('.turn.user .turn-text {');

  // Style A, the default David picked against the rendered mockup: the
  // accent rule runs down the AGENT's replies, never the user's. The
  // structural cue is the rule's WIDTH (present vs absent), so it survives
  // greyscale and a colour-vision deficiency; the accent hue is a second,
  // redundant cue layered on top.
  it('gives agent turns a margin rule that the shared/user rule does not have', () => {
    expect(assistant).toMatch(/border-left:\s*[1-9]/); // a real, nonzero width
    expect(base).not.toMatch(/border-left/); // absent from the rule user turns fall back to
  });

  // Per the Sep 2026 design artifact, text weight is not a cue at all any
  // more -- neither side is bold. The colour-independent cue for the
  // user's side is the border-left rule's absence here (style A) or the
  // bubble/border/right-alignment (style C), not a heavier text cut.
  it('gives neither turn a font-weight -- style A and C carry the colour-independent cue instead', () => {
    expect(userSaid).not.toMatch(/font-weight/);
    expect(baseSaid).not.toMatch(/font-weight/);
  });

  // The artifact emphasises the AGENT's replies, not the user's prompts as
  // this pane had it before: the agent's text runs at full strength
  // (--ink), the user's dimmer (--ink-2).
  it('backs the structural cues with the app\'s existing ink/ink-2 pair and its one emphasis colour', () => {
    expect(assistant).toMatch(/var\(--accent\)/);
    expect(baseSaid).toMatch(/color:\s*var\(--ink\)\s*;/);
    expect(userSaid).toMatch(/color:\s*var\(--ink-2\)\s*;/);
  });

  it('uses theme tokens for every colour here, never a hardcoded hex', () => {
    expect(assistant).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(userSaid).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('ConversationView.css: a thinking-only reply reads as a muted note', () => {
  it('dims and italicises .turn-text.note using a theme token, never a hardcoded hex', () => {
    const rule = blockAfter('.turn-text.note {');
    expect(rule).toMatch(/color:\s*var\(--muted\)/);
    expect(rule).toMatch(/font-style:\s*italic/);
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('ConversationView.css: one text size drives the whole pane', () => {
  // Spec §3.5: conversation text size is a CSS variable on the
  // conversation root, and every message-level size is expressed relative
  // to it -- so changing it in Settings moves the meta lines and code
  // blocks with the body text instead of leaving them behind.
  it('declares --conv-size on the conversation root, defaulting to 16px', () => {
    expect(blockAfter('.conv {')).toMatch(/--conv-size:\s*16px/);
  });

  it('sizes the meta line, code and tables off that variable, not off a fixed px', () => {
    for (const selector of ['.turn .who, .turn .when {', '.turn-text.md code {',
                            '.turn-text.md pre {', '.turn-text.md table {']) {
      expect(blockAfter(selector), selector).toMatch(/font-size:\s*calc\(var\(--conv-size\)/);
    }
  });

  it('offers style C as well as the default style A, keyed off data-style', () => {
    expect(css).toMatch(/\.conv\[data-style="c"\]/);
  });
});

describe('ConversationView.css: a short conversation sits at the bottom, not the top', () => {
  it('makes .conv a flex column so the turns stack can be pinned to its bottom edge', () => {
    const rule = blockAfter('.conv {');
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/flex-direction:\s*column/);
  });

  // margin-top:auto, not justify-content:flex-end: on a scrollable flex
  // container, flex-end has a long-standing cross-engine bug -- once
  // content overflows, the overflowing top portion becomes unreachable.
  it('pins the turns stack to the bottom via margin-top:auto', () => {
    expect(blockAfter('.convstack {')).toMatch(/margin-top:\s*auto/);
  });

  it('does not bottom-align the scroller itself with justify-content', () => {
    expect(blockAfter('.conv {')).not.toMatch(/justify-content/);
  });
});

describe('ConversationView.css: the history markers separate from the content below them', () => {
  it('puts the separating border and spacing on the markers\' bottom edge, not their top', () => {
    const rule = blockAfter('.conv-end, .conv-loading-more {');
    expect(rule).toMatch(/border-bottom:\s*1px solid var\(--line-soft\)/);
    expect(rule).toMatch(/padding-bottom:\s*8px/);
    expect(rule).toMatch(/margin:\s*0 0 6px/);
    expect(rule).not.toMatch(/border-top/);
    expect(rule).not.toMatch(/padding-top/);
  });
});

describe('ConversationView.css: markdown replies', () => {
  it('turns pre-wrap off for markdown, so newlines between block elements do not become blank lines', () => {
    expect(blockAfter('.turn-text.md {')).toMatch(/white-space:\s*normal/);
  });

  it('styles code blocks with the mono font and theme tokens, scrolling instead of overflowing', () => {
    const pre = blockAfter('.turn-text.md pre {');
    expect(pre).toMatch(/var\(--f-mono\)/);
    expect(pre).toMatch(/background:\s*var\(--/);
    expect(pre).toMatch(/overflow-x:\s*auto/);
  });

  it('styles tables with theme-token borders', () => {
    expect(blockAfter('.turn-text.md th, .turn-text.md td {')).toMatch(/border:\s*1px solid var\(--line\)/);
  });

  it('uses no hardcoded hex anywhere in the stylesheet', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('ConversationView.css: the message box\'s length counter', () => {
  it('is quiet under the cap -- same muted tone as the rest of the box\'s status copy', () => {
    expect(blockAfter('.convcount {')).toMatch(/color:\s*var\(--muted\)/);
  });

  // --signal, not --critical: OpenSessionCard.css's own comment on its
  // unread dot is explicit that --critical is reserved for "waiting on
  // you" alone and must stay unambiguous. --signal is the "deliberately
  // less urgent" warning tone already used for refusal copy elsewhere
  // (LaunchBar.css's .launchmsg, ReplyPopover.css's .replymsg).
  it('takes the app\'s existing warning colour, not the more severe one, at or over the cap', () => {
    expect(blockAfter('.convcount-warn {')).toMatch(/color:\s*var\(--signal\)/);
    expect(blockAfter('.convcount-warn {')).not.toMatch(/var\(--critical\)/);
  });

  it('hides the over-cap announcement visually while keeping it readable to assistive tech', () => {
    const rule = blockAfter('.convannounce {');
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(rule).not.toMatch(/display:\s*none/);
  });
});

// Stylesheets are global in this app. Every message here used class "said",
// which SessionCard.css also styles with a 2-line clamp and overflow:hidden
// -- so every reply longer than two lines was cut off in the real window,
// while jsdom (no layout) passed every test. Guard the class names, since
// the clipping itself cannot be observed here.
describe('ConversationView.css: no class name shared with the card stylesheets', () => {
  const classesIn = (path: string): Set<string> => {
    const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...text.matchAll(/([^{}]+)\{[^}]*\}/g)].map(m => m[1]!).join(' ');
    return new Set([...selectors.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]!));
  };
  const mine = classesIn(CSS_PATH);

  for (const card of ['src/renderer/components/SessionCard.css', 'src/renderer/components/OpenSessionCard.css']) {
    it(`shares no class with ${card}`, () => {
      expect([...classesIn(card)].filter(c => mine.has(c))).toEqual([]);
    });
  }
});

describe('ConversationView.css: readable line length', () => {
  // Edge-to-edge lines are hard to read on a wide window; 45-75 characters
  // is the usual range. The approved mockup caps message text at 72ch
  // (`.text { max-width:72ch }`). `ch` tracks the text-size setting, so the
  // cap stays about 72 characters at 14 to 17px.
  it('caps every turn\'s text at 72ch', () => {
    expect(blockAfter('.turn .turn-text {')).toMatch(/max-width:\s*72ch/);
  });
});

describe('ConversationView.css: long unbroken text wraps in every turn', () => {
  // Seen 2026-09-18: a user message containing a long comma-joined token
  // (a MySQL sql_mode list) ran past its bubble. Markdown replies already
  // wrapped (.turn-text.md); plain user text did not.
  it('breaks long words in the shared turn text rule, not only in markdown', () => {
    expect(blockAfter('.turn .turn-text {')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
