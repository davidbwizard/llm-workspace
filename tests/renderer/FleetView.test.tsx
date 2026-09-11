import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FleetView } from '../../src/renderer/components/FleetView.tsx';
import type { SessionState } from '../../src/fleet/state.ts';

// alive:false by default -- most fixtures in this file are about the
// needsAttention/history split, which predates process liveness and does
// not depend on it. Tests for the new middle ("Waiting for you") tier
// override alive:true explicitly.
const s = (o: Partial<SessionState>): SessionState => ({
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/r', project:'proj',
  lifecycle:'active', activity:'idle', stale:false, confidence:'guess',
  source:'transcript', lastProse:'done', lastActivityAt:'2026-09-10T12:00:00Z',
  agents:0, liveAgents:0, events:1, blocker:null, match:'unknown',
  candidates:[], host:null, alive:false, processAgeSeconds:null,
  processRssBytes:null, sharesWorktreeWith:[], ...o,
});

beforeEach(() => {
  (globalThis as any).window.fleet = {
    listFleet: vi.fn().mockResolvedValue({ version:1, generatedAt:'t', sessions:[
      s({ sessionId:'a', project:'trellome', activity:'working' }),
      s({ sessionId:'b', project:'chocabloc', activity:'idle' }),
    ]}),
    onFleet: vi.fn().mockReturnValue(() => {}),
  };
});

