import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FleetView } from '../../src/renderer/components/FleetView.tsx';
import type { SessionState } from '../../src/fleet/state.ts';

const s = (o: Partial<SessionState>): SessionState => ({
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/r', project:'proj',
  lifecycle:'active', activity:'idle', stale:false, confidence:'guess',
  source:'transcript', lastProse:'done', lastActivityAt:'2026-09-10T12:00:00Z',
  agents:0, liveAgents:0, events:1, blocker:null, match:'unknown',
  candidates:[], host:null, sharesWorktreeWith:[], ...o,
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
    // chocabloc is idle, so it now starts inside the collapsed idle group
    // rather than rendering on load -- expand the group to confirm the
    // session is present, not dropped. trellome is live and still needs no
    // interaction to appear.
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText('trellome')).toBeTruthy());
    expect(screen.queryByText('chocabloc')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name:/Idle/i }));
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

  it('separates idle sessions below a divider heading rather than hiding them', async () => {
    // A disconnected session populates the idle group through the lifecycle
    // branch, deliberately not through "activity is idle" -- that keeps
    // this test's failure mode distinct from the two grouping tests below.
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[
        s({ sessionId:'a', project:'trellome', activity:'working' }),
        s({ sessionId:'b', project:'gonesoon', lifecycle:'disconnected', activity:'idle' }),
      ],
    });
    render(<FleetView />);
    // getByText(/Idle/i) would also match the plain word "idle" inside the
    // second card's own activity label ("idle") -- getByRole targets the
    // divider heading itself, not any text on the page that happens to
    // contain the word.
    await waitFor(() => expect(screen.getByRole('heading', { name:/Idle/i })).toBeTruthy());
  });

  it('groups an active session with nothing happening below the divider, not above', async () => {
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[
        s({ sessionId:'q', project:'quietproj', lifecycle:'active', activity:'idle' }),
      ],
    });
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/Idle/i })).toBeTruthy());
    // No live group should render at all: the only session present is idle.
    expect(container.querySelector('.fleet:not(.dim)')).toBeNull();
    // quietproj is idle, so it now needs the group expanded before it
    // renders; once expanded it belongs in the dim group, not a live one.
    fireEvent.click(screen.getByRole('button', { name:/Idle/i }));
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
    await waitFor(() => expect(screen.getByRole('heading', { name:/Idle/i })).toBeTruthy());
    expect(container.querySelector('.fleet:not(.dim)')).toBeNull();
    // Reachable-and-working and disconnected-but-last-seen-working are not
    // the same thing: it renders once the idle group is expanded, but in
    // the idle group, not the live one.
    fireEvent.click(screen.getByRole('button', { name:/Idle/i }));
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
    // (disconnected) one are both idle, not live -- if the chip and the
    // live group ever counted different things, this fixture is where
    // they'd disagree.
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
    const liveCards = container.querySelectorAll('.fleet:not(.dim) [role="button"]');
    expect(liveCards.length).toBe(2);
  });

  it('does not mount idle session cards while the group is collapsed', async () => {
    // The bar this has to clear is "not mounted," not "not visible": a card
    // hidden with CSS would still satisfy a text-content check, so this
    // asserts directly against the DOM node count inside the idle group
    // wrapper rather than against anything a stylesheet could fake.
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/Idle/i })).toBeTruthy());
    const group = container.querySelector('#idle-group')!;
    expect(group).toBeTruthy();
    expect(group.querySelectorAll('[role="button"]').length).toBe(0);
    expect(screen.queryByText('chocabloc')).toBeNull();

    // Grab the toggle once, before any card is mounted: a card's own
    // accessible label includes its activity word ("idle"), which would
    // otherwise also match a role/name query for "Idle" once it renders.
    const toggle = screen.getByRole('button', { name:/Idle/i });

    fireEvent.click(toggle);
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(1));
    expect(screen.getByText('chocabloc')).toBeTruthy();

    // Collapsing again un-mounts it rather than leaving it hidden.
    fireEvent.click(toggle);
    expect(group.querySelectorAll('[role="button"]').length).toBe(0);
    expect(screen.queryByText('chocabloc')).toBeNull();
  });

  it('renders idle cards in batches with a show-more control instead of all at once', async () => {
    const idleSessions = Array.from({ length:130 }, (_, i) =>
      s({ sessionId:`idle-${i}`, project:`idleproj${i}`, activity:'idle' }));
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:idleSessions,
    });
    const { container } = render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/Idle 130/i })).toBeTruthy());
    const group = container.querySelector('#idle-group')!;

    fireEvent.click(screen.getByRole('button', { name:/Idle 130/i }));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(60));
    expect(screen.getByText(/70 remaining/)).toBeTruthy();

    fireEvent.click(screen.getByText(/70 remaining/));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(120));
    expect(screen.getByText(/10 remaining/)).toBeTruthy();

    fireEvent.click(screen.getByText(/10 remaining/));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(130));
    // Every idle session is now shown, so the control has nothing left to add.
    expect(screen.queryByText(/remaining/)).toBeNull();
  });

  it('exposes the idle group as a keyboard-operable disclosure that announces its state', async () => {
    render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/Idle/i })).toBeTruthy());
    const toggle = screen.getByRole('button', { name:/Idle/i });

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
});
