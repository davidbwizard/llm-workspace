import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainPane } from '../../src/renderer/components/MainPane.tsx';

// @testing-library/user-event is not a project dependency (see
// tests/renderer/SessionRail.test.tsx) -- fireEvent.click substitutes for
// userEvent.click, matching every other renderer test file.

const sessions = [{ pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'x', cwd: '/a', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: 's1' }] as never[];

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
    conversation: vi.fn().mockResolvedValue([]),
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
});
