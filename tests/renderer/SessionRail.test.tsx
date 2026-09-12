import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { SessionRail } from '../../src/renderer/components/SessionRail.tsx';

// @testing-library/user-event is not a dependency of this project (every
// other renderer test file drives interaction through fireEvent, and
// package.json has no entry for it) -- fireEvent.click is a like-for-like
// substitute for userEvent.click here, so the brief's interaction is
// preserved without adding a package.

const sessions = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];

// ReplyPopover (Task 11) reaches window.fleet.sendKeys directly -- present
// so the reply tests below don't throw on a missing bridge, and so its
// call can be asserted the same way tests/renderer/ReplyPopover.test.tsx
// already does.
let sendKeys: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sendKeys = vi.fn(async () => ({ status: 'sent' }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = { sendKeys };
});

describe('SessionRail', () => {
  it('renders one card per session, keeping its content', () => {
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} side="left" />);
    expect(screen.getByText('llm-workspace')).toBeTruthy();
    expect(screen.getByText('Overwrite?')).toBeTruthy();
  });

  it('still flags a session that needs you, so the rail stays readable while you work', () => {
    const { container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} side="left" />);
    expect(container.querySelectorAll('.attn')).toHaveLength(1);
  });

  it('reports the pid when a card is chosen', () => {
    const onSelect = vi.fn();
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={onSelect} onKill={async () => ({ status: 'already_gone' })} side="left" />);
    fireEvent.click(screen.getByText('game-viewer'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('carries the side as a class so the toggle is CSS, not a second tree', () => {
    const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} side="right" />);
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
    const onKill = vi.fn(async () => ({ status: 'killed' as const }));
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={onKill} side="left" />);
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
  // pane to that session).
  it('opens a reply popover for the waiting card, keyed to its pid and prompt', async () => {
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} side="left" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const dialog = screen.getByRole('dialog', { name: /reply to session 2/i });
    // Scoped to the dialog: OpenSessionCard's own .said already renders this
    // same lastProse text once, so a page-wide text search would match both.
    expect(within(dialog).getByText('Overwrite?')).toBeTruthy();

    fireEvent.change(within(dialog).getByRole('textbox', { name: /reply/i }), { target: { value: 'yes' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /send/i }));
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(2, 'yes'));
  });

  it('offers no reply trigger for a card that is not waiting on you', () => {
    render(<SessionRail sessions={[sessions[0]!]} selectedPid={null} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} side="left" />);
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });
});
