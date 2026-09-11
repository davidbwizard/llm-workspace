import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OpenSessionCard } from '../../src/renderer/components/OpenSessionCard.tsx';
import type { OpenSession } from '../../src/fleet/state.ts';

// The model correction: one card per live process, "ALL OPEN SESSIONS
// should show. And the source." Unmatched by default -- most tests below
// override only what they're testing, so the base fixture pins the common
// outcome on a real, shared-cwd workspace: no unique transcript match, but
// provider (and pid/host/cwd/age/memory) still fully known, since those
// come from the process itself, never from a match.
const base: OpenSession = {
  pid: 4242, provider: 'claude', host: 'iterm2', cwd: '/Users/me/trellome', project: 'trellome',
  ageSeconds: 9 * 86_400, rssBytes: 206 * 1024 * 1024, match: 'unknown',
  sessionId: null, lastProse: null, events: null, activity: null,
};

describe('OpenSessionCard', () => {
  it('shows pid, provider, project, cwd, host, age and memory even with no transcript match at all', () => {
    render(<OpenSessionCard onOpen={() => {}} state={base} />);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.getByText('/Users/me/trellome')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('iTerm2')).toBeTruthy();
    expect(screen.getByText(/9d/)).toBeTruthy();
    expect(screen.getByText(/206 MB/)).toBeTruthy();
    expect(screen.getByText(/pid 4242/)).toBeTruthy();
  });

  it('is operable by keyboard and mouse, passing pid to onOpen every time', () => {
    const onOpen = vi.fn();
    render(<OpenSessionCard state={base} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    // Checked call by call, not with toHaveBeenCalledWith (an "any call
    // matches" check) -- that would stay green even if only the click
    // handler, say, passed the wrong pid while the two keyboard paths were
    // still correct.
    expect(onOpen.mock.calls).toEqual([[4242], [4242], [4242]]);
  });

  // provider is not enrichment: it comes straight from the process
  // (LiveProcess.provider, set at discovery time -- see src/fleet/state.ts's
  // openSessions doc comment), so it shows even when this card has no
  // transcript match at all -- unlike lastProse/activity below, which
  // genuinely are match-gated.
  it('shows the provider badge even when the process could not be matched to any session', () => {
    render(<OpenSessionCard onOpen={() => {}} state={base} />);
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('shows a Codex provider badge for a codex process', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} state={{ ...base, provider:'codex' }} />);
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(container.querySelector('.prov.codex')).not.toBeNull();
  });

  it('renders no last-message text when unmatched -- blank is honest, not a placeholder', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} state={base} />);
    expect(container.querySelector('.said')).toBeNull();
  });

  it('renders no working/waiting state word when unmatched', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} state={base} />);
    expect(container.querySelector('.state')).toBeNull();
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('renders no host text when host is classifyHost\'s own "unknown"', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} state={{ ...base, host: 'unknown' }} />);
    expect(container.querySelector('.host')).toBeNull();
  });

  // Enrichment (lastProse/events/activity) appears only on a unique
  // transcript match -- src/fleet/state.ts's openSessions doc comment.
  // provider is deliberately NOT part of this fixture's point: it is set
  // on `base` too, unconditionally -- see the tests above.
  describe('enrichment on a unique match', () => {
    const enriched: OpenSession = {
      ...base, match: 'unique', sessionId: 's1',
      lastProse: 'Reused the JWT helper.', events: 9129, activity: 'working',
    };

    it('shows last prose, events and the working state', () => {
      render(<OpenSessionCard onOpen={() => {}} state={enriched} />);
      expect(screen.getByText(/Reused the JWT helper/)).toBeTruthy();
      expect(screen.getByText('9,129')).toBeTruthy();
      expect(screen.getByText('working')).toBeTruthy();
    });

    it('shows the blocked badge and wording when the matched session is waiting on the user', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}}
        state={{ ...enriched, activity: 'waiting_permission' }} />);
      expect(container.querySelector('.badge')).not.toBeNull();
      expect(screen.getByText(/waiting on you/)).toBeTruthy();
    });

    it('includes pid, project, provider, activity and last prose in the accessible name', () => {
      render(<OpenSessionCard onOpen={() => {}} state={enriched} />);
      const card = screen.getByRole('button', { name: /trellome/i });
      const label = card.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/pid 4242/);
      expect(label).toMatch(/Claude/);
      expect(label).toMatch(/working/);
      expect(label).toMatch(/Reused the JWT helper/);
    });
  });
});
