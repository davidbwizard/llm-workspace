import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReplyPopover } from '../../src/renderer/components/ReplyPopover.tsx';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent.change/keyDown/click
// substitute for userEvent.type/keyboard/click below, matching every other
// renderer test file in this repo.
let sendKeys: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sendKeys = vi.fn(async () => ({ status: 'sent' }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = { sendKeys };
});

describe('ReplyPopover', () => {
  it('sends what was typed, to the pid it was opened for', async () => {
    render(<ReplyPopover pid={4821} prompt="Overwrite farm.mjs?" onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(4821, 'yes'));
  });

  it('explains a refusal instead of failing silently', async () => {
    sendKeys.mockResolvedValue({ status: 'refused', reason: 'not_tmux' });
    render(<ReplyPopover pid={4821} prompt="x" onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/not running inside tmux/i)).toBeTruthy());
  });

  it('closes on escape', () => {
    const onClose = vi.fn();
    render(<ReplyPopover pid={4821} prompt="x" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('will not send an empty reply', () => {
    render(<ReplyPopover pid={4821} prompt="x" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(sendKeys).not.toHaveBeenCalled();
  });
});
