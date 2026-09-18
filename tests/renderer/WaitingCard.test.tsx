import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { WaitingCard, WaitingFallback } from '../../src/renderer/components/WaitingCard.tsx';

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

// Task 6 (by eye): the fallback card flashed before the prompt card while
// main was still reading the prompt. With Quick answers on, the first 2 s of
// a waiting-without-prompt stretch show the prompt card's frame with a
// reading line and no buttons; only after that does the fallback appear.
describe('WaitingFallback', () => {
  afterEach(() => { vi.useRealTimers(); });

  const READING = "Reading Claude's prompt…";

  it('shows the reading frame, with no buttons, for 2 s, then the fallback card', () => {
    vi.useFakeTimers();
    render(<WaitingFallback provider="claude" hooksOn={true} onOpenTerminal={() => {}} />);
    expect(screen.getByText('Claude is waiting on you')).toBeTruthy();
    expect(screen.getByText(READING)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText('Answer in the Terminal')).toBeNull();

    act(() => { vi.advanceTimersByTime(1999); });
    expect(screen.getByText(READING)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText(READING)).toBeNull();
    expect(screen.getByText('Answer in the Terminal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Terminal' })).toBeTruthy();
  });

  it('shows the fallback card at once when Quick answers is off', () => {
    vi.useFakeTimers();
    render(<WaitingFallback provider="claude" hooksOn={false} onOpenTerminal={() => {}} />);
    expect(screen.queryByText(READING)).toBeNull();
    expect(screen.getByText('Answer in the Terminal')).toBeTruthy();
    expect(screen.getByText('Turn on Quick answers in Settings to answer here.')).toBeTruthy();
  });

  // The switch's state is read when the wait begins (ConversationView), so
  // it can be unknown for the first few ms: the neutral frame shows, and a
  // read that says off swaps in the fallback at once.
  it('shows the reading frame while the switch state is unknown, and the fallback once it reads off', () => {
    vi.useFakeTimers();
    const { rerender } = render(<WaitingFallback provider="claude" hooksOn={null} onOpenTerminal={() => {}} />);
    expect(screen.getByText(READING)).toBeTruthy();
    rerender(<WaitingFallback provider="claude" hooksOn={false} onOpenTerminal={() => {}} />);
    expect(screen.queryByText(READING)).toBeNull();
    expect(screen.getByText('Turn on Quick answers in Settings to answer here.')).toBeTruthy();
  });

  it('after 2 s with the switch still unknown, the fallback keeps its "turn on" line', () => {
    vi.useFakeTimers();
    render(<WaitingFallback provider="claude" hooksOn={null} onOpenTerminal={() => {}} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('Answer in the Terminal')).toBeTruthy();
    expect(screen.getByText('Turn on Quick answers in Settings to answer here.')).toBeTruthy();
  });

  // Quick answers is Claude-only: there is no prompt to read for Codex.
  it('shows the fallback card at once for Codex', () => {
    vi.useFakeTimers();
    render(<WaitingFallback provider="codex" hooksOn={true} onOpenTerminal={() => {}} />);
    expect(screen.queryByText(/Reading/)).toBeNull();
    expect(screen.getByText('Codex is waiting on you')).toBeTruthy();
    expect(screen.getByText('Answer in the Terminal')).toBeTruthy();
  });

  it('clears its timer when it unmounts early (the prompt arrived)', () => {
    vi.useFakeTimers();
    const { unmount } = render(<WaitingFallback provider="claude" hooksOn={true} onOpenTerminal={() => {}} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
