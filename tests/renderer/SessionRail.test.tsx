import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionRail } from '../../src/renderer/components/SessionRail.tsx';
import { setSettings, reloadSettings } from '../../src/renderer/state/settings.ts';
import {
  reloadGroups, assignCategory, categoryOfSession, bindPendingCategory, resolvePendingCategories,
} from '../../src/renderer/state/groups.ts';

// @testing-library/user-event is not a dependency of this project (every
// other renderer test file drives interaction through fireEvent, and
// package.json has no entry for it) -- fireEvent.click is a like-for-like
// substitute for userEvent.click here, so the brief's interaction is
// preserved without adding a package.

const sessions = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];

// Same two sessions, pid 2's events bumped -- the "new output arrived
// while unselected" case the unread tests below exercise. pid 2's own
// activity is 'idle' here, not the base fixture's 'waiting_input': a
// blocked card already shows its own badge/wording (OpenSessionCard's
// showUnread is always false while blocked), so a card that is meant to
// prove the UNREAD dot specifically must not also be the blocked one.
const sessionsPid2Bumped = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'idle', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 15 },
] as never[];

// Same two sessions, pid 1's events bumped instead -- the "own selected
// session keeps producing output" case, which must never flag itself.
const sessionsPid1Bumped = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 15 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];

// Two-session fixture where NEITHER starts blocked (unlike `sessions`
// above, whose pid 2 is 'waiting_input') -- needed so the ordering test
// below can prove unread alone moves a card to the top, rather than
// something already true at baseline because of blocked status.
const sessionsPlain = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'idle', lastProse: 'ok', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];
const sessionsPlainPid2Bumped = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'idle', lastProse: 'ok', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 15 },
] as never[];

