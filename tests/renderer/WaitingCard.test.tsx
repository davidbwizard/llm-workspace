import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WaitingCard } from '../../src/renderer/components/WaitingCard.tsx';

describe('WaitingCard', () => {
  it('says who is waiting and offers the terminal', () => {
    const onOpenTerminal = vi.fn();
    render(<WaitingCard provider="claude" hooksOn={true} onOpenTerminal={onOpenTerminal} />);
    expect(screen.getByText('Claude is waiting on you')).toBeTruthy();
    expect(screen.getByText('Answer in the Terminal')).toBeTruthy();
    expect(screen.getByText('Claude is showing a question or a permission prompt.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    expect(onOpenTerminal).toHaveBeenCalled();
  });

  // The name and logo come from the session's own provider rather than
  // being hard-coded to Claude -- only Claude reports `waiting` today, but
  // nothing about this card should assume that stays true.
  it('names the Codex provider rather than assuming Claude', () => {
    render(<WaitingCard provider="codex" hooksOn={true} onOpenTerminal={() => {}} />);
    expect(screen.getByText('Codex is waiting on you')).toBeTruthy();
    expect(screen.getByText('Codex is showing a question or a permission prompt.')).toBeTruthy();
  });

  // ProviderMark's own glyph is decorative (ConversationView.tsx's meta
  // line makes the same call) -- the eyebrow's own text already carries the
  // provider's name for assistive tech, so the glyph must not announce a
  // second time.
  it('marks the provider glyph as decorative', () => {
    const { container } = render(<WaitingCard provider="claude" hooksOn={true} onOpenTerminal={() => {}} />);
    const svg = container.querySelector('.eyebrow svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  // Task 5 (quick-answers design §9/§10): with hooks off, this fallback
  // card is the ONLY place a person would learn Quick answers exists at
  // all -- there is no prompt card to have shown them otherwise.
  it('tells the reader to turn on Quick answers when hooks are off', () => {
    render(<WaitingCard provider="claude" hooksOn={false} onOpenTerminal={() => {}} />);
    expect(screen.getByText('Turn on Quick answers in Settings to answer here.')).toBeTruthy();
  });

  it('says nothing about Quick answers once hooks are on', () => {
    render(<WaitingCard provider="claude" hooksOn={true} onOpenTerminal={() => {}} />);
    expect(screen.queryByText('Turn on Quick answers in Settings to answer here.')).toBeNull();
  });
});
