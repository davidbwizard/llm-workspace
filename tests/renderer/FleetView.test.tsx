import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { FleetView } from '../../src/renderer/components/FleetView.tsx';
import type { SessionState, OpenSession } from '../../src/fleet/state.ts';
import type { FleetListPayload } from '../../src/main/ipc.ts';
import { setSettings, reloadSettings } from '../../src/renderer/state/settings.ts';

// A transcript-session fixture. Used only for History now: History is
// every transcript session, unfiltered (see FleetView.tsx) -- none of
// these fields decide WHERE a card lands the way lifecycle/alive used to
// before the model correction ("ALL OPEN SESSIONS should show. And the
// source" -- the top tier now enumerates from live processes, not from
// transcripts).
const s = (o: Partial<SessionState>): SessionState => ({
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/r', project:'proj',
  lifecycle:'active', activity:'idle', stale:false, confidence:'guess',
  source:'transcript', lastProse:'done', lastActivityAt:'2026-09-10T12:00:00Z',
  agents:0, liveAgents:0, events:1, blocker:null, match:'unknown',
  candidates:[], host:null, alive:false, processAgeSeconds:null,
  processRssBytes:null, sharesWorktreeWith:[], ...o,
});

// An open-process fixture -- unmatched to any transcript session by
// default, which is the ONLY outcome fleet:list's payload ever carries
// now (buildFleetListPayload, src/main/ipc.ts, never matches against a
// transcript at all): match/sessionId/lastProse/events/activity stay at
// these defaults on every real open card, not only as a common case.
// `provider` is set regardless -- it comes straight from the process,
// never from a match, so it is never null.
const o = (over: Partial<OpenSession>): OpenSession => ({
  pid:1, provider:'claude', host:'unknown', cwd:'/r', project:'proj', ageSeconds:60, rssBytes:null,
  match:'unknown', sessionId:null, lastProse:null, events:null,
  activity:null, tmux:false, junk:false, ...over,
});

// Task 7 hoisted the fleet:list fetch/subscription out of FleetView into
// useFleet.ts (tests/renderer/useFleet.test.tsx now covers that fetch,
// its rejection handling, and the live-update subscription). FleetView is
// rendered directly with a payload here, the same shape useFleet would
// have handed it -- not through a mocked window.fleet.listFleet/onFleet,
// which no longer drives this component at all.
const payload = (openSessions: OpenSession[]): FleetListPayload =>
  ({ version: 1, generatedAt: 't', openSessions });

// A small fixed "corpus" History pagination tests slice against, so the
// mock's behaviour (return the requested offset/limit window, plus the
// true total) mirrors what src/main/ipc.ts's buildFleetHistoryPayload
// actually does, rather than just returning a canned response regardless
// of arguments.
const defaultHistory = [s({ sessionId:'a', project:'trellome' }), s({ sessionId:'b', project:'chocabloc' })];

function pagedHistory(all: SessionState[]) {
  return vi.fn(async (offset: number, limit: number) => ({
    version:1 as const, generatedAt:'t', sessions: all.slice(offset, offset + limit), total: all.length,
  }));
}

// FleetView still reaches window.fleet directly for kill/reveal (per open
// card) and for History's own fetch/paging -- none of that moved to
// useFleet.ts, so it still needs a live mock here.
beforeEach(() => {
  (globalThis as any).window.fleet = {
    listHistory: pagedHistory(defaultHistory),
    killSession: vi.fn().mockResolvedValue({ status: 'killed' }),
    revealSession: vi.fn().mockResolvedValue({ status: 'revealed' }),
    reattach: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
    resume: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
  };
  localStorage.clear();
  reloadSettings();
});

