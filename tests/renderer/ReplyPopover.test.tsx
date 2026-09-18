import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReplyPopover } from '../../src/renderer/components/ReplyPopover.tsx';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent.change/keyDown/click
// substitute for userEvent.type/keyboard/click below, matching every other
// renderer test file in this repo.
let sendKeys: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sendKeys = vi.fn(async () => ({ status: 'sent', queued: false }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = { sendKeys };
});

// Every test below now passes choice/tmux/hostLabel/onOpenTerminal/onReveal
// explicitly -- ReplyPopover has no defaults for these (Reply guard, David's
// ruling: the card always knows whether it opened onto a choice).
describe('ReplyPopover', () => {
  it('sends what was typed, to the pid it was opened for', async () => {
    render(<ReplyPopover pid={4821} prompt="Overwrite farm.mjs?" choice={false} tmux={true}
      hostLabel={null} onOpenTerminal={() => {}} onReveal={null} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(4821, 'yes'));
  });

  it('explains a refusal instead of failing silently', async () => {
    sendKeys.mockResolvedValue({ status: 'refused', reason: 'not_tmux' });
    render(<ReplyPopover pid={4821} prompt="x" choice={false} tmux={true}
      hostLabel={null} onOpenTerminal={() => {}} onReveal={null} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/not running inside tmux/i)).toBeTruthy());
  });

  it('closes on escape', () => {
    const onClose = vi.fn();
    render(<ReplyPopover pid={4821} prompt="x" choice={false} tmux={true}
      hostLabel={null} onOpenTerminal={() => {}} onReveal={null} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('will not send an empty reply', () => {
    render(<ReplyPopover pid={4821} prompt="x" choice={false} tmux={true}
      hostLabel={null} onOpenTerminal={() => {}} onReveal={null} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // The defect (2026-09-15 in-app testing): "blue" typed into this popover
  // was recorded as "Red" -- the picker ignores the letters and Enter
  // selects whichever option is highlighted. A choice popover must never
  // offer a text box at all.
  it('with a choice open, offers no text box, shows the explanation, and Open Terminal routes there', () => {
    const onOpenTerminal = vi.fn();
    const onClose = vi.fn();
    render(<ReplyPopover pid={4821} prompt="Pick a color?" choice={true} tmux={true}
      hostLabel={null} onOpenTerminal={onOpenTerminal} onReveal={null} onClose={onClose} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull();
    expect(screen.getByText('Pick a color?')).toBeTruthy();
    expect(screen.getByText(/answer it in the terminal/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /open terminal/i }));
    expect(onOpenTerminal).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('with a choice open and no tmux, offers Show in <host> instead, calling onReveal', () => {
    const onReveal = vi.fn();
    const onClose = vi.fn();
    render(<ReplyPopover pid={4821} prompt="Pick a color?" choice={true} tmux={false}
      hostLabel="iTerm2" onOpenTerminal={() => {}} onReveal={onReveal} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /show in iterm2/i }));
    expect(onReveal).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // The backstop: even a popover that opened believing choice was false
  // (a race between the card's own status and main's fresher check) must
  // still explain a prompt_open refusal rather than failing silently.
  it('shows the backstop text for a prompt_open refusal', async () => {
    sendKeys.mockResolvedValue({ status: 'refused', reason: 'prompt_open' });
    render(<ReplyPopover pid={4821} prompt="x" choice={false} tmux={true}
      hostLabel={null} onOpenTerminal={() => {}} onReveal={null} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/showing a choice right now/i)).toBeTruthy());
  });
});