describe('FleetView', () => {
  it('lists the sessions it was given', async () => {
    // chocabloc is history (not alive), so it now starts inside the
    // collapsed History group rather than rendering on load -- expand the
    // group to confirm the session is present, not dropped. trellome is
    // live and still needs no interaction to appear.
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText('trellome')).toBeTruthy());
    expect(screen.queryByText('chocabloc')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText('chocabloc')).toBeTruthy());
  });

  it('subscribes to live updates and unsubscribes on unmount', async () => {
    const unsub = vi.fn();
    (globalThis as any).window.fleet.onFleet = vi.fn().mockReturnValue(unsub);
    const { unmount } = render(<FleetView />);
    await waitFor(() => expect((globalThis as any).window.fleet.onFleet).toHaveBeenCalled());
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('shows a real empty state rather than a blank panel', async () => {
    (globalThis as any).window.fleet.listFleet =
      vi.fn().mockResolvedValue({ version:1, generatedAt:'t', sessions:[] });
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText(/No sessions indexed yet/i)).toBeTruthy());
  });

  it('separates history sessions below a divider heading rather than hiding them', async () => {
    // A disconnected session populates the history group through the
    // lifecycle branch, deliberately not through "activity is idle" --
    // that keeps this test's failure mode distinct from the two grouping
    // tests below.
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[
        s({ sessionId:'a', project:'trellome', activity:'working' }),
        s({ sessionId:'b', project:'gonesoon', lifecycle:'disconnected', activity:'idle' }),
      ],
    });
    render(<FleetView />);
    // getByText(/History/i) would also match text elsewhere on the page --
    // getByRole targets the divider heading itself, not any text on the
    // page that happens to contain the word.
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy());
  });

  it('groups an active session with nothing happening below the divider, not above', async () => {
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[
        s({ sessionId:'q', project:'quietproj', lifecycle:'active', activity:'idle' }),
      ],
    });
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy());
    // No live group should render at all: the only session present is idle
    // and not alive, so it belongs in history, not the top tier.
    expect(container.querySelector('.fleet:not(.dim):not(.waiting)')).toBeNull();
    // quietproj is not alive, so it now needs the group expanded before it
    // renders; once expanded it belongs in the dim history group, not a
    // live one.
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText('quietproj')).toBeTruthy());
    expect(container.querySelector('.fleet.dim')?.textContent).toMatch(/quietproj/);
  });

  it('does not silently drop a disconnected session whose last known activity was working', async () => {
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[
        s({ sessionId:'g', project:'ghostproj', lifecycle:'disconnected', activity:'working', stale:true }),
      ],
    });
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy());
    expect(container.querySelector('.fleet:not(.dim):not(.waiting)')).toBeNull();
    // Reachable-and-working and disconnected-but-last-seen-working are not
    // the same thing: it renders once the history group is expanded, but
    // in the history group, not the live one.
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText('ghostproj')).toBeTruthy());
    expect(container.querySelector('.fleet.dim')?.textContent).toMatch(/ghostproj/);
  });

  it('shows a specific message when the preload did not load, instead of throwing', async () => {
    delete (globalThis as any).window.fleet;
    render(<FleetView />);
    expect(screen.getByText(/preload script did not load/i)).toBeTruthy();
  });

  it('shows the error instead of loading forever when the index fails to load', async () => {
    // The realistic case today: main has no 'fleet:list' handler registered
    // yet (Task 11), so ipcRenderer.invoke rejects rather than hanging.
    (globalThis as any).window.fleet.listFleet =
      vi.fn().mockRejectedValue(new Error("No handler registered for 'fleet:list'"));
    render(<FleetView />);
    await waitFor(() => expect(
      screen.getByText(/No handler registered for 'fleet:list'/)).toBeTruthy());
    expect(screen.queryByText(/Reading the index/i)).toBeNull();
  });

  it('keeps the "N active" chip in sync with what actually renders above the divider', async () => {
    // A mix that exercises the boundary between the two grouping
    // definitions: an active-but-quiet session and a stale-but-working
    // (disconnected) one are both not top-tier -- if the chip and the live
    // group ever counted different things, this fixture is where they'd
    // disagree. Neither is alive, so neither lands in the middle tier
    // either.
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[
        s({ sessionId:'a', project:'live1', activity:'working' }),
        s({ sessionId:'b', project:'live2', activity:'waiting_permission' }),
        s({ sessionId:'q', project:'quiet1', lifecycle:'active', activity:'idle' }),
        s({ sessionId:'g', project:'ghost1', lifecycle:'disconnected', activity:'working', stale:true }),
      ],
    });
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByText(/2 active/)).toBeTruthy());
    const liveCards = container.querySelectorAll('.fleet:not(.dim):not(.waiting) [role="button"]');
    expect(liveCards.length).toBe(2);
  });

  it('does not mount history session cards while the group is collapsed', async () => {
    // The bar this has to clear is "not mounted," not "not visible": a card
    // hidden with CSS would still satisfy a text-content check, so this
    // asserts directly against the DOM node count inside the history group
    // wrapper rather than against anything a stylesheet could fake.
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy());
    const group = container.querySelector('#history-group')!;
    expect(group).toBeTruthy();
    expect(group.querySelectorAll('[role="button"]').length).toBe(0);
    expect(screen.queryByText('chocabloc')).toBeNull();

    // Grab the toggle once, before any card is mounted: a card's own
    // accessible label includes its activity word ("idle"), which would
    // otherwise also match a role/name query for "History" once it renders.
    const toggle = screen.getByRole('button', { name:/History/i });

    fireEvent.click(toggle);
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(1));
    expect(screen.getByText('chocabloc')).toBeTruthy();

    // Collapsing again un-mounts it rather than leaving it hidden.
    fireEvent.click(toggle);
    expect(group.querySelectorAll('[role="button"]').length).toBe(0);
    expect(screen.queryByText('chocabloc')).toBeNull();
  });

  it('renders history cards in batches with a show-more control instead of all at once', async () => {
    const historySessions = Array.from({ length:130 }, (_, i) =>
      s({ sessionId:`idle-${i}`, project:`idleproj${i}`, activity:'idle' }));
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:historySessions,
    });
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/History 130/i })).toBeTruthy());
    const group = container.querySelector('#history-group')!;

    fireEvent.click(screen.getByRole('button', { name:/History 130/i }));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(60));
    expect(screen.getByText(/70 remaining/)).toBeTruthy();

    fireEvent.click(screen.getByText(/70 remaining/));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(120));
    expect(screen.getByText(/10 remaining/)).toBeTruthy();

    fireEvent.click(screen.getByText(/10 remaining/));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(130));
    // Every history session is now shown, so the control has nothing left to add.
    expect(screen.queryByText(/remaining/)).toBeNull();
  });

  it('exposes the history group as a keyboard-operable disclosure that announces its state', async () => {
    render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy());
    const toggle = screen.getByRole('button', { name:/History/i });

    // A real <button> element (not a div with a click handler) is what
    // makes this keyboard-operable at all: the browser turns Enter/Space
    // into a click for native buttons for free. jsdom does not simulate
    // that browser-native key-to-click translation, so the DOM shape is the
    // part this test can assert directly, and the click below is exactly
    // what that native translation produces.
    expect(toggle.tagName).toBe('BUTTON');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);

    // State is announced via aria-expanded, and aria-controls names a real,
    // already-present element -- not one that only appears after expanding.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId!)).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  // The tier that did not exist before this task: a session whose process
  // is confirmed alive (discovery, spec S7.1a) but at a turn boundary --
  // not working, not blocked. It is genuinely different from history (the
  // process is still running) and from the top tier (it needs nothing from
  // the user right now), so it gets its own always-visible group.
  describe('the middle "Waiting for you" tier', () => {
    it('shows an alive, quiet session in its own group -- not the top tier, not history', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[
          s({ sessionId:'w', project:'waitingproj', lifecycle:'active', activity:'idle', alive:true }),
        ],
      });
      const { container } = render(<FleetView />);
      await waitFor(() => expect(screen.getByRole('heading', { name:/Waiting for you/i })).toBeTruthy());
      // Rendered immediately -- no click needed, unlike history.
      expect(screen.getByText('waitingproj')).toBeTruthy();
      // Not in the top tier.
      expect(container.querySelector('.fleet:not(.dim):not(.waiting)')).toBeNull();
      // Not in history: the group is collapsed by default, and no history
      // heading renders at all since there is no non-alive session here.
      expect(screen.queryByRole('heading', { name:/History/i })).toBeNull();
    });

    it('counts the middle tier in its own heading', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[
          s({ sessionId:'w1', project:'w1proj', alive:true }),
          s({ sessionId:'w2', project:'w2proj', alive:true }),
        ],
      });
      render(<FleetView />);
      await waitFor(() => expect(screen.getByRole('heading', { name:/Waiting for you 2/i })).toBeTruthy());
    });

    it('does not double-count a working, alive session in the middle tier', async () => {
      // needsAttention is checked first: a working session that also
      // happens to be alive belongs only to the top tier.
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[
          s({ sessionId:'a', project:'trellome', activity:'working', alive:true }),
        ],
      });
      const { container } = render(<FleetView />);
      await waitFor(() => expect(screen.getByText('trellome')).toBeTruthy());
      expect(screen.queryByRole('heading', { name:/Waiting for you/i })).toBeNull();
      expect(container.querySelectorAll('[role="button"]').length).toBe(1);
    });

    it('shows process age and memory on a middle-tier card, but not on a top-tier one', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[
          s({ sessionId:'a', project:'workingproj', activity:'working', alive:true,
              processAgeSeconds: 9 * 86_400, processRssBytes: 206 * 1024 * 1024 }),
          s({ sessionId:'w', project:'waitingproj', lifecycle:'active', activity:'idle', alive:true,
              processAgeSeconds: 9 * 86_400, processRssBytes: 206 * 1024 * 1024 }),
        ],
      });
      render(<FleetView />);
      await waitFor(() => expect(screen.getByText('waitingproj')).toBeTruthy());
      // Exactly one card shows the process meta -- the middle-tier one.
      expect(screen.getAllByText(/206 MB/).length).toBe(1);
    });
  });
});
