import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FleetView } from '../../src/renderer/components/FleetView.tsx';
import type { SessionState, OpenSession } from '../../src/fleet/state.ts';

// A transcript-session fixture. Used only for History now: History is
// every transcript session, unfiltered (see FleetView.tsx) -- none of
// these fields decide WHERE a card lands the way lifecycle/alive used to
// before the model correction ("ALL OPEN SESSIONS should show. And the
// source. So I can close if they are actually dead" -- the top tier now
// enumerates from live processes, not from transcripts).
const s = (o: Partial<SessionState>): SessionState => ({
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/r', project:'proj',
  lifecycle:'active', activity:'idle', stale:false, confidence:'guess',
  source:'transcript', lastProse:'done', lastActivityAt:'2026-09-10T12:00:00Z',
  agents:0, liveAgents:0, events:1, blocker:null, match:'unknown',
  candidates:[], host:null, alive:false, processAgeSeconds:null,
  processRssBytes:null, sharesWorktreeWith:[], ...o,
});

// An open-process fixture -- unmatched to any transcript session by
// default, which is the common outcome on a shared-cwd repo (see
// openSessions' doc comment in src/fleet/state.ts): most open cards in
// practice will NOT have a uniquely-matched session. `provider` is set
// regardless -- unlike sessionId/lastProse/events/activity, it comes
// straight from the process, never from a match, so it is never null.
const o = (over: Partial<OpenSession>): OpenSession => ({
  pid:1, provider:'claude', host:'unknown', cwd:'/r', project:'proj', ageSeconds:60, rssBytes:null,
  match:'unknown', sessionId:null, lastProse:null, events:null,
  activity:null, ...over,
});

beforeEach(() => {
  (globalThis as any).window.fleet = {
    listFleet: vi.fn().mockResolvedValue({ version:1, generatedAt:'t', sessions:[
      s({ sessionId:'a', project:'trellome' }),
      s({ sessionId:'b', project:'chocabloc' }),
    ], openSessions:[
      o({ pid:1, project:'trellome' }),
    ]}),
    onFleet: vi.fn().mockReturnValue(() => {}),
  };
});

