import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS_PATH = 'src/renderer/components/ContextChip.css';
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('ContextChip.css: theme tokens only', () => {
  it('declares every colour through var(--token), never a literal hex or rgb', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/i);
  });

  it('uses the shared muted/signal/critical tokens', () => {
    expect(css).toMatch(/\.ctxchip\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(css).toMatch(/\.ctxchip-signal\s*\{[^}]*color:\s*var\(--signal\)/);
    expect(css).toMatch(/\.ctxchip-critical\s*\{[^}]*color:\s*var\(--critical\)/);
  });
});
