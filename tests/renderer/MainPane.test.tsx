import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MainPane } from '../../src/renderer/components/MainPane.tsx';
import { getFavourites, addFavourite, reloadFavourites } from '../../src/renderer/state/favourites.ts';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent.click substitutes for
// userEvent.click, matching every other renderer test file.

// Wraps the real ContextChip so the "no stale flash on switch" test below
// can see every value it was ever called with -- INCLUDING one React
// discards mid-render before committing (the fix's whole point), which a
// DOM assertion taken after rerender() returns can never observe: by then
// every pending render has already settled. vi.hoisted is required because
// vi.mock's factory is hoisted above this file's own top-level statements.
const chipCalls = vi.hoisted(() => [] as unknown[]);
vi.mock('../../src/renderer/components/ContextChip.tsx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/components/ContextChip.tsx')>();
  return {
    ...actual,
    ContextChip: (props: Parameters<typeof actual.ContextChip>[0]) => { chipCalls.push(props.context); return actual.ContextChip(props); },
  };
});

const sessions = [{ pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'x', cwd: '/a', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: 's1', tmux: true }] as never[];

// The selection===null branch renders FleetView, which reaches
// window.fleet directly for History's own paging and each open card's
// kill/reveal (tests/renderer/FleetView.test.tsx uses the identical
// setup) -- without it, FleetView's own preload-missing guard fires
// first and neither `.fleet` nor the rail ever gets a chance to render.
beforeEach(() => {
  (globalThis as unknown as { window: { fleet: unknown } }).window.fleet = {
    listHistory: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', sessions: [], total: 0 }),
    killSession: vi.fn().mockResolvedValue({ status: 'killed' }),
    revealSession: vi.fn().mockResolvedValue({ status: 'revealed' }),
    reattach: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
    resume: vi.fn().mockResolvedValue({ status: 'failed', reason: 'not exercised' }),
    // The split view's default 'conversation' pane (ConversationView) reaches
    // this directly for any selection whose session has a non-null sessionId.
    conversation: vi.fn().mockResolvedValue({ turns: [], nextCursor: null }),
  };
  // favourites.ts is a module-scoped singleton store (settings.ts's own
  // shape) -- clearing localStorage alone leaves the in-memory value
  // untouched, so every test also reloads it.
  localStorage.clear();
  reloadFavourites();
});

