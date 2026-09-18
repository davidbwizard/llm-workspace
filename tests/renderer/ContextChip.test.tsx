import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ContextChip } from '../../src/renderer/components/ContextChip.tsx';
import type { SessionContext } from '../../src/core/usage.ts';

describe('ContextChip', () => {
  it('renders nothing when context is null -- hidden, not a dash or a zero', () => {
    const { container } = render(<ContextChip context={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the short form and percent left', () => {
    const ctx: SessionContext = { usedTokens: 462_400, windowTokens: 1_000_000, leftPct: 44 };
    const { getByText } = render(<ContextChip context={ctx} />);
    expect(getByText('462k · 44% left')).toBeTruthy();
  });

  it('is muted (no tone modifier class) at 20% left and above', () => {
    const ctx: SessionContext = { usedTokens: 800_000, windowTokens: 1_000_000, leftPct: 20 };
    const { container } = render(<ContextChip context={ctx} />);
    const chip = container.querySelector('.ctxchip')!;
    expect(chip.className).toBe('ctxchip');
  });

  it('turns --signal below 20% left', () => {
    const ctx: SessionContext = { usedTokens: 830_000, windowTokens: 1_000_000, leftPct: 19 };
    const { container } = render(<ContextChip context={ctx} />);
    expect(container.querySelector('.ctxchip-signal')).toBeTruthy();
    expect(container.querySelector('.ctxchip-critical')).toBeNull();
  });

  it('turns --critical below 10% left', () => {
    const ctx: SessionContext = { usedTokens: 920_000, windowTokens: 1_000_000, leftPct: 9 };
    const { container } = render(<ContextChip context={ctx} />);
    expect(container.querySelector('.ctxchip-critical')).toBeTruthy();
    expect(container.querySelector('.ctxchip-signal')).toBeNull();
  });
});