describe('FleetView', () => {
  it('shows open sessions immediately, and history only once expanded', async () => {
    // trellome is open (process-enumerated) AND has transcript history;
    // chocabloc has transcript history only (no matching open process) --
    // the two enumerations are independent, not mutually exclusive.
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText('trellome')).toBeTruthy());
    expect(screen.queryByText('chocabloc')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText('chocabloc')).toBeTruthy());
    // trellome now renders twice: once as its open card (always shown),
    // once as its history card (History is unfiltered, spec S7.1a) --
    // intentional duplication, not a bug.
    expect(screen.getAllByText('trellome')).toHaveLength(2);
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
      vi.fn().mockResolvedValue({ version:1, generatedAt:'t', sessions:[], openSessions:[] });
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText(/No sessions indexed yet/i)).toBeTruthy());
  });

  // A process can be open before its first transcript event is ingested --
  // a brief window, but spec S7.1a's "never lost" promise has to hold from
  // the moment a process starts, not from its first indexed event. Checking
  // `sessions` alone for the empty state would hide a genuinely open
  // session behind "No sessions indexed yet".
  it('shows an open session even when nothing has been indexed to transcripts yet', async () => {
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[], openSessions:[o({ pid:9, project:'brandnew' })],
    });
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText('brandnew')).toBeTruthy());
    expect(screen.queryByText(/No sessions indexed yet/i)).toBeNull();
  });

  it('separates history below a divider heading rather than hiding it', async () => {
    render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy());
  });

  // History is unfiltered: it does not matter whether a session is
  // lifecycle 'active' or 'disconnected', last-known working or idle --
  // every transcript session shows there once expanded.
  it('does not silently drop a disconnected session whose last known activity was working', async () => {
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:[
        s({ sessionId:'g', project:'ghostproj', lifecycle:'disconnected', activity:'working', stale:true }),
      ], openSessions:[],
    });
    render(<FleetView />);
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText('ghostproj')).toBeTruthy());
    expect(screen.getByText('ghostproj')).toBeTruthy();
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
    // Both sessions (trellome and chocabloc) are in the payload's
    // `sessions`, so both mount once expanded -- History is unfiltered.
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(2));
    expect(screen.getByText('chocabloc')).toBeTruthy();

    // Collapsing again un-mounts it rather than leaving it hidden.
    fireEvent.click(toggle);
    expect(group.querySelectorAll('[role="button"]').length).toBe(0);
    expect(screen.queryByText('chocabloc')).toBeNull();
  });

  it('renders history cards in batches with a show-more control instead of all at once', async () => {
    const historySessions = Array.from({ length:130 }, (_, i) =>
      s({ sessionId:`idle-${i}`, project:`idleproj${i}` }));
    (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
      version:1, generatedAt:'t', sessions:historySessions, openSessions:[],
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

  // The model correction: the top tier enumerates from live PROCESSES
  // (discovery, spec S7.1a), not from transcript recency. "He has 15 live
  // agent processes. Every one is a session he could switch to, and every
  // one should get a card no matter when its transcript was last written."
  describe('Open sessions', () => {
    it('shows every open session immediately -- no click needed, unlike History', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[], openSessions:[
          o({ pid:1, project:'one' }), o({ pid:2, project:'two' }), o({ pid:3, project:'three' }),
        ],
      });
      const { container } = render(<FleetView />);
      await waitFor(() => expect(screen.getByText('one')).toBeTruthy());
      expect(screen.getByText('two')).toBeTruthy();
      expect(screen.getByText('three')).toBeTruthy();
      // Not inside the collapsed history group.
      expect(container.querySelector('#history-group [role="button"]')).toBeNull();
    });

    // A session opened nine days ago and never touched since is still
    // open -- transcript recency (`sessions`) plays no part in this list.
    it('shows an open session that has no matching transcript session at all', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[s({ sessionId:'unrelated', project:'unrelated' })],
        openSessions:[o({ pid:7, project:'orphaned', match:'unknown', sessionId:null })],
      });
      render(<FleetView />);
      await waitFor(() => expect(screen.getByText('orphaned')).toBeTruthy());
    });

    it('counts open sessions in the "N open" chip', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[], openSessions:[
          o({ pid:1, project:'one' }), o({ pid:2, project:'two' }),
        ],
      });
      render(<FleetView />);
      await waitFor(() => expect(screen.getByText(/2 open/)).toBeTruthy());
    });

    it('counts only open sessions blocked on the user in the "need you" chip', async () => {
      // Two blocked (one on each blocking activity), one merely working,
      // one unknown state -- counts diverge under any predicate that
      // confuses "blocked" with "working" or "known", so this pins the
      // exact set, not just a count that could coincidentally match.
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[], openSessions:[
          o({ pid:1, project:'blocked-perm', activity:'waiting_permission' }),
          o({ pid:2, project:'blocked-input', activity:'waiting_input' }),
          o({ pid:3, project:'working', activity:'working' }),
          o({ pid:4, project:'unknown-state', activity:null }),
        ],
      });
      render(<FleetView />);
      await waitFor(() => expect(screen.getByText(/4 open/)).toBeTruthy());
      expect(screen.getByText(/2 need you/)).toBeTruthy();
    });

    it('shows no "need you" chip when nothing is blocked', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[], openSessions:[o({ pid:1, project:'one' })],
      });
      render(<FleetView />);
      await waitFor(() => expect(screen.getByText(/1 open/)).toBeTruthy());
      expect(screen.queryByText(/need you/)).toBeNull();
    });

    it('shows a real empty message, not a blank gap, when nothing is open', async () => {
      (globalThis as any).window.fleet.listFleet = vi.fn().mockResolvedValue({
        version:1, generatedAt:'t', sessions:[s({ sessionId:'a', project:'trellome' })], openSessions:[],
      });
      render(<FleetView />);
      await waitFor(() => expect(screen.getByText(/No open sessions right now/i)).toBeTruthy());
      expect(screen.getByText(/0 open/)).toBeTruthy();
    });
  });
});