describe('FleetView', () => {
  it('shows open sessions immediately, and history only once expanded', async () => {
    // trellome is open (process-enumerated) AND has transcript history;
    // chocabloc has transcript history only (no matching open process) --
    // the two enumerations are independent, not mutually exclusive.
    render(<FleetView payload={payload([o({ pid:1, project:'trellome' })])} error={null} onSelect={() => {}} />);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.queryByText('chocabloc')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText('chocabloc')).toBeTruthy());
    // trellome now renders twice: once as its open card (always shown),
    // once as its history card (History is unfiltered, spec S7.1a) --
    // intentional duplication, not a bug.
    expect(screen.getAllByText('trellome')).toHaveLength(2);
  });

  it('reports the pid to onSelect when an open card is chosen', async () => {
    const onSelect = vi.fn();
    render(<FleetView payload={payload([o({ pid:1, project:'trellome' })])} error={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('trellome'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('shows a real empty message, not a blank panel, when nothing is open', async () => {
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    expect(screen.getByText(/No open sessions right now/i)).toBeTruthy();
    expect(screen.getByText(/0 open/)).toBeTruthy();
  });

  // Whether History has anything at all is itself something the app only
  // learns by asking (David's correction: nothing history-related is
  // computed before that) -- so, unlike before this task, there is no
  // top-level "nothing indexed yet" message that can be shown without
  // fetching. Expanding an empty History shows this INSIDE the section
  // instead.
  it('shows "No history yet" inside the expanded section when History is genuinely empty', async () => {
    (globalThis as any).window.fleet.listHistory = pagedHistory([]);
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    expect(screen.getByText(/No open sessions right now/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText(/No history yet/i)).toBeTruthy());
  });

  // A process can be open before its first transcript event is ingested --
  // a brief window, but spec S7.1a's "never lost" promise has to hold from
  // the moment a process starts, not from its first indexed event.
  it('shows an open session even when nothing has been indexed to transcripts yet', async () => {
    render(<FleetView payload={payload([o({ pid:9, project:'brandnew' })])} error={null} onSelect={() => {}} />);
    expect(screen.getByText('brandnew')).toBeTruthy();
  });

  it('separates history below a divider heading rather than hiding it', async () => {
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { name:/History/i })).toBeTruthy();
  });

  // David's correction goes further than the original brief: nothing
  // history-related is computed or sent until History is actually
  // expanded -- not even a count. The heading shows no number until then.
  it('shows no history count until History has actually been expanded and fetched', async () => {
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    const heading = screen.getByRole('heading', { name:/History/i });
    expect(heading.textContent?.trim()).toBe('History');
    expect((globalThis as any).window.fleet.listHistory).not.toHaveBeenCalled();
  });

  it('fetches history only once, with offset 0, the instant History is expanded', async () => {
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect((globalThis as any).window.fleet.listHistory).toHaveBeenCalledTimes(1));
    expect((globalThis as any).window.fleet.listHistory).toHaveBeenCalledWith(0, 60);
  });

  // History is unfiltered: it does not matter whether a session is
  // lifecycle 'active' or 'disconnected', last-known working or idle --
  // every transcript session shows there once expanded and fetched.
  it('does not silently drop a disconnected session whose last known activity was working', async () => {
    (globalThis as any).window.fleet.listHistory = pagedHistory(
      [s({ sessionId:'g', project:'ghostproj', lifecycle:'disconnected', activity:'working', stale:true })]);
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(screen.getByText('ghostproj')).toBeTruthy());
  });

  // FleetView still guards window.fleet itself (it calls killSession/
  // revealSession/listHistory on it directly) -- this check runs even when
  // an `error` prop is also set, and takes priority: the specific preload
  // message, not the generic "index could not be loaded" text built from
  // whatever error string useFleet produced for the same underlying cause.
  it('shows a specific message when the preload did not load, instead of throwing', async () => {
    delete (globalThis as any).window.fleet;
    render(<FleetView payload={null} error="bridge unavailable" onSelect={() => {}} />);
    expect(screen.getByText(/preload script did not load/i)).toBeTruthy();
    expect(screen.queryByText(/bridge unavailable/i)).toBeNull();
  });

  it('shows the error instead of loading forever when the index fails to load', async () => {
    // The error prop is exactly what useFleet.ts now produces from a
    // rejected fleet:list call (see tests/renderer/useFleet.test.tsx) --
    // FleetView's own job is just to render it instead of hanging on
    // "Reading the index...".
    render(<FleetView payload={null} error="No handler registered for 'fleet:list'" onSelect={() => {}} />);
    expect(screen.getByText(/No handler registered for 'fleet:list'/)).toBeTruthy();
    expect(screen.queryByText(/Reading the index/i)).toBeNull();
  });

  it('shows the loading message while payload has not arrived yet and there is no error', async () => {
    render(<FleetView payload={null} error={null} onSelect={() => {}} />);
    expect(screen.getByText(/Reading the index/i)).toBeTruthy();
  });

  // fleet:history gets the exact same discipline fleet:list already has
  // (see the test above): a rejected fetch must surface a specific,
  // visible message -- never an empty list that could be mistaken for a
  // genuine "no history" ("No history yet", above), and never an endless
  // "Loading history..." with the real cause only in devtools.
  it('shows an error, not an empty-looking list, when the history fetch fails', async () => {
    (globalThis as any).window.fleet.listHistory =
      vi.fn().mockRejectedValue(new Error("No handler registered for 'fleet:history'"));
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(
      screen.getByText(/No handler registered for 'fleet:history'/)).toBeTruthy());
    expect(screen.queryByText(/Loading history/i)).toBeNull();
    expect(screen.queryByText(/No history yet/i)).toBeNull();
  });

  it('does not mount history session cards while the group is collapsed', async () => {
    // The bar this has to clear is "not mounted," not "not visible": a card
    // hidden with CSS would still satisfy a text-content check, so this
    // asserts directly against the DOM node count inside the history group
    // wrapper rather than against anything a stylesheet could fake.
    const { container } = render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    const group = container.querySelector('#history-group')!;
    expect(group).toBeTruthy();
    expect(group.querySelectorAll('[role="button"]').length).toBe(0);
    expect(screen.queryByText('chocabloc')).toBeNull();
    expect((globalThis as any).window.fleet.listHistory).not.toHaveBeenCalled();

    // Grab the toggle once, before any card is mounted: a card's own
    // accessible label includes its activity word ("idle"), which would
    // otherwise also match a role/name query for "History" once it renders.
    const toggle = screen.getByRole('button', { name:/History/i });

    fireEvent.click(toggle);
    // Both sessions (trellome and chocabloc) are in History, so both mount
    // once expanded and fetched -- History is unfiltered.
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(2));
    expect(screen.getByText('chocabloc')).toBeTruthy();

    // Collapsing again un-mounts it rather than leaving it hidden.
    fireEvent.click(toggle);
    expect(group.querySelectorAll('[role="button"]').length).toBe(0);
    expect(screen.queryByText('chocabloc')).toBeNull();
  });

  // The property the original brief got wrong: batching used to be a
  // client-side .slice() over an already-fully-built array. Now each
  // "page" is a real, separate fleet:history call -- proven here by a
  // corpus of 130 that the mock only ever returns in 60-item windows, the
  // same way main's SQL LIMIT/OFFSET would, plus the exact call sequence
  // (offset 0, then 60, then 120 -- never re-fetching offset 0).
  it('fetches history a page at a time, via "Show more", with the right offset each time', async () => {
    const corpus = Array.from({ length:130 }, (_, i) => s({ sessionId:`idle-${i}`, project:`idleproj${i}` }));
    const listHistory = pagedHistory(corpus);
    (globalThis as any).window.fleet.listHistory = listHistory;
    const { container } = render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
    const group = container.querySelector('#history-group')!;

    fireEvent.click(screen.getByRole('button', { name:/History/i }));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(60));
    await waitFor(() => expect(screen.getByRole('heading', { name:/History/i }).textContent).toMatch(/130/));
    expect(screen.getByText(/70 remaining/)).toBeTruthy();
    expect(listHistory).toHaveBeenCalledTimes(1);
    expect(listHistory).toHaveBeenNthCalledWith(1, 0, 60);

    fireEvent.click(screen.getByText(/70 remaining/));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(120));
    expect(screen.getByText(/10 remaining/)).toBeTruthy();
    expect(listHistory).toHaveBeenCalledTimes(2);
    expect(listHistory).toHaveBeenNthCalledWith(2, 60, 60);

    fireEvent.click(screen.getByText(/10 remaining/));
    await waitFor(() => expect(group.querySelectorAll('[role="button"]').length).toBe(130));
    // Every history session is now shown, so the control has nothing left to add.
    expect(screen.queryByText(/remaining/)).toBeNull();
    expect(listHistory).toHaveBeenCalledTimes(3);
    expect(listHistory).toHaveBeenNthCalledWith(3, 120, 60);
    // Never re-fetched page one.
    expect(listHistory).not.toHaveBeenNthCalledWith(2, 0, 60);
  });

  it('exposes the history group as a keyboard-operable disclosure that announces its state', async () => {
    render(<FleetView payload={payload([])} error={null} onSelect={() => {}} />);
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
      const { container } = render(<FleetView payload={payload([
        o({ pid:1, project:'one' }), o({ pid:2, project:'two' }), o({ pid:3, project:'three' }),
      ])} error={null} onSelect={() => {}} />);
      expect(screen.getByText('one')).toBeTruthy();
      expect(screen.getByText('two')).toBeTruthy();
      expect(screen.getByText('three')).toBeTruthy();
      // Not inside the collapsed history group.
      expect(container.querySelector('#history-group [role="button"]')).toBeNull();
    });

    // A session opened nine days ago and never touched since is still
    // open -- transcript recency (History) plays no part in this list.
    it('shows an open session that has no matching transcript session at all', async () => {
      render(<FleetView payload={payload(
        [o({ pid:7, project:'orphaned', match:'unknown', sessionId:null })])} error={null} onSelect={() => {}} />);
      expect(screen.getByText('orphaned')).toBeTruthy();
    });

    it('counts open sessions in the "N open" chip', async () => {
      render(<FleetView payload={payload(
        [o({ pid:1, project:'one' }), o({ pid:2, project:'two' })])} error={null} onSelect={() => {}} />);
      expect(screen.getByText(/2 open/)).toBeTruthy();
    });

    it('counts only open sessions blocked on the user in the "need you" chip', async () => {
      // Two blocked (one on each blocking activity), one merely working,
      // one unknown state -- counts diverge under any predicate that
      // confuses "blocked" with "working" or "known", so this pins the
      // exact set, not just a count that could coincidentally match.
      render(<FleetView payload={payload([
        o({ pid:1, project:'blocked-perm', activity:'waiting_permission' }),
        o({ pid:2, project:'blocked-input', activity:'waiting_input' }),
        o({ pid:3, project:'working', activity:'working' }),
        o({ pid:4, project:'unknown-state', activity:null }),
      ])} error={null} onSelect={() => {}} />);
      expect(screen.getByText(/4 open/)).toBeTruthy();
      expect(screen.getByText(/2 need you/)).toBeTruthy();
    });

    it('shows no "need you" chip when nothing is blocked', async () => {
      render(<FleetView payload={payload([o({ pid:1, project:'one' })])} error={null} onSelect={() => {}} />);
      expect(screen.getByText(/1 open/)).toBeTruthy();
      expect(screen.queryByText(/need you/)).toBeNull();
    });

    it('renders compact cards by default, and full ones once the setting turns the fleet off', async () => {
      const { container, rerender } = render(<FleetView payload={payload([o({ pid:1, project:'one' })])} error={null} onSelect={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll('.fleet .card').length).toBeGreaterThan(0));
      expect(container.querySelectorAll('.fleet .card.compact').length)
        .toBe(container.querySelectorAll('.fleet > .card').length);

      // setSettings notifies useSyncExternalStore's subscribers synchronously
      // (settings.ts's own setSettings), which happens outside any React
      // event handler here -- wrapped in act() so that store-driven update
      // is flushed before the assertions below, not left to warn about a
      // state update React didn't see wrapped.
      act(() => { setSettings({ compactCards: 'sidebar' }); });
      rerender(<FleetView payload={payload([o({ pid:1, project:'one' })])} error={null} onSelect={() => {}} />);
      expect(container.querySelectorAll('.fleet .card.compact').length).toBe(0);
    });
  });
});
