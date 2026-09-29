import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MailBadges } from '../../src/renderer/components/MailBadge.tsx';

/** Option B of the "Fleet Mail badges" mockups: a plane on a sender's card,
 *  a tray on a reviewer's, and a dot for what is happening now. */
describe('MailBadges', () => {
  const badgeOf = (b: Parameters<typeof MailBadges>[0]['badges'][number]) =>
    render(<MailBadges badges={[b]} />).container.querySelector('.mailbadge')!;

  it('shows a sender its reviews, with a pulsing dot while one is written', () => {
    const b = badgeOf({ kind: 'sender', count: '×2', state: 'writing', tip: '2 reviews · codex-reviewer, pass 2 of 3, writing' });
    expect(b.getAttribute('title')).toBe('2 reviews · codex-reviewer, pass 2 of 3, writing');
    expect(b.classList.contains('sender')).toBe(true);
    expect(b.querySelector('.mailbadge-n')!.textContent).toBe('×2');
    expect(b.querySelector('.mailbadge-dot.writing')).not.toBeNull();
    expect(b.querySelector('svg')).not.toBeNull();
  });

  it('shows a new reply with a green dot', () => {
    expect(badgeOf({ kind: 'sender', count: '×1', state: 'fresh', tip: 't' }).querySelector('.mailbadge-dot.fresh')).not.toBeNull();
  });

  it('shows a reviewer its pass, and no dot when idle', () => {
    const b = badgeOf({ kind: 'reviewer', count: '1/3', state: 'idle', tip: 'Answered pass 1 of 3 for claude · app' });
    expect(b.classList.contains('reviewer')).toBe(true);
    expect(b.querySelector('.mailbadge-n')!.textContent).toBe('1/3');
    expect(b.querySelector('.mailbadge-dot')).toBeNull();
  });

  it('names the badge for screen readers, and draws nothing without badges', () => {
    expect(badgeOf({ kind: 'sender', count: '×1', state: 'idle', tip: '1 review · r, pass 1 of 3, approved' })
      .querySelector('.mailbadge-name')!.textContent).toBe('1 review · r, pass 1 of 3, approved');
    expect(render(<MailBadges badges={[]} />).container.innerHTML).toBe('');
  });
});
