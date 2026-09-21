import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ContextChip } from '../../src/renderer/components/ContextChip.tsx';
import type { SessionContext } from '../../src/core/usage.ts';

describe('ContextChip', () => {
  it('renders nothing when context is null -- hidden, not a dash or a zero', () => {
    const { container } = render(<ContextChip context={null} />);
    expect(container.firstChild).toBeNull();
  });

  // Read via textContent, not getByText: the chip is three spans now (so
  // the rail can drop the token count on its own), and getByText matches
  // an element's own direct text, which a split string no longer is. What
  // a person -- or a screen reader -- gets is unchanged, and that is what
  // this asserts.
  it('shows the short form and percent left', () => {
    const ctx: SessionContext = { usedTokens: 462_400, windowTokens: 1_000_000, leftPct: 44 };
    const { container } = render(<ContextChip context={ctx} />);
    expect(container.querySelector('.ctxchip')!.textContent).toBe('462k · 44% left');
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

  /** Status row, variant A: as the rail narrows the TOKEN COUNT drops and
   *  the percent stays ("the numbers matter, and this is the one that
   *  survives" -- David). Which width that happens at is CSS this suite
   *  cannot see (jsdom computes no layout, so the container query never
   *  evaluates); what it CAN pin is that the two halves are separately
   *  addressable at all, which is what makes dropping one of them
   *  possible. Without these, the chip is one text node and no stylesheet
   *  can drop half of it. */
  describe('token count and percent are separately addressable', () => {
    const ctx: SessionContext = { usedTokens: 462_400, windowTokens: 1_000_000, leftPct: 44 };

    it('puts the token count in its own element', () => {
      const { container } = render(<ContextChip context={ctx} />);
      expect(container.querySelector('.ctxchip-tok')!.textContent).toBe('462k');
    });

    it('puts the percent left in its own element', () => {
      const { container } = render(<ContextChip context={ctx} />);
      expect(container.querySelector('.ctxchip-pct')!.textContent).toBe('44% left');
    });

    // The separator belongs to the token count, not the percent: dropping
    // the count has to take its "·" with it, or the row starts with a
    // stray middot.
    it('puts the separator in its own element, so it can leave with the count', () => {
      const { container } = render(<ContextChip context={ctx} />);
      expect(container.querySelector('.ctxchip-sep')).toBeTruthy();
    });

    // The split is structural only. Read as text the chip must be exactly
    // what it always was -- the assertion above ("shows the short form and
    // percent left") passes unchanged, and so does every caller that reads
    // this chip's text rather than its elements.
    it('reads as one unbroken string, spacing included', () => {
      const { container } = render(<ContextChip context={ctx} />);
      expect(container.querySelector('.ctxchip')!.textContent).toBe('462k · 44% left');
    });
  });
});