// Three-session fixture for the relevance-ordering tests below: one
// blocked, one plain, and one that starts plain and gets bumped into
// "unread" by a rerender, same technique as sessionsPid2Bumped above.
//
// DELIBERATELY NOT in pid order (blocked-proj, pid 1, sits LAST rather than
// at array index 0): SessionRail's rank tiebreak is the session's own INDEX
// in this array, and with grouping on (Task 5), a row's rendered position
// is frozen from its own first render onward -- so if the blocked session
// also happened to be first by array position, "keeps a blocked card above
// everything else" below could pass purely from that coincidence, with the
// blocked tier in compareOpenSessions doing nothing at all. Proven by
// temporarily disabling that tier and watching the test still pass with the
// old (pid-ordered) array; see task-5-report.md for the actual output.
const sessions3 = [
  { pid: 3, project: 'plain-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c3', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'unread-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c2', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 1, project: 'blocked-proj', provider: 'claude', activity: 'waiting_permission', lastProse: 'Confirm?', cwd: '/c1', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];
const sessions3Pid2Bumped = [
  { pid: 3, project: 'plain-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c3', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'unread-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c2', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 15 },
  { pid: 1, project: 'blocked-proj', provider: 'claude', activity: 'waiting_permission', lastProse: 'Confirm?', cwd: '/c1', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];

// Same shape, pid 2 given a genuine junk cwd (a real tmpdir() path, not
// just a fixture label) -- compareOpenSessions decides junk from `cwd`
// itself. `junk` is now carried on OpenSession (derived in main, where
// tmpdir() exists -- a sandboxed renderer has no node:os), so the fixture
// sets it explicitly the way main would. The real tmpdir() cwd stays so the
// row still looks like what it is claiming to be.
const sessionsWithJunk = [
  { pid: 1, project: 'blocked-proj', provider: 'claude', activity: 'waiting_permission', lastProse: 'Confirm?', cwd: '/c1', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'temp folder', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: tmpdir(), junk: true, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 3, project: 'plain-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c3', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];
const sessionsWithJunkPid2Bumped = [
  { pid: 1, project: 'blocked-proj', provider: 'claude', activity: 'waiting_permission', lastProse: 'Confirm?', cwd: '/c1', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'temp folder', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: tmpdir(), junk: true, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 15 },
  { pid: 3, project: 'plain-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c3', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];

const noopKill = async () => ({ status: 'already_gone' as const });
const noopReattach = async () => ({ status: 'failed' as const, reason: 'not exercised' });
const noopResume = async () => ({ status: 'failed' as const, reason: 'not exercised' });

// A stub for window.fleet.sendKeys, kept so any code path this file
// exercises that happens to reach it (OpenSessionCard's own descendants)
// finds a bridge rather than throwing on a missing one. Task 5 removed
// SessionRail's own use of ReplyPopover (Answer now routes straight to the
// Conversation view -- see the "answers a waiting card via onAnswer" test
// below), which was this stub's original reason for existing.
let sendKeys: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sendKeys = vi.fn(async () => ({ status: 'sent', queued: false }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = { sendKeys };
  // The resize width is persisted here (see readStoredRailWidth/
  // writeStoredRailWidth in SessionRail.tsx) -- without clearing it, one
  // test's resize would leak into the next test's "starts at the default
  // width" assumption, since jsdom's localStorage survives across tests
  // within a file.
  localStorage.clear();
  reloadSettings();
  // Task 5: grouping defaults to ON, so every test in this file now mounts
  // a rail that calls rememberKeys on render, writing rail-order keys into
  // groups.ts's own module-singleton `current`. localStorage.clear() alone
  // does not touch that in-memory copy -- only reloadGroups() re-reads it
  // back to DEFAULT_GROUPS -- so without this, a folder key remembered by
  // one test would outlive it and reorder or restack an unrelated test's
  // cards. Same reasoning as reloadSettings() just above, for the same
  // localStorage-survives-the-file reason.
  reloadGroups();
});

describe('SessionRail', () => {
  it('renders one card per session, keeping its content', () => {
    // Full cards, not compact -- this predates the compact variant and is
    // testing generic per-session content (lastProse included), which only
    // the full card renders. The compact variant's own content is covered
    // by the "compact cards" describe block below.
    setSettings({ compactCards: 'fleet' });
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    expect(screen.getByText('llm-workspace')).toBeTruthy();
    expect(screen.getByText('Overwrite?')).toBeTruthy();
  });

  it('still flags a session that needs you, so the rail stays readable while you work', () => {
    const { container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    expect(container.querySelectorAll('.attn')).toHaveLength(1);
  });

  it('reports the pid when a card is chosen', () => {
    const onSelect = vi.fn();
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={onSelect} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    fireEvent.click(screen.getByText('game-viewer'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('carries the side as a class so the toggle is CSS, not a second tree', () => {
    const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="right" />);
    expect(container.querySelector('.rail.right')).toBeTruthy();
  });

  // The bug this guards against: SessionRail used to hardcode its own
  // `already_gone` stub for OpenSessionCard's onKill, so Close was a
  // control that always looked like it worked and never actually reached
  // main. Reviewer's own words: "would become Critical if Task 12 wires it
  // into the live UI without fixing onKill first." This proves the REAL
  // callback -- not a rail-owned stand-in -- is what Close ultimately
  // calls, with the pid of the card it was pressed on, not some other one.
  it('reaches the real onKill it was given, with the pid of the card that was closed', async () => {
    // Full card, not compact -- this test is about which onKill callback
    // Close ultimately reaches, not about the compact variant's own menu
    // (covered separately, in OpenSessionCard.test.tsx's compact describe).
    setSettings({ compactCards: 'fleet' });
    const onKill = vi.fn(async () => ({ status: 'killed' as const }));
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={onKill} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    fireEvent.click(screen.getByRole('button', { name: /close, pid 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /end session/i }));
    await waitFor(() => expect(onKill).toHaveBeenCalledWith(2));
    expect(onKill).not.toHaveBeenCalledWith(1);
  });

  // Task 5 (quick-answers design §9): Answer no longer opens a popover at
  // all -- it selects the session and switches the main pane straight to
  // the Conversation view, where the prompt card (or the waiting-card
  // fallback) lives. `onAnswer` is optional, same as the old
  // `onOpenTerminal` it replaces, so every other test in this file that
  // never clicks Answer needs no change.
  it('answers a waiting card via onAnswer -- selecting it and switching to Conversation, with no popover', () => {
    const onSelect = vi.fn();
    const onSetView = vi.fn();
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onAnswer={pid => { onSelect(pid); onSetView('conversation'); }} side="left" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /answer game-viewer, pid 2/i }));
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(onSetView).toHaveBeenCalledWith('conversation');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // onAnswer is optional (same as onOpenTerminal was) -- a caller that
  // never wires it must not crash when Answer is clicked.
  it('does nothing if Answer is clicked with no onAnswer wired', () => {
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: /answer game-viewer, pid 2/i }))).not.toThrow();
  });

  it('offers no reply trigger for a card that is not waiting on you', () => {
    render(<SessionRail sessions={[sessions[0]!]} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    expect(screen.queryByRole('button', { name: /answer/i })).toBeNull();
  });

  // Fix-wave item 6: a bare "Reply" button, unlike its Close neighbour
  // (OpenSessionCard.tsx's `Close, pid ${pid}`), gave two waiting sessions
  // in the rail two indistinguishable buttons in the accessibility tree.
  it('gives two waiting sessions two distinguishable Answer buttons, not two identical ones', () => {
    const both = [
      { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'waiting_permission', lastProse: 'All green.', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
      { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
    ] as never[];
    render(<SessionRail sessions={both} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    expect(screen.getByRole('button', { name: /answer llm-workspace, pid 1/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /answer game-viewer, pid 2/i })).toBeTruthy();
  });

  describe('resizing the rail', () => {
    it('exposes the handle as a focusable, named separator carrying its own width', () => {
      render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const handle = screen.getByRole('separator', { name: /180 pixels wide/i });
      expect(handle.tabIndex).toBe(0);
      expect(handle.getAttribute('aria-valuenow')).toBe('180');
    });

    it('starts at the default width, applied to the rail element itself', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect((container.querySelector('.rail') as HTMLElement).style.width).toBe('180px');
    });

    it('grows a left rail on ArrowRight and shrinks it on ArrowLeft, at its own handle', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const handle = screen.getByRole('separator');
      const width = () => (container.querySelector('.rail') as HTMLElement).style.width;
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(width()).toBe('192px');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(width()).toBe('168px');
    });

    // Mutation target: dropping the Math.max half of clampRailWidth (or
    // the whole clamp) must fail this -- a left rail driven far past its
    // minimum with ArrowLeft would otherwise go negative or to zero,
    // "dragged to nothing" per the brief.
    it('clamps growth at a sensible minimum, never to zero or negative', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const handle = screen.getByRole('separator');
      for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      const width = (container.querySelector('.rail') as HTMLElement).style.width;
      expect(width).toBe('140px');
      expect(parseInt(width, 10)).toBeGreaterThan(0);
    });

    // Mutation target: dropping the Math.min half of clampRailWidth must
    // fail this -- an unbounded rail could otherwise be grown until it
    // swallows the pane entirely.
    it('clamps growth at a sensible maximum too, so the rail cannot swallow the pane', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const handle = screen.getByRole('separator');
      for (let i = 0; i < 30; i++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect((container.querySelector('.rail') as HTMLElement).style.width).toBe('420px');
    });

    // The rail's inner edge -- the edge next to the pane -- is on the
    // OPPOSITE side for 'right', so the same physical drag/key direction
    // must grow it the opposite way, or the handle would visually detach
    // from the border it is supposed to be sitting on.
    it('mirrors the arrow-key direction for a right rail', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="right" />);
      const handle = screen.getByRole('separator');
      const width = () => (container.querySelector('.rail') as HTMLElement).style.width;
      fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // grows a right rail
      expect(width()).toBe('192px');
      fireEvent.keyDown(handle, { key: 'ArrowRight' }); // shrinks it
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(width()).toBe('168px');
    });

    it('resizes by dragging the handle with the mouse, mirrored the same way as the keyboard', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const handle = screen.getByRole('separator');
      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(window, { clientX: 145 });
      fireEvent.mouseUp(window);
      expect((container.querySelector('.rail') as HTMLElement).style.width).toBe('225px');
    });

    it('stops following the mouse once the drag ends', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const handle = screen.getByRole('separator');
      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(window, { clientX: 145 });
      fireEvent.mouseUp(window);
      const settled = (container.querySelector('.rail') as HTMLElement).style.width;
      fireEvent.mouseMove(window, { clientX: 300 }); // no mousedown first -- must be a no-op
      expect((container.querySelector('.rail') as HTMLElement).style.width).toBe(settled);
    });

    // The width must survive a restart -- localStorage is what makes that
    // true (a per-viewer UI preference, not fleet state), so a fresh
    // mount of the SAME rail must pick up what a previous one left behind.
    it('persists the resized width across a remount', () => {
      const { unmount, container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      const resized = (container.querySelector('.rail') as HTMLElement).style.width;
      expect(resized).toBe('204px');
      unmount();

      const { container: container2 } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect((container2.querySelector('.rail') as HTMLElement).style.width).toBe(resized);
    });

    it('ignores a corrupt or out-of-range stored width rather than rendering it verbatim', () => {
      localStorage.setItem('llmws:rail-width', 'not-a-number');
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect((container.querySelector('.rail') as HTMLElement).style.width).toBe('180px');

      localStorage.setItem('llmws:rail-width', '99999');
      const { container: container2 } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect((container2.querySelector('.rail') as HTMLElement).style.width).toBe('420px');
    });
  });

  describe('the unread indicator', () => {
    it('shows nothing on first render -- a pre-existing event count is never reported as new', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(0);
    });

    it('flags a session whose events increase while it is not the current selection', () => {
      const { rerender, container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsPid2Bumped} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(1);
    });

    // Mutation target: dropping the `s.pid !== selectedPid` guard (or
    // never updating the baseline on selection) must fail this.
    it('never flags the session currently being viewed, even as its own events grow', () => {
      const { rerender, container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsPid1Bumped} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(0);
    });

    // Distinct from the "never flags the currently selected session" test
    // above: that one never looks away. This is the scenario its own doc
    // comment in SessionRail.tsx calls out specifically -- a session that
    // produced output while genuinely being viewed must not light up
    // retroactively the moment you switch to something else, which only
    // holds if the baseline is updated WHILE selected (SessionRail.tsx's
    // effect), not merely suppressed by the render-time check for as
    // long as it stays selected.
    it('does not light up after you look away, having produced output while you were viewing it', () => {
      const { rerender, container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsPid1Bumped} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsPid1Bumped} selectedPid={2} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(0);
    });

    it('clears once the user selects the flagged session', () => {
      const { rerender, container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsPid2Bumped} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(1);
      rerender(<SessionRail sessions={sessionsPid2Bumped} selectedPid={2} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(0);
    });

    // Once selected, a later re-render (unrelated data refresh, still with
    // events unchanged) must not resurrect the indicator for that same
    // session -- the baseline recorded on selection has to stick.
    it('stays cleared for the selected session across further re-renders', () => {
      const { rerender, container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsPid2Bumped} selectedPid={2} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsPid2Bumped} selectedPid={2} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(0);
    });
  });

  // Relevance ordering: unread is a fact only this component tracks, so
  // it's the one caller that has to layer it into the display order
  // itself (src/fleet/state.ts's own sort, which produced the `sessions`
  // prop order, has no way to see it) -- these prove the layering actually
  // reorders the rendered cards, not just the dot.
  describe('relevance ordering', () => {
    function projectOrder(container: HTMLElement): (string | null)[] {
      return [...container.querySelectorAll('.proj')].map(el => el.textContent);
    }

    // REWRITTEN for Task 5 (spec's Ordering section: "Rows do not move on
    // their own... a session starting to wait changes how its row looks,
    // never where it is"). The original test drove this scenario with a
    // mid-session unread bump and asserted the row MOVED -- that assertion
    // is now permanently false, not just for a rerender: isUnread requires
    // seenEvents to already hold a LOWER baseline for that pid
    // (SessionRail.tsx's own `events > (seenEvents.get(pid) ?? events)`),
    // which can only be true once the rail has rendered that pid before --
    // and rememberKeys freezes a row's position off that SAME first render,
    // in the same commit cycle that establishes the baseline. So a row can
    // never be both "unread" and "not yet frozen" on any render, which
    // means the promotion this test used to check cannot happen at all
    // anymore. Do not restore the old "moves above" assertion -- it would
    // never go red again no matter what the code does. What survives, and
    // is what this now proves: the unread SIGNAL still fires (the dot), and
    // the row's position does not move because of it -- both halves of
    // what actually changed here, pinned in one test.
    it('flags an unread card but does not move its row', () => {
      const { rerender, container } = render(<SessionRail sessions={sessionsPlain} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      const before = projectOrder(container);
      expect(before).toEqual(['llm-workspace', 'game-viewer']);
      rerender(<SessionRail sessions={sessionsPlainPid2Bumped} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      // pid 2 is now unread -- the dot still fires...
      expect(container.querySelectorAll('.unread-dot')).toHaveLength(1);
      // ...but its row stays exactly where it was.
      expect(projectOrder(container)).toEqual(before);
    });

    // REWRITTEN for Task 5, same reasoning as the test above: the original
    // full-array assertion here conflated two claims. "Blocked first" is
    // still real and checked every render (compareOpenSessions' blocked
    // tier needs no prior baseline, unlike unread). "Unread above merely-
    // recent" was never actually exercised by the bump -- pid 2 already
    // sits above pid 3 in the INCOMING array before any bump, so that part
    // of the assertion held whether or not the bump (or isUnread) did
    // anything, and it cannot be repaired into a real ordering assertion
    // either, for the same reason as the test above (a pid can only be
    // unread once its row is already frozen). Keeping it would leave a
    // decorative assertion that could never go red for the reason its own
    // name claims, so it is dropped rather than kept for show.
    //
    // Mutation target: the blocked check in compareOpenSessions running
    // AFTER the junk/unread checks (instead of before) would let a
    // non-blocked card outrank pid 1 here.
    it('keeps a blocked card above everything else', () => {
      const { rerender, container } = render(<SessionRail sessions={sessions3} selectedPid={3} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessions3Pid2Bumped} selectedPid={3} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(projectOrder(container)[0]).toBe('blocked-proj');
    });

    // Junk stays last even when it's the one card with new output --
    // "keep junk-last behaviour exactly" holds under the unread layer too,
    // not just in state.ts's own sort.
    it('keeps a junk-cwd card last even when it becomes unread', () => {
      const { rerender, container } = render(<SessionRail sessions={sessionsWithJunk} selectedPid={3} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessionsWithJunkPid2Bumped} selectedPid={3} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(projectOrder(container)).toEqual(['blocked-proj', 'plain-proj', 'temp folder']);
    });
  });

  // Cmd+1..9: unlike the grid (FleetView.test.tsx), the rail can place a
  // card somewhere other than its rank in `sessions` -- these prove the
  // hotkey number still tracks each session's PID through that placement,
  // not wherever it currently sits on screen, so pressing Cmd+N (App.tsx,
  // which reads the same canonical `sessions`/openSessions order) always
  // lands on the card carrying that same number. David's own ruling: "same
  // numbering everywhere... in sidebar order" -- App.tsx computes ONE
  // shared pid->number map (useFleet.ts's orderedSessions) and hands it
  // down as cmdIndexByPid, rather than this component deriving numbers from
  // its own rank or its own display position.
  //
  // REWRITTEN for Task 5 (spec's Ordering section: "Rows do not move on
  // their own... a session starting to wait changes how its row looks,
  // never where it is"). The original form of this test drove the
  // reordering with a mid-session unread bump and a rerender -- that no
  // longer reorders anything once grouping defaults to ON: a row's folder
  // key is remembered (groups.ts's rememberKeys) after its very first
  // render, and applyStableOrder then holds that row at its remembered slot
  // on every later render regardless of what compareOpenSessions would now
  // say, by design (see "folder grouping > keeps a row where it first
  // appeared..." above, which proves that stability directly). Do not
  // restore the rerender-and-bump form -- it would pass or fail by
  // accident, not by design, since the position it checks can no longer
  // move.
  //
  // What's still true, and still worth a test: compareOpenSessions still
  // decides where a row lands the FIRST time the rail ever sees it, and the
  // hotkey number is a lookup by pid against that placement, not a read of
  // screen position. One render proves both -- pid 2 starts BLOCKED (a
  // tier that needs no prior baseline, unlike unread), so it lands first
  // despite being second in both the incoming array and cmdIndexByPid.
  describe('the Cmd+N hotkey numbers', () => {
    it('shows the number cmdIndexByPid gives each pid, tracking that pid through compareOpenSessions’ own first placement', () => {
      const cmdIndexByPid = new Map([[1, 1], [2, 2]]);
      const startsBlocked = [
        { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
        { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
      ] as never[];
      const { container } = render(<SessionRail sessions={startsBlocked} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" cmdIndexByPid={cmdIndexByPid} />);
      // pid 2 is blocked, so it lands FIRST despite being second in the
      // array and in cmdIndexByPid.
      expect([...container.querySelectorAll('.proj')].map(el => el.textContent)).toEqual(['game-viewer', 'llm-workspace']);
      // Its number follows IT, not the slot it landed in -- still "2".
      expect([...container.querySelectorAll('.cmdnum')].map(n => n.textContent)).toEqual(['2', '1']);
    });

    it('shows no numbers at all when cmdIndexByPid is not supplied', () => {
      const { container } = render(<SessionRail sessions={sessionsPlain} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.cmdnum')).toHaveLength(0);
    });
  });

  describe('SessionRail -- compact cards', () => {
    it('renders compact cards by default, which is what the setting ships as', () => {
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.card.compact').length).toBe(sessions.length);
    });

    it('renders full cards once the setting turns the sidebar off', () => {
      setSettings({ compactCards: 'fleet' });
      const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(container.querySelectorAll('.card.compact').length).toBe(0);
    });
  });

  // Task 5: sessions sharing a cwd fold into one StackCard row. groupSessions
  // defaults to 'on' (settings.ts's DEFAULT_SETTINGS), so this is the rail's
  // normal behaviour now, not an opt-in path -- every test above this block
  // uses fixtures with distinct cwds per session specifically so grouping
  // never engages behind their backs.
  describe('folder grouping', () => {
    const twoInOneFolder = [
      { pid: 1, project: 'repo', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/repo', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 's1' },
      { pid: 2, project: 'repo', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/repo', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 's2' },
    ] as never[];

    const renderRail = (list: never[] = twoInOneFolder) => render(
      <SessionRail sessions={list} selectedPid={null} onSelect={() => {}} onKill={noopKill}
        onReattach={noopReattach} onResume={noopResume} side="left" />,
    );

    beforeEach(() => {
      localStorage.clear();
      reloadGroups();
      reloadSettings();
    });

    it('renders one row for two sessions sharing a folder', () => {
      renderRail();
      expect(screen.getByText('2 sessions')).toBeTruthy();
    });

    it('leaves a lone session as an ordinary card, with no stack chrome', () => {
      renderRail([twoInOneFolder[0]] as never[]);
      expect(screen.queryByText(/\d+ sessions/)).toBeNull();
    });

    it('shows the members once the stack is opened, and keeps them open across a re-render', () => {
      // Full cards, not compact: compact's own Close button lives behind
      // the "Session actions" menu (OpenSessionCard.tsx's
      // `phase === 'idle' && !compact`), and this test is about the members
      // being present and reachable once unfolded, not about that menu --
      // same reasoning as the pre-existing "reaches the real onKill" test
      // above, which opts into 'fleet' for the same button.
      setSettings({ compactCards: 'fleet' });
      const { rerender } = renderRail();
      // Scoped to the "N sessions" text rather than a project-name match:
      // the stack's members are ALWAYS in the DOM even while folded
      // (StackCard.tsx's own doc comment -- only CSS hides them), so a
      // `name: /repo/i` query also matches each member's own
      // `role="button"` card (aria-label "Open repo...") and is ambiguous
      // with two members sharing that project name.
      fireEvent.click(screen.getByRole('button', { name: /2 sessions/i }));
      expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
      rerender(
        <SessionRail sessions={twoInOneFolder} selectedPid={null} onSelect={() => {}} onKill={noopKill}
          onReattach={noopReattach} onResume={noopResume} side="left" />,
      );
      expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
    });

    it('does not group when the setting is off', () => {
      // Full cards, not compact -- see the comment above.
      setSettings({ compactCards: 'fleet', groupSessions: 'off' });
      renderRail();
      expect(screen.queryByText('2 sessions')).toBeNull();
      expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
      expect(screen.getByLabelText(/Close, pid 2/)).toBeTruthy();
    });

    it('keeps a row where it first appeared when a later session starts waiting', () => {
      const first = [
        { pid: 1, project: 'a-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 'sa' },
        { pid: 2, project: 'b-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, sessionId: 'sb' },
      ] as never[];
      const { rerender, container } = render(
        <SessionRail sessions={first} selectedPid={null} onSelect={() => {}} onKill={noopKill}
          onReattach={noopReattach} onResume={noopResume} side="left" />,
      );
      const namesOf = () => [...container.querySelectorAll('.proj')].map(p => p.textContent);
      const before = namesOf();
      // tsconfig's noUncheckedIndexedAccess types `first[1]` as
      // `never | undefined` (declared plan defect #2): `!` alone narrows
      // that back to `never`, but a bare `never` cannot be spread ("Spread
      // types may only be created from object types"), so the spread target
      // goes through `unknown` first, the same two-step cast this file's
      // other test files already use for a differently-typed global.
      const bumped = [
        { ...(first[1]! as unknown as object), activity: 'waiting_permission' },
        first[0]!,
      ] as never[];
      rerender(
        <SessionRail sessions={bumped} selectedPid={null} onSelect={() => {}} onKill={noopKill}
          onReattach={noopReattach} onResume={noopResume} side="left" />,
      );
      expect(namesOf()).toEqual(before);
    });

    it('heads a categorised session with its category name', () => {
      assignCategory('s1', 'Fleet');
      renderRail();
      expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
    });

    it('gives uncategorised rows no header at all, not an Other bucket', () => {
      renderRail();
      expect(screen.queryByRole('heading', { name: /other/i })).toBeNull();
    });

    it('pulls the categorised session out, leaving its folder-mate as a plain card', () => {
      // Full cards, not compact: the Close button this asserts on lives
      // behind the compact card's "..." menu (OpenSessionCard.tsx,
      // `phase === 'idle' && !compact`), so no "Close, pid N" label exists
      // under the default compact setting -- same reasoning as "does not
      // group when the setting is off" above (deviation from the brief,
      // which omitted this override).
      setSettings({ compactCards: 'fleet' });
      assignCategory('s1', 'Fleet');
      renderRail();
      expect(screen.queryByText(/\d+ sessions/)).toBeNull();
      expect(screen.getByLabelText(/Close, pid 1/)).toBeTruthy();
      expect(screen.getByLabelText(/Close, pid 2/)).toBeTruthy();
    });

    // The setting is folder stacking only. A category David set must not
    // disappear because he turned stacking off.
    it('still heads a categorised session when stacking is off', () => {
      assignCategory('s1', 'Fleet');
      setSettings({ groupSessions: 'off' });
      renderRail();
      expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
      expect(screen.queryByText('2 sessions')).toBeNull();
    });

    // An assignment for a session that is not in the fleet is not the rail's
    // problem to clean up (Task 8 prunes it on the fleet push) -- but it must
    // never PAINT anything, because a header with no card under it would be a
    // category David cannot get rid of.
    it('renders nothing for an assignment whose session is not in the fleet', () => {
      assignCategory('gone', 'Ghosts');
      renderRail();
      expect(screen.queryByRole('heading', { name: 'Ghosts' })).toBeNull();
    });

    it('heads a launched session with its category before any session id exists', () => {
      bindPendingCategory(1, 'Fleet');
      // noUncheckedIndexedAccess types `twoInOneFolder[0]` as possibly
      // undefined -- `!` narrows it, and the cast goes through `unknown`
      // first for the same reason the "keeps a row where it first appeared"
      // test above does: a bare `never` cannot be spread directly.
      renderRail([{ ...(twoInOneFolder[0]! as unknown as object), sessionId: null }] as never[]);
      expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
    });

    it('upgrades to the stored assignment without remounting the card or doubling the header', () => {
      bindPendingCategory(1, 'Fleet');
      const pending = [{ ...(twoInOneFolder[0]! as unknown as object), sessionId: null }] as never[];
      const { container, rerender } = render(
        <SessionRail sessions={pending} selectedPid={null} onSelect={() => {}} onKill={noopKill}
          onReattach={noopReattach} onResume={noopResume} side="left" />,
      );
      const cardBefore = container.querySelector('.card');

      // Discovery names the pid, exactly as useFleet's own effect would.
      const named = [{ ...(twoInOneFolder[0]! as unknown as object), sessionId: 's1' }] as never[];
      resolvePendingCategories([{ pid: 1, sessionId: 's1' }]);
      rerender(
        <SessionRail sessions={named} selectedPid={null} onSelect={() => {}} onKill={noopKill}
          onReattach={noopReattach} onResume={noopResume} side="left" />,
      );

      expect(screen.getAllByRole('heading', { name: 'Fleet' })).toHaveLength(1);
      expect(container.querySelectorAll('.card')).toHaveLength(1);
      // The SAME DOM node: React only reuses it when the row key is unchanged,
      // so this is what proves the pid key survives the upgrade. A session-id
      // key would fail here, and the card would visibly flash and lose its slot.
      expect(container.querySelector('.card')).toBe(cardBefore);
    });
  });
});
