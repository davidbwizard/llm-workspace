import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { UsagePopover } from '../../src/renderer/components/UsagePopover.tsx';

function setFleet(overrides: Record<string, unknown> = {}) {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    usageSwitchGet: vi.fn(async () => ({ installed: true, error: null })),
    usageGet: vi.fn(async () => ({ claude: null, codex: null })),
    ...overrides,
  };
}

describe('UsagePopover', () => {
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = undefined;
  });

  describe('empty states', () => {
    it('tells Claude to turn the switch on when it is off', async () => {
      setFleet({ usageSwitchGet: vi.fn(async () => ({ installed: false, error: null })) });
      render(<UsagePopover />);
      await waitFor(() => expect(screen.getByText('Turn on Usage and context in Settings')).toBeTruthy());
    });

    it('shows "No data yet" for Claude when the switch is on but there is no data', async () => {
      setFleet();
      render(<UsagePopover />);
      await waitFor(() => expect(screen.getByText('No data yet')).toBeTruthy());
    });

    it('shows "No Codex usage in the last 8 days" when codex is null', async () => {
      setFleet();
      render(<UsagePopover />);
      await waitFor(() => expect(screen.getByText('No Codex usage in the last 8 days')).toBeTruthy());
    });

    it('does not crash and shows the empty states when window.fleet is unavailable', async () => {
      (globalThis as never as { window: { fleet: unknown } }).window.fleet = undefined;
      expect(() => render(<UsagePopover />)).not.toThrow();
      await waitFor(() => expect(screen.getByText('No Codex usage in the last 8 days')).toBeTruthy());
    });
  });

  describe('bars', () => {
    const now = 1_700_000_000_000;

    it("shows Claude's 5-hour and Weekly bars with percent used and the reset time", async () => {
      setFleet({
        usageGet: vi.fn(async () => ({
          claude: {
            fiveHour: { usedPct: 42, resetsAt: now + 2 * 3_600_000 + 10 * 60_000 },
            sevenDay: { usedPct: 18, resetsAt: now + 3 * 86_400_000 },
            updatedAt: now - 3 * 60_000,
          },
          codex: null,
        })),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);
      render(<UsagePopover />);
      await vi.waitFor(() => expect(screen.getByText('5-hour')).toBeTruthy());
      expect(screen.getByText('42% used')).toBeTruthy();
      expect(screen.getByText('resets in 2h 10m')).toBeTruthy();
      expect(screen.getByText('Weekly')).toBeTruthy();
      expect(screen.getByText('18% used')).toBeTruthy();
      expect(screen.getByText('updated 3m ago')).toBeTruthy();
    });

    it("labels Codex's bars from windowMinutes, not the slot name, and shows the secondary bar when present", async () => {
      setFleet({
        usageGet: vi.fn(async () => ({
          claude: null,
          codex: {
            primary: { usedPct: 27, windowMinutes: 10_080, resetsAt: null },
            secondary: { usedPct: 5, windowMinutes: 300, resetsAt: null },
            updatedAt: now,
          },
        })),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);
      render(<UsagePopover />);
      await vi.waitFor(() => expect(screen.getByText('Weekly')).toBeTruthy());
      expect(screen.getByText('27% used')).toBeTruthy();
      expect(screen.getByText('5-hour')).toBeTruthy();
      expect(screen.getByText('5% used')).toBeTruthy();
    });

    // Part A review note: usedPct has no upper cap and resetsAt is not
    // range-checked. The bar must clamp its own visual width/aria-valuenow
    // to 100 while still saying the real, over-100 number in text, and must
    // never print a reset line for a non-finite or past time.
    it('clamps the bar to 100% and omits the reset line for a non-finite resetsAt, while still showing the true percentage', async () => {
      setFleet({
        usageGet: vi.fn(async () => ({
          claude: {
            fiveHour: { usedPct: 142, resetsAt: Number.NaN },
            updatedAt: now,
          },
          codex: null,
        })),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const { container } = render(<UsagePopover />);
      await vi.waitFor(() => expect(screen.getByText('142% used')).toBeTruthy());
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.getAttribute('aria-valuenow')).toBe('100');
      expect((container.querySelector('.usagebar-fill') as HTMLElement).style.width).toBe('100%');
      expect(container.querySelector('.usagebar-reset')).toBeNull();
    });

    it('omits the reset line for a resetsAt already in the past', async () => {
      setFleet({
        usageGet: vi.fn(async () => ({
          claude: { fiveHour: { usedPct: 10, resetsAt: now - 1000 }, updatedAt: now },
          codex: null,
        })),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const { container } = render(<UsagePopover />);
      await vi.waitFor(() => expect(screen.getByText('10% used')).toBeTruthy());
      expect(container.querySelector('.usagebar-reset')).toBeNull();
    });

    it('exposes each bar as an accessible progressbar with a name carrying its label and percent', async () => {
      setFleet({
        usageGet: vi.fn(async () => ({
          claude: { fiveHour: { usedPct: 42, resetsAt: null }, updatedAt: now },
          codex: null,
        })),
      });
      render(<UsagePopover />);
      await waitFor(() => {
        expect(screen.getByRole('progressbar', { name: /5-hour.*42% used/ })).toBeTruthy();
      });
    });

    // David's own bug report: the popover ran off the window's right edge
    // and clipped the % text on each bar row. The reset above (UsagePopover
    // .css/LaunchBar.css) fixes where the popover sits; this pins that the
    // percentage is a real, visible text node on the row itself -- not
    // something that only exists inside the progressbar's aria-label -- so
    // there is something on screen for that fix to actually show.
    it('shows each bar row\'s percent as visible text, not only inside the progressbar\'s aria-label', async () => {
      setFleet({
        usageGet: vi.fn(async () => ({
          claude: {
            fiveHour: { usedPct: 57, resetsAt: null },
            sevenDay: { usedPct: 18, resetsAt: null },
            updatedAt: now,
          },
          codex: null,
        })),
      });
      const { container } = render(<UsagePopover />);
      await waitFor(() => expect(screen.getByText('57% used')).toBeTruthy());
      const heads = container.querySelectorAll('.usagebar-head');
      expect(heads.length).toBe(2);
      // Each row's own visible head, not merely the aria-label on its
      // progressbar sibling -- textContent only ever reflects real nodes.
      expect(heads[0]!.textContent).toContain('57%');
      expect(heads[1]!.textContent).toContain('18%');
    });
  });

  describe('refresh', () => {
    it('fetches usage once on mount', async () => {
      const usageGet = vi.fn(async () => ({ claude: null, codex: null }));
      setFleet({ usageGet });
      render(<UsagePopover />);
      await waitFor(() => expect(usageGet).toHaveBeenCalledTimes(1));
    });

    it('refreshes every 30 seconds while mounted, and stops once unmounted', async () => {
      const usageGet = vi.fn(async () => ({ claude: null, codex: null }));
      setFleet({ usageGet });
      vi.useFakeTimers();
      const { unmount } = render(<UsagePopover />);
      await vi.waitFor(() => expect(usageGet).toHaveBeenCalledTimes(1));

      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(usageGet).toHaveBeenCalledTimes(2);

      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(usageGet).toHaveBeenCalledTimes(3);

      unmount();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(usageGet).toHaveBeenCalledTimes(3);
    });
  });
});
