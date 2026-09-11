import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProviderMark } from '../../src/renderer/components/ProviderMark.tsx';

describe('ProviderMark', () => {
  it('renders the Anthropic glyph for claude', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M17\.3041 3\.541/);
  });

  it('renders the OpenAI glyph for codex', () => {
    const { container } = render(<ProviderMark provider="codex" />);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M22\.2819 9\.8211/);
  });

  it('inherits colour rather than hardcoding one', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    expect(container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });

  it('is hidden from assistive tech, since the label is adjacent text', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
