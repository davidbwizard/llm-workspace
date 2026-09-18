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
