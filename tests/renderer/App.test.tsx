import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
