import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LaunchBar } from '../../src/renderer/components/LaunchBar.tsx';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent substitutes for it,
// matching every other renderer test file.
let launch: ReturnType<typeof vi.fn>;
let chooseDirectory: ReturnType<typeof vi.fn>;
beforeEach(() => {
  launch = vi.fn(async () => ({ status: 'launched', pid: 4821 }));
  chooseDirectory = vi.fn(async () => null);
  // LaunchBar's settings gear mounts the real SettingsModal (below), which
  // reads Quick answers' state via hooksGet on open -- stubbed here purely
  // so that mount doesn't throw; its own behaviour is covered by
  // tests/renderer/SettingsModal.test.tsx.
  const hooksGet = vi.fn(async () => ({ installed: false, error: null }));
  const hooksSet = vi.fn(async (on: boolean) => ({ installed: on, error: null }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet =
    { launch, chooseDirectory, hooksGet, hooksSet };
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

  it('opens the native picker and fills the input with the chosen path', async () => {
    chooseDirectory.mockResolvedValue('/tmp/picked');
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a working directory' }));
    expect(chooseDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((screen.getByLabelText('Working directory') as HTMLInputElement).value).toBe('/tmp/picked'));
  });

  it('leaves a typed path untouched when the picker is cancelled', async () => {
    chooseDirectory.mockResolvedValue(null);
    render(<LaunchBar onLaunched={() => {}} />);
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a working directory' }));
    await waitFor(() => expect(chooseDirectory).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('Working directory') as HTMLInputElement).value).toBe('/tmp/typed');
  });

  it('opens settings from a gear beside Launch, and returns focus to it on close', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    const gear = screen.getByRole('button', { name: /^settings$/i });
    fireEvent.click(gear);
    expect(screen.getByLabelText('Appearance')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(document.activeElement).toBe(gear);
  });

  // Usage design, Part B: a small non-modal popover, next to the gear.
  describe('the Usage button and its popover', () => {
    beforeEach(() => {
      // Stubbed purely so UsagePopover's own mount effect doesn't throw --
      // its own behaviour (bars, empty states, refresh) is covered by
      // UsagePopover.test.tsx.
      const api = (globalThis as never as { window: { fleet: Record<string, unknown> } }).window.fleet;
      api.usageSwitchGet = vi.fn(async () => ({ installed: true, error: null }));
      api.usageGet = vi.fn(async () => ({ claude: null, codex: null }));
    });

    it('opens the popover from a button beside the gear', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^usage$/i }));
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
    });

    it('closes on Escape and returns focus to the button', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      const usageBtn = screen.getByRole('button', { name: /^usage$/i });
      fireEvent.click(usageBtn);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
      expect(document.activeElement).toBe(usageBtn);
    });

    it('closes on an outside click and returns focus to the button', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      const usageBtn = screen.getByRole('button', { name: /^usage$/i });
      fireEvent.click(usageBtn);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
      expect(document.activeElement).toBe(usageBtn);
    });

    it('does not close on a click inside the popover itself', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /^usage$/i }));
      const dialog = screen.getByRole('dialog', { name: /usage/i });
      fireEvent.mouseDown(dialog);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
    });

    it('toggles closed on a second click of the button itself', () => {
      render(<LaunchBar onLaunched={() => {}} />);
      const usageBtn = screen.getByRole('button', { name: /^usage$/i });
      fireEvent.click(usageBtn);
      expect(screen.getByRole('dialog', { name: /usage/i })).toBeTruthy();
      fireEvent.click(usageBtn);
      expect(screen.queryByRole('dialog', { name: /usage/i })).toBeNull();
    });
  });
});
