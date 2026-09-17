import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { WorkingStrip, elapsed } from '../../src/renderer/components/WorkingStrip.tsx';

describe('WorkingStrip', () => {
  it('names the agent that is working', () => {
    render(<WorkingStrip provider="codex" since={null} />);
    expect(screen.getByText('Codex is working')).toBeTruthy();
  });

  it('counts up from the start of the work', () => {
    const since = Date.now() - 14_000;
    render(<WorkingStrip provider="claude" since={since} />);
    expect(screen.getByText('14s')).toBeTruthy();
  });

  it('shows no timer when the start is unknown', () => {
    const { container } = render(<WorkingStrip provider="claude" since={null} />);
    expect(container.querySelector('.strip .secs')).toBe(null);
  });

  it('formats minutes and hours', () => {
    expect(elapsed(14_000)).toBe('14s');
    expect(elapsed(125_000)).toBe('2m 5s');
    expect(elapsed(3_780_000)).toBe('1h 3m');
  });

  it('announces the words once, and not the ticking timer', () => {
    const { container } = render(<WorkingStrip provider="claude" since={Date.now()} />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Claude is working');
    expect(container.querySelector('.secs')?.getAttribute('aria-hidden')).toBe('true');
  });

  // The interval is the part none of the tests above actually exercise --
  // every one of them reads the DOM immediately after a single render, so
  // an implementation that never scheduled anything at all would still
  // pass every one. These pin the ticking itself: it advances the shown
  // time, it never runs when there is nothing to count, and it is cleared
  // rather than left leaking once the strip is gone.
  describe('the ticking interval', () => {
    it('ticks the shown time forward once a second while there is something to count', () => {
      vi.useFakeTimers();
      try {
        const since = Date.now();
        render(<WorkingStrip provider="claude" since={since} />);
        expect(screen.getByText('0s')).toBeTruthy();
        act(() => { vi.advanceTimersByTime(2_000); });
        expect(screen.getByText('2s')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts no interval at all when the start is unknown', () => {
      const setSpy = vi.spyOn(globalThis, 'setInterval');
      render(<WorkingStrip provider="claude" since={null} />);
      expect(setSpy).not.toHaveBeenCalled();
      setSpy.mockRestore();
    });

    it('clears its interval on unmount, rather than leaking a timer per strip', () => {
      const setSpy = vi.spyOn(globalThis, 'setInterval');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const { unmount } = render(<WorkingStrip provider="claude" since={Date.now()} />);
      const id = setSpy.mock.results[0]?.value;
      unmount();
      expect(clearSpy).toHaveBeenCalledWith(id);
      setSpy.mockRestore();
      clearSpy.mockRestore();
    });
  });
});
