import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { App, ErrorBoundary } from '../../src/renderer/App.tsx';
import { reloadSettings, setSettings } from '../../src/renderer/state/settings.ts';

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  it('renders a specific message instead of a blank window when a child throws', () => {
    // React logs a caught render error to console.error by default, on top
    // of calling componentDidCatch -- expected noise for this test, not a
    // real warning, so it's suppressed rather than left to clutter output.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    // Scoped to the message paragraph specifically -- the stack trace
    // rendered below it (next test) also contains "kaboom" (the error's
    // own first stack line), so a page-wide text search would ambiguously
    // match both.
    expect(container.querySelector('p')?.textContent).toMatch(/kaboom/);
    consoleError.mockRestore();
  });

  // The bug this fixes: componentDidCatch used to be empty, so a render
  // throw produced the symptom (this message) with no way to find WHERE it
  // happened short of re-attaching devtools to a window that may already
  // be gone. Both halves of the fix are asserted here: a record a person
  // can find without devtools (console.error), and one visible in the
  // window itself (the rendered stack).
  it('records the error and component stack, and shows the stack on screen', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<ErrorBoundary><Boom /></ErrorBoundary>);

    expect(consoleError).toHaveBeenCalledWith(
      'FleetView render crashed:', expect.any(Error), expect.stringContaining('Boom'));

    const stack = container.querySelector('.crash-stack');
    expect(stack).toBeTruthy();
    expect(stack!.textContent).toMatch(/kaboom/);   // Error#stack's own first line
    expect(stack!.textContent).toMatch(/at Boom/);  // the component stack

    consoleError.mockRestore();
  });
});

describe('App -- appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    reloadSettings();
    document.documentElement.removeAttribute('data-theme');
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', openSessions: [] }),
      listHistory: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', sessions: [], total: 0 }),
      onFleet: vi.fn(() => () => {}),
      setTheme: vi.fn().mockResolvedValue({ status: 'set', theme: 'system' }),
    };
  });

  // 'system' must set NO attribute: theme.css's light block is guarded as
  // :root:not([data-theme="dark"]) inside a prefers-color-scheme query, so
  // the OS setting only wins while nothing explicit is on the root.
  it('sets no data-theme for System, and tells main the same thing', async () => {
    render(<App />);
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));
    expect((window as unknown as { fleet: { setTheme: ReturnType<typeof vi.fn> } }).fleet.setTheme)
      .toHaveBeenCalledWith('system');
  });

  it('stamps an explicit choice on the root element and tells main', async () => {
    setSettings({ appearance: 'light' });
    render(<App />);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    expect((window as unknown as { fleet: { setTheme: ReturnType<typeof vi.fn> } }).fleet.setTheme)
      .toHaveBeenCalledWith('light');
  });
});

// Cmd+1..9: a window-level keydown listener, installed once at the app
// level (App.tsx's own effect has an empty dependency array), that selects
// an open session the same way clicking its card does. Session order here
// is plain payload order throughout -- none of these fixtures ever produce
// an unread promotion, so useFleet.ts's orderedSessions (tested directly,
// with that promotion, in useFleet.test.tsx) matches it exactly.
describe('App -- Cmd+1..9 session shortcuts', () => {
  const openSessions = (n: number) => Array.from({ length: n }, (_, i) => ({
    pid: i + 1, project: `proj-${i + 1}`, provider: 'claude', activity: null, lastProse: null,
    cwd: `/proj-${i + 1}`, host: 'iterm2', ageSeconds: 60, rssBytes: null, events: null,
    sessionId: null, tmux: false, junk: false, match: 'unknown', context: null,
  })) as never[];

  beforeEach(() => {
    localStorage.clear();
    reloadSettings();
    document.documentElement.removeAttribute('data-theme');
  });

  async function renderWithSessions(n: number) {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', openSessions: openSessions(n) }),
      listHistory: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', sessions: [], total: 0 }),
      onFleet: vi.fn(() => () => {}),
      setTheme: vi.fn().mockResolvedValue({ status: 'set', theme: 'system' }),
      killSession: vi.fn().mockResolvedValue({ status: 'killed' }),
      revealSession: vi.fn().mockResolvedValue({ status: 'revealed' }),
      reattach: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
      resume: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
    };
    const result = render(<App />);
    await waitFor(() => expect(screen.getByText(`${n} open`)).toBeTruthy());
    return result;
  }

  function pressCmd(key: string, extra: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true, bubbles: true, ...extra });
    act(() => { window.dispatchEvent(event); });
    return event;
  }

  it('selects the Nth open session, in the sidebar/fleet order, on Cmd+N', async () => {
    const { container } = await renderWithSessions(3);
    pressCmd('2');
    await waitFor(() => expect(container.querySelector('.panetitle')?.textContent).toBe('/proj-2'));
  });

  it('selects the last open session on Cmd+9', async () => {
    const { container } = await renderWithSessions(11);
    pressCmd('9');
    await waitFor(() => expect(container.querySelector('.panetitle')?.textContent).toBe('/proj-11'));
  });

  it('ignores Cmd+N when there are fewer open sessions than N, and never prevents default', async () => {
    const { container } = await renderWithSessions(2);
    const event = pressCmd('5');
    expect(container.querySelector('.panetitle')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it('prevents default only once it has actually selected a session', async () => {
    await renderWithSessions(3);
    const event = pressCmd('2');
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores the chord when Ctrl, Alt or Shift rides along with Cmd', async () => {
    const { container } = await renderWithSessions(3);
    pressCmd('2', { ctrlKey: true });
    pressCmd('2', { altKey: true });
    pressCmd('2', { shiftKey: true });
    expect(container.querySelector('.panetitle')).toBeNull();
  });

  it('ignores a bare digit with no Cmd (meta) modifier', async () => {
    const { container } = await renderWithSessions(3);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', cancelable: true, bubbles: true })); });
    expect(container.querySelector('.panetitle')).toBeNull();
  });

  it('selects through the same path a card click uses, defaulting to the Conversation view', async () => {
    await renderWithSessions(3);
    pressCmd('1');
    await waitFor(() => expect(screen.getByRole('button', { name: /^conversation$/i }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('removes the listener on unmount', async () => {
    const { unmount } = await renderWithSessions(3);
    unmount();
    expect(() => pressCmd('1')).not.toThrow();
  });
});
