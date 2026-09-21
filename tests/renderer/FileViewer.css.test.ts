import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// CSS cannot be rendered here, so these are the parts that are checkable
// without eyes: that the viewer is themed from the app's own tokens rather
// than the mockup's literals, that each placement actually constrains
// itself, and that an open sheet cannot leak its scrolling into the
// conversation behind it. Everything else about how it LOOKS needs looking
// at.
const raw = readFileSync('src/renderer/components/FileViewer.css', 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('FileViewer.css', () => {
  it('takes every colour from a theme token, so both palettes follow', () => {
    // One deliberate exception: the sheet's backdrop, which matches the
    // literal SettingsModal.css already uses so the app has one dimmed
    // background rather than two.
    const colours = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(colours).toEqual([]);
    const rgbs = (css.match(/\brgb\(|\brgba\(/gi) ?? []).length;
    expect(rgbs).toBe(1);
    expect(blockAfter('.fvscrim {')).toMatch(/background:\s*rgb\(0 0 0 \/ 46%\)/);
  });

  it('uses the app\'s own families and radii, not the mockup\'s literals', () => {
    expect(css).toMatch(/font-family:var\(--f-mono\)/);
    expect(css).toMatch(/font-family:var\(--f-display\)/);
    expect(css).toMatch(/border-radius:var\(--r-md\)/);
    expect(css).toMatch(/border-radius:var\(--r-sm\)/);
  });

  it('gives the side panel a fixed share and a floor', () => {
    const side = blockAfter('.fileviewer.side {');
    expect(side).toMatch(/flex:\s*none/);
    expect(side).toMatch(/width:\s*46%/);
    expect(side).toMatch(/min-width:\s*\d+px/);
    expect(side).toMatch(/border-left:/);
  });

  it('bounds the sheet to the pane it floats over', () => {
    const sheet = blockAfter('.fileviewer.sheet {');
    expect(sheet).toMatch(/max-height:\s*100%/);
    expect(sheet).toMatch(/overflow:\s*hidden/);
    const scrim = blockAfter('.fvscrim {');
    // absolute, not fixed: the scrim covers the conversation, not the
    // window, so the pane's own header stays usable.
    expect(scrim).toMatch(/position:\s*absolute/);
    expect(scrim).toMatch(/inset:\s*0/);
  });

  it('scrolls inside itself and stops there', () => {
    const body = blockAfter('.fvbody {');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/min-height:\s*0/);
    // Without this, scrolling past the end of the document starts
    // scrolling the conversation behind it.
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
  });

  it('lets only the file name give up width in the header', () => {
    expect(blockAfter('.fvname {')).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(blockAfter('.fvname {')).toMatch(/min-width:\s*0/);
    expect(blockAfter('.fvbtn {')).toMatch(/flex:\s*none/);
    expect(blockAfter('.fvsize {')).toMatch(/flex:\s*none/);
  });

  it('keeps a wide table inside the panel instead of widening it', () => {
    const table = blockAfter('.fvbody table {');
    expect(table).toMatch(/display:\s*block/);
    expect(table).toMatch(/overflow-x:\s*auto/);
  });
});

describe('ConversationView.css: the clickable path', () => {
  const conv = readFileSync('src/renderer/components/ConversationView.css', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (() => {
    const idx = conv.indexOf('.turn-text.md .fp {');
    expect(idx).toBeGreaterThanOrEqual(0);
    const open = conv.indexOf('{', idx);
    return conv.slice(open + 1, conv.indexOf('}', open));
  })();

  it('resets the button chrome it inherits from the UA', () => {
    // It is a <button> for keyboard and screen readers; it must still read
    // as the inline code it replaced.
    expect(rule).toMatch(/font-family:var\(--f-mono\)/);
    expect(rule).toMatch(/background:var\(--raised\)/);
    expect(rule).toMatch(/border:1px solid transparent/);
    expect(rule).toMatch(/color:var\(--ink\)/);
  });

  it('says it is clickable without being a link', () => {
    expect(rule).toMatch(/cursor:\s*pointer/);
    expect(rule).toMatch(/text-decoration-style:\s*dotted/);
  });

  it('is visible when tabbed to, not only when hovered', () => {
    expect(conv).toMatch(/\.turn-text\.md \.fp:focus-visible \{[^}]*outline:/);
  });
});
