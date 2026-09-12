import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LaunchBar } from '../../src/renderer/components/LaunchBar.tsx';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent substitutes for it,
// matching every other renderer test file.
let launch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  launch = vi.fn(async () => ({ status: 'launched', pid: 4821 }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = { launch };
});

describe('LaunchBar', () => {
  it('launches the chosen directory under the default provider, and reports the new pid', async () => {
    const onLaunched = vi.fn();
    render(<LaunchBar onLaunched={onLaunched} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(4821));
    expect(launch).toHaveBeenCalledWith('claude', '/tmp/proj', expect.any(Number), expect.any(Number));
  });

  it('sends the provider the user actually picked, not always the default', async () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    await waitFor(() => expect(launch).toHaveBeenCalledWith('codex', '/tmp/proj', expect.any(Number), expect.any(Number)));
  });

  it('shows the failure reason instead of failing silently', async () => {
    launch.mockResolvedValue({ status: 'failed', reason: 'tmux: no server running' });
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/proj' } });
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    await waitFor(() => expect(screen.getByText(/no server running/i)).toBeTruthy());
  });

  it('refuses to launch with no directory chosen', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(launch).not.toHaveBeenCalled();
    expect(screen.getByText(/choose a working directory/i)).toBeTruthy();
  });
});
