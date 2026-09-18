import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Same technique as ConversationView.css.test.ts and SessionRail.css.test.ts:
// jsdom computes no real layout or paint, so the CSS itself is read and
// asserted on directly. This file's own job (task-5-brief.md) is porting the
// mockup's .q/.opt/.choices/.cmd/.plan/.feedback rules onto this app's own
// theme tokens (src/renderer/theme.css) rather than hardcoded hex -- the
// base .prompt/.p-head/.eyebrow/.p-body/.p-foot/.hint/.btn/.btn.primary rules
// already live in WaitingCard.css (loaded globally once ConversationView
// imports WaitingCard) and are deliberately NOT redefined here.
const CSS_PATH = 'src/renderer/components/PromptCard.css';
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function blockAfter(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('PromptCard.css: ported from the mockup onto theme tokens', () => {
  it('uses theme tokens throughout, never a hardcoded hex', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('highlights a checked option with the accent tokens', () => {
    const rule = blockAfter('.opt:has(input:checked) {');
    expect(rule).toMatch(/var\(--accent\)/);
    expect(rule).toMatch(/var\(--accent-soft\)/);
  });

  it('renders the command block in the app\'s mono font on the raised surface', () => {
    const rule = blockAfter('.cmd {');
    expect(rule).toMatch(/var\(--f-mono\)/);
    expect(rule).toMatch(/var\(--raised\)/);
  });

  it('gives the plan box a dashed border and its own scroll region', () => {
    const rule = blockAfter('.plan {');
    expect(rule).toMatch(/border:\s*1px dashed var\(--line\)/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('defines a quiet button variant, distinct from the default and primary already in WaitingCard.css', () => {
    const rule = blockAfter('.btn.quiet {');
    expect(rule).toMatch(/var\(--muted\)/);
  });

  it('lays choice buttons out in a column, with the key shown via kbd', () => {
    expect(blockAfter('.choices {')).toMatch(/flex-direction:\s*column/);
    expect(blockAfter('.choices .btn kbd {')).toMatch(/var\(--f-mono\)/);
  });
});