describe('MainPane', () => {
  it('shows the full grid and no rail when nothing is selected', () => {
    const { container } = render(<MainPane selection={null} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    expect(container.querySelector('.rail')).toBeNull();
    expect(container.querySelector('.fleet')).toBeTruthy();
  });

  it('shows the rail and hides the grid once a session is selected', () => {
    const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    expect(container.querySelector('.rail')).toBeTruthy();
    expect(container.querySelector('.fleet')).toBeNull();
  });

  it('offers the toggle and reports the switch', async () => {
    const onSetView = vi.fn();
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={onSetView} onClear={() => {}} railSide="left" />);
    fireEvent.click(screen.getByRole('button', { name: /terminal/i }));
    expect(onSetView).toHaveBeenCalledWith('terminal');
  });

  it('puts the rail on the chosen side', () => {
    const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="right" />);
    expect(container.querySelector('.rail.right')).toBeTruthy();
  });

  // "All sessions" is the only way back out of the split view (there is no
  // other visible affordance that clears the selection) -- proven directly,
  // not inferred from onClear existing as a prop.
  it('clears the selection from the "All sessions" control', () => {
    const onClear = vi.fn();
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={onClear} railSide="left" />);
    fireEvent.click(screen.getByRole('button', { name: /all sessions/i }));
    expect(onClear).toHaveBeenCalled();
  });

  // Ruling 3 (task-12-13-report.md): sessionId is `string | null` and null
  // is the common case on a real machine, not an edge case -- coercing it
  // to '' would make ConversationView show the wrong message for most real
  // sessions. This proves the split-view path hands it through unchanged
  // for a session whose match is ambiguous or absent.
  it('passes a null sessionId through rather than coercing it to an empty string', () => {
    const ambiguous = [{ pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'x', cwd: '/a', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: null }] as never[];
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={ambiguous} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    expect(screen.getByText(/transcript can't be identified/i)).toBeTruthy();
  });

  // Bug 1's fix reaches all the way out here: MainPane must hand
  // ConversationView the session's own `match`, not just its sessionId, so
  // the specific ambiguous/unknown wording (not the generic fallback above)
  // is what a real user actually sees.
  it("passes the session's match quality through, so ConversationView shows the specific ambiguous wording, not the generic fallback", () => {
    const ambiguous = [{ pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'x', cwd: '/a', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: null, match: 'ambiguous' }] as never[];
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={ambiguous} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    expect(screen.getByText(/several recorded sessions/i)).toBeTruthy();
    expect(screen.queryByText(/transcript can't be identified\.$/)).toBeNull();
  });

  // The grid (FleetView) always wired reveal; the rail did not, so in the
  // split view the host label rendered as plain text and clicking it did
  // nothing. Proven at this level so the whole MainPane -> SessionRail ->
  // OpenSessionCard -> window.fleet path is covered, not just the card.
  it('lets a rail card bring its host terminal forward, same as the grid', () => {
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    fireEvent.click(screen.getByRole('button', { name: /show this session in/i }));
    expect((window as unknown as { fleet: { revealSession: ReturnType<typeof vi.fn> } }).fleet.revealSession).toHaveBeenCalledWith(1);
  });

  // Task 5 (quick-answers design §9): Answer on a waiting session now
  // routes straight to the Conversation view (selects this pid, then
  // switches) -- this replaces the old route through Open Terminal, since
  // the prompt card (or its waiting-card fallback) lives in the
  // Conversation view, not the Terminal one.
  it('routes a waiting card straight to the conversation view via Answer', () => {
    const waiting = [{ pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'waiting_input', lastProse: 'Pick a color?', cwd: '/a', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: 's1', tmux: true }] as never[];
    const onSelect = vi.fn();
    const onSetView = vi.fn();
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={waiting} onSelect={onSelect} onSetView={onSetView} onClear={() => {}} railSide="left" />);
    fireEvent.click(screen.getByRole('button', { name: /answer llm-workspace, pid 1/i }));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(onSetView).toHaveBeenCalledWith('conversation');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Spec §3.7: the rail already names the project, so the pane header
  // carries the session's FOLDER PATH instead -- with a title for the
  // untruncated value, since a deep path will not fit.
  it('shows the session folder path in the header, not the project name, with a full-value title', () => {
    const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    const title = container.querySelector('.panetitle')!;
    expect(title.textContent).toBe('/a');
    expect(title.getAttribute('title')).toBe('/a');
  });

  // David's own bug report: the header's folder path did not abbreviate the
  // home directory. The visible text shortens to "~/...", but the title
  // attribute (hover) keeps the full, real path -- never the abbreviated
  // form -- so the exact underlying cwd is always reachable.
  it('abbreviates a home-directory cwd to ~ in the header, while the title keeps the full path', () => {
    const homeSession = [{ ...(sessions[0] as unknown as object), cwd: '/Users/davidbrabbins/Documents/David/llm-workspace' }] as never[];
    const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={homeSession} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    const title = container.querySelector('.panetitle')!;
    expect(title.textContent).toBe('~/Documents/David/llm-workspace');
    expect(title.getAttribute('title')).toBe('/Users/davidbrabbins/Documents/David/llm-workspace');
  });

  it('hands the conversation the session provider, so the agent glyph is that session\'s own', () => {
    const codex = [{ ...(sessions[0] as unknown as object), provider: 'codex' }] as never[];
    (window as unknown as { fleet: { conversation: ReturnType<typeof vi.fn> } }).fleet.conversation =
      vi.fn().mockResolvedValue({
        turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'assistant', text: 'ok', steps: [] }],
        nextCursor: null,
      });
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={codex} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    return waitFor(() => expect(screen.getByText('Codex')).toBeTruthy());
  });

  // Live updates (spec §3.3): the pane refetches on the one signal the app
  // already pushes. MainPane is the only component that holds it.
  it('hands the conversation the session\'s events count, so the pane can refresh itself', async () => {
    const api = (window as unknown as { fleet: { conversation: ReturnType<typeof vi.fn> } }).fleet;
    api.conversation = vi.fn()
      .mockResolvedValueOnce({ turns: [], nextCursor: null })
      .mockResolvedValue({
        turns: [{ id: 9, ts: '2026-09-12T10:00:00Z', role: 'assistant', text: 'live', steps: [] }],
        nextCursor: null,
      });
    const bumped = [{ ...(sessions[0] as unknown as object), events: 2 }] as never[];
    const { rerender } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    await waitFor(() => expect(api.conversation).toHaveBeenCalledTimes(1));
    rerender(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={bumped} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    await waitFor(() => expect(screen.getByText('live')).toBeTruthy());
  });

  // Usage design, Part B: the conversation header's context chip
  // (ContextChip), fed from OpenSession.context (the 5s sweep) until
  // ConversationView's own onContext callback reports something fresher.
  describe('the header context chip', () => {
    it('is absent when the session has no context yet', () => {
      const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      expect(container.querySelector('.ctxchip')).toBeNull();
    });

    it("shows the session's swept context in the header", () => {
      const withContext = [{ ...(sessions[0] as unknown as object), context: { usedTokens: 462_400, windowTokens: 1_000_000, leftPct: 44 } }] as never[];
      const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={withContext} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      // Scoped to .panehead: the same session also renders its own chip on
      // the rail card (OpenSessionCard), so an unscoped query matches twice.
      expect(within(container.querySelector('.panehead')!).getByText('462k · 44% left')).toBeTruthy();
    });

    // The header must not keep showing a departed session's reading once a
    // different pid is selected -- proven here via the swept prop, which is
    // the only source these fixtures ever populate (window.fleet carries no
    // watchSession/onSessionLive in this file's beforeEach, so
    // ConversationView's live-push side of the fold never fires).
    it('does not carry a reading over to a newly selected session with none', () => {
      const withContext = [
        { ...(sessions[0] as unknown as object), context: { usedTokens: 462_400, windowTokens: 1_000_000, leftPct: 44 } },
        { pid: 2, project: 'other', provider: 'claude', activity: 'idle', lastProse: null, cwd: '/b', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: 's2', tmux: true, context: null },
      ] as never[];
      const { container, rerender } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={withContext} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      const panehead = () => container.querySelector('.panehead') as HTMLElement;
      expect(within(panehead()).getByText('462k · 44% left')).toBeTruthy();
      rerender(<MainPane selection={{ pid: 2, view: 'conversation' }} sessions={withContext} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      expect(within(panehead()).queryByText('462k · 44% left')).toBeNull();
    });

    // Review finding: MainPane's own liveContext (fed by ConversationView's
    // onContext callback, which reports the LIVE-push reading -- a
    // different, fresher source than the swept `context` prop the two tests
    // above exercise) used to reset via a useEffect keyed on the pid. An
    // effect only runs after the pid-changed render has already committed
    // and painted, so the DEPARTED session's live reading would still be
    // passed to ContextChip for that one commit. Checking the DOM after
    // rerender() returns cannot catch this -- by then every render this
    // update triggers, including a since-corrected one, has already
    // settled -- so this reads the wrapped ContextChip's own call log
    // (declared at the top of this file) instead, which records every
    // value ContextChip was ever invoked with, in order.
    it('never passes the departed session\'s live-pushed context to the header chip, not even for one commit', () => {
      const push = new Map<number, (p: unknown) => void>();
      const watchSession = vi.fn().mockResolvedValue(true);
      const onSessionLive = vi.fn((cb: (p: unknown) => void) => {
        // main's watch is a single slot -- the latest subscriber is the
        // live one, same as the real bridge.
        push.set(0, cb);
        return () => {};
      });
      const api = (window as unknown as { fleet: Record<string, unknown> }).fleet;
      Object.assign(api, { watchSession, onSessionLive });

      const both = [
        { ...(sessions[0] as unknown as object), pid: 1, sessionId: 's1', context: null },
        { pid: 2, project: 'other', provider: 'claude', activity: 'idle', lastProse: null, cwd: '/b', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: 's2', tmux: true, context: null },
      ] as never[];

      const { container, rerender } = render(
        <MainPane selection={{ pid: 1, view: 'conversation' }} sessions={both} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />,
      );

      act(() => {
        push.get(0)?.({
          version: 1, pid: 1, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null,
          context: { usedTokens: 900_000, windowTokens: 1_000_000, leftPct: 10 },
        });
      });
      expect(within(container.querySelector('.panehead')!).getByText('900k · 10% left')).toBeTruthy();

      chipCalls.length = 0;
      rerender(<MainPane selection={{ pid: 2, view: 'conversation' }} sessions={both} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);

      // Every ContextChip call made anywhere in the tree while rendering
      // pid 2 (the header's own instance, plus each rail card's) -- none
      // of them may ever carry pid 1's departed 900k reading.
      const everShowedStaleReading = chipCalls.some(c => (c as { usedTokens?: number } | null)?.usedTokens === 900_000);
      expect(everShowedStaleReading).toBe(false);
      expect(within(container.querySelector('.panehead')!).queryByText('900k · 10% left')).toBeNull();
    });
  });

  it('lets the conversation message its own session, and routes a choice to the terminal', async () => {
    const api = (window as unknown as { fleet: Record<string, ReturnType<typeof vi.fn>> }).fleet;
    api.sendKeys = vi.fn().mockResolvedValue({ status: 'refused', reason: 'prompt_open' });
    const onSetView = vi.fn();
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={onSetView} onClear={() => {}} railSide="left" />);
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'go' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.sendKeys).toHaveBeenCalledWith(1, 'go'));
    fireEvent.click(screen.getByRole('button', { name: /^open terminal$/i }));
    expect(onSetView).toHaveBeenCalledWith('terminal');
  });

  // Favourite folders: David's addition -- a star in the conversation
  // header, on the SAME shared store as LaunchBar's own (state/favourites.ts),
  // so a session's folder can be favourited without ever typing its path
  // into the launch bar.
  describe('the header favourite star', () => {
    it('is unpressed for a folder that is not yet a favourite', () => {
      render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      const star = screen.getByRole('button', { name: 'Add a to favourites' }) as HTMLButtonElement;
      expect(star.getAttribute('aria-pressed')).toBe('false');
      expect(star.disabled).toBe(false);
    });

    it('adds the session folder to the shared store, live, with no reload', () => {
      render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      fireEvent.click(screen.getByRole('button', { name: 'Add a to favourites' }));
      expect(getFavourites()).toContain('/a');
      expect(screen.getByRole('button', { name: 'Remove a from favourites' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('shows pressed, with a Remove label, when the folder is already a favourite', () => {
      addFavourite('/a');
      render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      const star = screen.getByRole('button', { name: 'Remove a from favourites' }) as HTMLButtonElement;
      expect(star.getAttribute('aria-pressed')).toBe('true');
    });

    it('removes the session folder from the shared store', () => {
      addFavourite('/a');
      render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      fireEvent.click(screen.getByRole('button', { name: 'Remove a from favourites' }));
      expect(getFavourites()).not.toContain('/a');
    });

    it('is disabled when the session has no working directory at all', () => {
      const noCwd = [{ ...(sessions[0] as unknown as object), cwd: null }] as never[];
      render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={noCwd} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
      const star = screen.getByRole('button', { name: 'Add to favourites' }) as HTMLButtonElement;
      expect(star.disabled).toBe(true);
    });

    // The path is the only control in this row that shrinks -- proven
    // directly against the stylesheet, since jsdom computes no layout and
    // so cannot prove an overflow visually.
    it('never shrinks, unlike the folder path beside it', () => {
      const css = readFileSync('src/renderer/components/MainPane.css', 'utf8');
      expect(css).toMatch(/\.panefav\s*\{[^}]*flex:\s*none/);
    });
  });
});
