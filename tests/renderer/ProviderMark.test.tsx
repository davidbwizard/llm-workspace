import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProviderMark } from '../../src/renderer/components/ProviderMark.tsx';

describe('ProviderMark', () => {
  // Simple Icons' `claude` glyph (CC0), the same source this file already
  // cites for the Codex mark -- not the Anthropic wordmark A that used to
  // stand in for it. The conversation pane marks every agent turn with
  // this, so it is the app's most-rendered glyph.
  it('renders the Claude glyph for claude, not the Anthropic wordmark', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).toMatch(/^m4\.7144 15\.9555/);
    expect(d).not.toMatch(/^M17\.3041 3\.541/);
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
