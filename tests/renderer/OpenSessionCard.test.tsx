import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OpenSessionCard } from '../../src/renderer/components/OpenSessionCard.tsx';
import type { OpenSession } from '../../src/fleet/state.ts';
import type { KillResult } from '../../src/main/ipc.ts';

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

// Every test below that isn't specifically about the kill flow needs SOME
// onKill (it's a required prop -- FleetView always has a real
// window.fleet.killSession by the time it renders a card), but must never
// have it actually called: a vi.fn() left uncalled is exactly what proves
// that, and asserting it wasn't called is cheap insurance against a future
// regression that fires it too early.
function neverKill() {
  return vi.fn<(pid: number) => Promise<KillResult>>();
}

describe('OpenSessionCard', () => {
  it('shows pid, provider, project, cwd, host, age and memory even with no transcript match at all', () => {
    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={base} />);
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
    render(<OpenSessionCard state={base} onOpen={onOpen} onKill={neverKill()} />);
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
    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={base} />);
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('shows a Codex provider badge for a codex process', () => {
    const { container } = render(
      <OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={{ ...base, provider: 'codex' }} />,
    );
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(container.querySelector('.prov.codex')).not.toBeNull();
  });

  it('renders no last-message text when unmatched -- blank is honest, not a placeholder', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={base} />);
    expect(container.querySelector('.said')).toBeNull();
  });

  it('renders no working/waiting state word when unmatched', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={base} />);
    expect(container.querySelector('.state')).toBeNull();
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('renders no host text when host is classifyHost\'s own "unknown"', () => {
    const { container } = render(
      <OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={{ ...base, host: 'unknown' }} />,
    );
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
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={enriched} />);
      expect(screen.getByText(/Reused the JWT helper/)).toBeTruthy();
      expect(screen.getByText('9,129')).toBeTruthy();
      expect(screen.getByText('working')).toBeTruthy();
    });

    it('shows the blocked badge and wording when the matched session is waiting on the user', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
        state={{ ...enriched, activity: 'waiting_permission' }} />);
      expect(container.querySelector('.badge')).not.toBeNull();
      expect(screen.getByText(/waiting on you/)).toBeTruthy();
    });

    it('includes pid, project, provider, activity and last prose in the accessible name', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={enriched} />);
      const card = screen.getByRole('button', { name: /trellome/i });
      const label = card.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/pid 4242/);
      expect(label).toMatch(/Claude/);
      expect(label).toMatch(/working/);
      expect(label).toMatch(/Reused the JWT helper/);
    });
  });

  // The app's first destructive action. These prove: the signal is never
  // sent without an explicit confirmation step; every control is a real,
  // keyboard-operable <button>, not a div with a click handler; pressing
  // any of them never also opens the session (the card underneath is
  // itself a role="button"); and the confirmation names what is about to
  // end (project, source, age), per the brief this was built from.
  describe('closing a session', () => {
    const withProcMeta: OpenSession = { ...base }; // host: iterm2, age: 9d, memory: 206 MB

    // Deliberately NOT labelled with project/source/age here -- that
    // belongs on the confirmation (next test), not this button. This
    // button's name is short and pid-qualified precisely so it never
    // collides, in a name-based lookup, with the card's own role="button"
    // wrapper (whose accessible name DOES carry project/pid) -- see the
    // "never opens the session" test below for what that collision would
    // otherwise cause.
    it('shows a Close button that does not itself end anything', () => {
      const onKill = neverKill();
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
      const closeBtn = screen.getByRole('button', { name: /^Close, pid 4242/ });
      expect(closeBtn.tagName).toBe('BUTTON');
      fireEvent.click(closeBtn);
      expect(onKill).not.toHaveBeenCalled();
    });

    it('requires a second, explicit confirmation before sending any signal', () => {
      const onKill = neverKill();
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      // The confirmation is now showing -- but onKill still has not fired.
      expect(screen.getByRole('group')).toBeTruthy();
      expect(onKill).not.toHaveBeenCalled();
    });

    it('names project, source and age in the confirmation, so it is obvious which session is about to end', () => {
      const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      // Scoped to the confirm text specifically -- the card's own .proj
      // ("trellome") and .path ("/Users/me/trellome") already contain
      // some of these words unrelated to the confirmation, so a
      // page-wide text search would pass even if the confirmation itself
      // said nothing at all.
      const confirmText = container.querySelector('.kill-confirm-text')?.textContent ?? '';
      expect(confirmText).toMatch(/trellome/);
      expect(confirmText).toMatch(/iTerm2/);
      expect(confirmText).toMatch(/9d/);
    });

    it('cancels back to the Close button without ever calling onKill', () => {
      const onKill = neverKill();
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
      expect(screen.getByRole('button', { name: /^Close/ })).toBeTruthy();
      expect(onKill).not.toHaveBeenCalled();
    });

    // The safe default: an accidental second Enter/Space after the Close
    // press lands on Cancel, not on the destructive action.
    it('focuses Cancel, not End session, when the confirmation appears', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Cancel/ }));
    });

    it('sends the signal only once "End session" is pressed, with this card\'s pid', async () => {
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>().mockResolvedValue({ status: 'killed' });
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      await waitFor(() => expect(onKill).toHaveBeenCalledTimes(1));
      expect(onKill).toHaveBeenCalledWith(4242);
    });

    it('announces "Ending session…" via an aria-live region while the call is in flight', async () => {
      let resolveKill!: (r: KillResult) => void;
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>()
        .mockReturnValue(new Promise(res => { resolveKill = res; }));
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      const status = await screen.findByText(/Ending session/);
      expect(status.getAttribute('aria-live')).toBe('polite');
      // Resolved and drained before the test ends -- otherwise this
      // promise's continuation (doKill's post-await setState calls)
      // fires after the test has already moved on, outside any act()
      // wrapper.
      resolveKill({ status: 'killed' });
      await waitFor(() => expect(screen.getByText(/Signal sent/)).toBeTruthy());
    });

    it('shows a settled status after a successful kill, then returns to the Close button on its own', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const onKill = vi.fn<(pid: number) => Promise<KillResult>>().mockResolvedValue({ status: 'killed' });
        render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
        fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
        fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
        await waitFor(() => expect(screen.getByText(/Signal sent/)).toBeTruthy());
        await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
        expect(screen.getByRole('button', { name: /^Close/ })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows a refusal message and a Dismiss control when main refuses the kill, without throwing', async () => {
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>()
        .mockResolvedValue({ status: 'refused', reason: 'not_discovered' });
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      const status = await screen.findByText(/no longer running/i);
      expect(status.getAttribute('aria-live')).toBe('polite');
      fireEvent.click(screen.getByRole('button', { name: /^Dismiss/ }));
      expect(screen.getByRole('button', { name: /^Close/ })).toBeTruthy();
    });

    it('shows a generic error, not a crash, when the kill call itself rejects', async () => {
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>().mockRejectedValue(new Error('IPC gone'));
      render(<OpenSessionCard onOpen={() => {}} onKill={onKill} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      expect(await screen.findByText(/Could not reach the app/i)).toBeTruthy();
    });

    // The regression this whole kill row has to avoid: it lives inside the
    // card's own role="button" wrapper (clicking the CARD opens the
    // session), so every click here must stop there, not bubble up.
    it('never opens the session when Close, Cancel or End session is clicked', () => {
      const onOpen = vi.fn();
      const onKill = vi.fn<(pid: number) => Promise<KillResult>>()
        .mockReturnValue(new Promise(() => {})); // never resolves -- only the call matters here
      render(<OpenSessionCard onOpen={onOpen} onKill={onKill} state={withProcMeta} />);
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Close/ }));
      fireEvent.click(screen.getByRole('button', { name: /^End session/ }));
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('never opens the session on Enter/Space at the Close button either', () => {
      const onOpen = vi.fn();
      render(<OpenSessionCard onOpen={onOpen} onKill={neverKill()} state={withProcMeta} />);
      const closeBtn = screen.getByRole('button', { name: /^Close/ });
      fireEvent.keyDown(closeBtn, { key: 'Enter' });
      expect(onOpen).not.toHaveBeenCalled();
    });
  });
});
