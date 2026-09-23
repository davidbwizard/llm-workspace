import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RailAttentionBar } from '../../src/renderer/components/RailAttentionBar.tsx';

// This component is deliberately the dumb half. Deciding WHICH row is off
// screen needs real layout and a real IntersectionObserver, neither of which
// jsdom has -- that half lives in SessionRail and is covered by the hand-test
// checklist, not by this file. What IS covered here is everything that can be
// got wrong without layout: the copy, the priority, the direction and the
// accessible name.
describe('RailAttentionBar', () => {
  it('names what is off screen rather than saying something generic', () => {
    render(<RailAttentionBar kind="waiting" label="server-new is waiting on you"
      direction="down" onGo={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toContain('server-new is waiting on you');
  });

  it('points DOWN with a down arrow', () => {
    const { container } = render(<RailAttentionBar kind="waiting" label="x"
      direction="down" onGo={vi.fn()} />);
    expect(container.querySelector('.railattn.down')).not.toBeNull();
    expect(container.querySelector('.railattn-arrow')?.textContent).toBe('↓');
  });

  // A bar pinned to the bottom while the row is ABOVE you sends you the wrong
  // way, which is worse than no bar at all.
  it('points UP with an up arrow when the row is above the fold', () => {
    const { container } = render(<RailAttentionBar kind="waiting" label="x"
      direction="up" onGo={vi.fn()} />);
    expect(container.querySelector('.railattn.up')).not.toBeNull();
    expect(container.querySelector('.railattn-arrow')?.textContent).toBe('↑');
  });

  it('carries the waiting treatment, not the unread one', () => {
    const { container } = render(<RailAttentionBar kind="waiting" label="x"
      direction="down" onGo={vi.fn()} />);
    expect(container.querySelector('.railattn.waiting')).not.toBeNull();
    expect(container.querySelector('.railattn.unread')).toBeNull();
  });

  it('carries the unread treatment when that is all there is', () => {
    const { container } = render(<RailAttentionBar kind="unread" label="x"
      direction="down" onGo={vi.fn()} />);
    expect(container.querySelector('.railattn.unread')).not.toBeNull();
    expect(container.querySelector('.railattn.waiting')).toBeNull();
  });

  it('is a real button, so it is reachable by keyboard', () => {
    render(<RailAttentionBar kind="waiting" label="x" direction="down" onGo={vi.fn()} />);
    expect(screen.getByRole('button').tagName).toBe('BUTTON');
  });

  it('calls back when clicked', () => {
    const onGo = vi.fn();
    render(<RailAttentionBar kind="waiting" label="x" direction="down" onGo={onGo} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onGo).toHaveBeenCalledTimes(1);
  });
});
