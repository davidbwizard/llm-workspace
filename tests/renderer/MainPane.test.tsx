import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MainPane } from '../../src/renderer/components/MainPane.tsx';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent.click substitutes for
// userEvent.click, matching every other renderer test file.

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
});
