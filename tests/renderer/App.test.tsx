import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { App, ErrorBoundary } from '../../src/renderer/App.tsx';
import { reloadSettings, setSettings } from '../../src/renderer/state/settings.ts';
import { reloadGroups } from '../../src/renderer/state/groups.ts';

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
// an open session the same way clicking its card does -- now a SLOT, per
// David's own model ("slot 1 is always slot 1"), built by
// src/renderer/state/useRailSlots.ts. Every fixture here uses a distinct
// cwd per session, so folder stacking never engages and slot order is
// plain payload order throughout, same as it always was for this describe
// block.
describe('App -- Cmd+1..9 session shortcuts', () => {
  const openSessions = (n: number) => Array.from({ length: n }, (_, i) => ({
    pid: i + 1, project: `proj-${i + 1}`, provider: 'claude', activity: null, lastProse: null,
    cwd: `/proj-${i + 1}`, host: 'iterm2', ageSeconds: 60, rssBytes: null, events: null,
    sessionId: null, tmux: false, junk: false, match: 'unknown', context: null,
  })) as never[];

  beforeEach(() => {
    localStorage.clear();
    reloadSettings();
    // useRailSlots (App.tsx) now reads groups.ts's own persisted row order
    // -- App never depended on that store before this. Same pairing
    // SessionRail.test.tsx's own top-level beforeEach uses, and for the
    // same reason: localStorage.clear() alone does not touch groups.ts's
    // in-memory singleton, only reloadGroups() does.
    reloadGroups();
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

  // REWRITTEN for the slot-hotkeys task, and a deliberate behaviour change,
  // not a bug fix to a test that was merely inconvenient: the old handler
  // special-cased 9 to mean "the LAST session", so with more than nine open
  // it selected something OTHER than whatever card was actually showing a
  // "9" badge (which stopped at the ninth). That directly contradicts
  // David's own slot rule -- "slot 1 is always slot 1" -- for exactly the
  // population (>9 open sessions) it used to matter for, so it is dropped:
  // Cmd+9 now selects slot 9, like every other digit, and always matches
  // whatever number that card is showing.
  it('selects the ninth SLOT on Cmd+9, not the last session overall', async () => {
    const { container } = await renderWithSessions(11);
    pressCmd('9');
    await waitFor(() => expect(container.querySelector('.panetitle')?.textContent).toBe('/proj-9'));
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

  // Item 3 of the slot-hotkeys task: what the chord does on a STACK row --
  // a folded stack is one slot, and the chord has to land somewhere a
  // person can actually see, so it selects the member that most needs them
  // and opens the stack in the same keystroke.
  describe('on a folded stack', () => {
    async function renderWithFleetSessions(list: unknown[]) {
      (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
        listFleet: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', openSessions: list }),
        listHistory: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', sessions: [], total: 0 }),
        onFleet: vi.fn(() => () => {}),
        setTheme: vi.fn().mockResolvedValue({ status: 'set', theme: 'system' }),
        killSession: vi.fn().mockResolvedValue({ status: 'killed' }),
        revealSession: vi.fn().mockResolvedValue({ status: 'revealed' }),
        reattach: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
        resume: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
      };
      const result = render(<App />);
      await waitFor(() => expect(screen.getByText(`${list.length} open`)).toBeTruthy());
      return result;
    }

    const member = (pid: number, activity: string | null) => ({
      pid, project: 'repo', provider: 'claude', activity, lastProse: null,
      cwd: '/repo', host: 'iterm2', ageSeconds: 60, rssBytes: null, events: null,
      sessionId: null, tmux: false, junk: false, match: 'unknown', context: null,
    });

    it('selects the waiting member and opens the stack, on one chord', async () => {
      // pid 2 is the one waiting -- if the chord just picked the first
      // member regardless, this would select pid 1 instead.
      const stack = [member(1, 'idle'), member(2, 'waiting_input'), member(3, 'idle')] as never[];
      const { container } = await renderWithFleetSessions(stack);
      pressCmd('1'); // one slot: the whole stack
      await waitFor(() => expect(container.querySelector('.stack.open')).toBeTruthy());
      const selected = container.querySelector('.railitem.sel');
      expect(selected?.querySelector('[aria-label*="pid 2"]')).toBeTruthy();
    });

    it('selects the first member when none of them are waiting', async () => {
      const stack = [member(1, 'idle'), member(2, 'idle'), member(3, 'idle')] as never[];
      const { container } = await renderWithFleetSessions(stack);
      pressCmd('1');
      await waitFor(() => expect(container.querySelector('.stack.open')).toBeTruthy());
      const selected = container.querySelector('.railitem.sel');
      expect(selected?.querySelector('[aria-label*="pid 1"]')).toBeTruthy();
    });

    // A stack already open must stay open, not toggle closed -- the guard is
    // `!isStackOpen`, so a second chord on the same stack is a no-op on its
    // open state, unlike an unconditional toggleStack() call would be.
    it('leaves an already-open stack open on a second chord, rather than closing it', async () => {
      const stack = [member(1, 'idle'), member(2, 'waiting_input')] as never[];
      const { container } = await renderWithFleetSessions(stack);
      pressCmd('1');
      await waitFor(() => expect(container.querySelector('.stack.open')).toBeTruthy());
      pressCmd('1');
      await waitFor(() => expect(container.querySelector('.railitem.sel')).toBeTruthy());
      expect(container.querySelector('.stack.open')).toBeTruthy();
    });
  });
});

// Layout A, as David picked it: the window opens to the first-run screen
// and nothing else until they continue, with the launch bar visible above
// it and inert. When the rule says not to take over, the app opens normally
// and this is invisible.
describe('the first-run takeover (layout A)', () => {
  const cap = (available: boolean, reason: string | null = null) => ({ available, reason, warning: null });

  function dep(id: string, state: string, name: string) {
    return {
      id, name, state,
      version: state === 'ok' ? '1.0' : null,
      purpose: `What ${name} is for.`,
      install: [{ command: `brew install ${id}`, requires: 'homebrew', note: null }],
      probe: `${id} --version`,
      doctor: null,
      detail: `${name} detail.`,
    };
  }

  function mount(checks: ReturnType<typeof dep>[], over: Record<string, unknown> = {}) {
    const readiness = {
      checkedAt: '2026-09-21T12:00:00.000Z',
      checks,
      launch: { claude: cap(true), codex: cap(true) },
      attach: cap(true),
      history: cap(true),
      homebrew: true,
      ...over,
    };
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', openSessions: [] }),
      listHistory: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', sessions: [], total: 0 }),
      onFleet: vi.fn(() => () => {}),
      setTheme: vi.fn().mockResolvedValue({ status: 'set', theme: 'system' }),
      hooksGet: vi.fn().mockResolvedValue({ installed: false, error: null }),
      checksGet: vi.fn().mockResolvedValue({ status: 'ready', readiness }),
      checksRun: vi.fn().mockResolvedValue(readiness),
      onChecks: vi.fn(() => () => {}),
    };
    return render(<App />);
  }

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* jsdom always has it; belt and braces */ }
  });

  it('opens to the screen and nothing else when something is missing', async () => {
    mount([dep('tmux', 'ok', 'tmux'), dep('claude', 'missing', 'Claude Code'), dep('codex', 'ok', 'Codex')]);
    await waitFor(() => expect(screen.getByText('One thing to install first')).toBeTruthy());
    // The pane behind it is not rendered at all -- this is a takeover, not
    // a banner.
    expect(document.querySelector('.mainpane')).toBeNull();
  });

  it('leaves the launch bar visible above it, and inert', async () => {
    mount([dep('tmux', 'ok', 'tmux'), dep('claude', 'missing', 'Claude Code'), dep('codex', 'ok', 'Codex')]);
    await waitFor(() => expect(screen.getByText('One thing to install first')).toBeTruthy());
    const bar = document.querySelector('.launchbar')!;
    // Visible: still in the document, so someone can see what they will get.
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('aria-disabled')).toBe('true');
    // And really disabled, not just faded -- a keyboard user meets the same
    // wall a mouse user does.
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Working directory') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).disabled).toBe(true);
  });

  it('opens normally, with no screen at all, when everything is installed', async () => {
    mount([dep('tmux', 'ok', 'tmux'), dep('claude', 'ok', 'Claude Code'), dep('codex', 'ok', 'Codex')]);
    await waitFor(() => expect(document.querySelector('.mainpane')).toBeTruthy());
    expect(screen.queryByText(/to install first/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Launch' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('gets out of the way for good once they continue', async () => {
    mount([dep('tmux', 'ok', 'tmux'), dep('claude', 'missing', 'Claude Code'), dep('codex', 'ok', 'Codex')]);
    await waitFor(() => expect(screen.getByText('One thing to install first')).toBeTruthy());

    act(() => { screen.getByRole('button', { name: 'Continue without Claude Code' }).click(); });

    await waitFor(() => expect(document.querySelector('.mainpane')).toBeTruthy());
    expect(screen.queryByText('One thing to install first')).toBeNull();
    // The bar comes back to life with it.
    expect(document.querySelector('.launchbar')!.getAttribute('aria-disabled')).toBeNull();
  });

  it('does not take over again on the next launch once they have continued', async () => {
    const deps = [dep('tmux', 'ok', 'tmux'), dep('claude', 'missing', 'Claude Code'), dep('codex', 'ok', 'Codex')];
    const first = mount(deps);
    await waitFor(() => expect(screen.getByText('One thing to install first')).toBeTruthy());
    act(() => { screen.getByRole('button', { name: 'Continue without Claude Code' }).click(); });
    await waitFor(() => expect(document.querySelector('.mainpane')).toBeTruthy());
    first.unmount();

    // A fresh launch, same missing dependency. Design §4: a missing tool
    // costs one capability, not the app -- walling someone every launch
    // would punish exactly the person who made an informed choice.
    mount(deps);
    await waitFor(() => expect(document.querySelector('.mainpane')).toBeTruthy());
    expect(screen.queryByText('One thing to install first')).toBeNull();
  });

  it('takes over again on the next launch when the core is gone', async () => {
    const deps = [dep('tmux', 'missing', 'tmux'), dep('claude', 'ok', 'Claude Code'), dep('codex', 'ok', 'Codex')];
    const noAttach = { attach: cap(false, 'tmux is not installed.') };
    const first = mount(deps, noAttach);
    await waitFor(() => expect(screen.getByText('One thing to install first')).toBeTruthy());
    act(() => { screen.getByRole('button', { name: 'Continue without tmux' }).click(); });
    await waitFor(() => expect(document.querySelector('.mainpane')).toBeTruthy());
    first.unmount();

    // Without tmux nothing can be launched or attached, so the normal
    // window would be a set of controls that all refuse.
    mount(deps, noAttach);
    await waitFor(() => expect(screen.getByText('One thing to install first')).toBeTruthy());
  });
});
