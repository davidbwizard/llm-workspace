import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { SessionRail } from '../../src/renderer/components/SessionRail.tsx';
import { setSettings, reloadSettings } from '../../src/renderer/state/settings.ts';

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
const sessions3 = [
  { pid: 1, project: 'blocked-proj', provider: 'claude', activity: 'waiting_permission', lastProse: 'Confirm?', cwd: '/c1', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'unread-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c2', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 3, project: 'plain-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c3', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];
const sessions3Pid2Bumped = [
  { pid: 1, project: 'blocked-proj', provider: 'claude', activity: 'waiting_permission', lastProse: 'Confirm?', cwd: '/c1', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'unread-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c2', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 15 },
  { pid: 3, project: 'plain-proj', provider: 'claude', activity: 'idle', lastProse: 'ok', cwd: '/c3', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
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

// ReplyPopover (Task 11) reaches window.fleet.sendKeys directly -- present
// so the reply tests below don't throw on a missing bridge, and so its
// call can be asserted the same way tests/renderer/ReplyPopover.test.tsx
// already does.
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

  // Spec: "click shows the prompt" -- a card waiting on you opens the reply
  // popover, keyed to that card's own pid and prompt (its lastProse), from a
  // control that is NOT the card's own onOpen (that one still just selects
  // it, per the "reports the pid when a card is chosen" test above --
  // opening the popover must never be confused with switching the main
  // pane to that session). Reply guard: a waiting session is a choice as
  // far as the rail can tell, so the popover opens with no text box --
  // Answer routes to the terminal instead (covered by the choice-specific
  // tests below and by tests/renderer/ReplyPopover.test.tsx).
  it('opens a popover for the waiting card, keyed to its pid and prompt, with no text box', () => {
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /answer game-viewer, pid 2/i }));
    const dialog = screen.getByRole('dialog', { name: /reply to session 2/i });
    // Scoped to the dialog: OpenSessionCard's own .said already renders this
    // same lastProse text once, so a page-wide text search would match both.
    expect(within(dialog).getByText('Overwrite?')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  // sessions[1] (pid 2) has tmux: undefined (falsy) in this file's plain
  // fixtures, so the popover falls to the onReveal branch -- proving the
  // rail wires choice/tmux/onOpenTerminal through even when tmux is false.
  it('offers Open Terminal for a waiting, tmux-backed card, wired to select-then-switch-to-terminal', () => {
    const tmuxSessions = [
      { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, tmux: true },
    ] as never[];
    const onSelect = vi.fn();
    const onSetView = vi.fn();
    render(<SessionRail sessions={tmuxSessions} selectedPid={null} onSelect={onSelect} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onOpenTerminal={pid => { onSelect(pid); onSetView('terminal'); }} side="left" />);
    fireEvent.click(screen.getByRole('button', { name: /answer game-viewer, pid 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /open terminal/i }));
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(onSetView).toHaveBeenCalledWith('terminal');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Fix round 1 (in-app testing, 2026-09-15): the popover was passed
  // choice={waiting}, re-evaluated on every render from the session's
  // CURRENT activity -- so a momentary activity change while it was open
  // (a fleet:update landing mid-answer) silently morphed it back into a
  // text box. The main-side guard then refused the send and the picker was
  // never reached; on a second try it correctly showed Open Terminal. The
  // popover is only ever opened from the waiting-only Answer button, so
  // once open it must stay in choice mode regardless of what the session's
  // activity does afterwards.
  it('keeps an open Answer popover in choice mode even if the session stops looking like it is waiting', () => {
    const waitingTmux = [
      { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, tmux: true },
    ] as never[];
    const { rerender } = render(<SessionRail sessions={waitingTmux} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    fireEvent.click(screen.getByRole('button', { name: /answer game-viewer, pid 2/i }));
    expect(screen.getByRole('button', { name: /open terminal/i })).toBeTruthy();

    const idleTmux = [
      { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'idle', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10, tmux: true },
    ] as never[];
    rerender(<SessionRail sessions={idleTmux} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);

    const dialog = screen.getByRole('dialog', { name: /reply to session 2/i });
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: /open terminal/i })).toBeTruthy();
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

    it('moves an unread card above a merely-recent one', () => {
      const { rerender, container } = render(<SessionRail sessions={sessionsPlain} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      // Baseline order matches the prop as given -- neither card is blocked
      // or unread yet.
      expect(projectOrder(container)).toEqual(['llm-workspace', 'game-viewer']);
      rerender(<SessionRail sessions={sessionsPlainPid2Bumped} selectedPid={1} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      // pid 2 (now unread) moves above pid 1, which is merely working.
      expect(projectOrder(container)).toEqual(['game-viewer', 'llm-workspace']);
    });

    // Mutation target: the blocked check in compareOpenSessions running
    // AFTER the unread check (instead of before) would let an unread,
    // non-blocked card outrank a blocked one here.
    it('keeps a blocked card above an unread one, which stays above a merely-recent one', () => {
      const { rerender, container } = render(<SessionRail sessions={sessions3} selectedPid={3} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      rerender(<SessionRail sessions={sessions3Pid2Bumped} selectedPid={3} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
      expect(projectOrder(container)).toEqual(['blocked-proj', 'unread-proj', 'plain-proj']);
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
});
