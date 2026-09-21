import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MainPane, SIDE_PANEL_MIN_PX } from '../../src/renderer/components/MainPane.tsx';
import { formatBytes } from '../../src/renderer/components/FileViewer.tsx';
import { clearFileProbeCache } from '../../src/renderer/components/FilePath.tsx';
import { reloadFavourites } from '../../src/renderer/state/favourites.ts';

// xterm cannot mount in jsdom (it reaches for matchMedia and a real canvas),
// and this file only needs the Terminal view to EXIST so it can prove the
// viewer steps aside under it. Same stubs as tests/renderer/TerminalView.test.tsx.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    get cols() { return 80; }
    get rows() { return 24; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} } }));

const PID = 1;
const sessions = [{
  pid: PID, project: 'llm-workspace', provider: 'claude', activity: 'idle', lastProse: 'x',
  cwd: '/repo', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: 's1', tmux: true,
}] as never[];

const turns = [{ id: 1, ts: '2026-09-21T10:00:00Z', role: 'assistant', text: 'Recorded in KNOWN_ISSUES.md as agreed.' }];

let fileOpen: ReturnType<typeof vi.fn>;
let widthSpy: ReturnType<typeof vi.spyOn>;

/** jsdom lays nothing out, so the pane body measures 0 and MainPane's
 *  "not laid out yet" guard would keep the default. Pinning the width is
 *  how these tests drive the one thing the placement actually depends on. */
function setPaneWidth(px: number) {
  widthSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: px, height: 600, top: 0, left: 0, right: px, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
}

function renderPane(view: 'conversation' | 'terminal' = 'conversation') {
  return render(
    <MainPane selection={{ pid: PID, view }} sessions={sessions}
      onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />,
  );
}

/** Clicks the KNOWN_ISSUES.md link in the seeded reply. */
async function clickPath() {
  const link = await screen.findByRole('button', { name: 'KNOWN_ISSUES.md' });
  fireEvent.click(link);
}

beforeEach(() => {
  clearFileProbeCache();
  fileOpen = vi.fn(async () => ({
    ok: true as const, action: 'markdown' as const,
    path: '/repo/KNOWN_ISSUES.md', name: 'KNOWN_ISSUES.md', size: 4200, text: '# Known issues\n\nA note.\n',
  }));
  (globalThis as unknown as { window: { fleet: unknown } }).window.fleet = {
    listHistory: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', sessions: [], total: 0 }),
    killSession: vi.fn(), revealSession: vi.fn(), reattach: vi.fn(), resume: vi.fn(),
    conversation: vi.fn().mockResolvedValue({ turns, nextCursor: null }),
    // TerminalView attaches as soon as it mounts; without these the
    // "steps aside under the terminal" test below throws inside a rAF.
    attach: vi.fn().mockResolvedValue({ status: 'attached' }),
    detach: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    sendRaw: vi.fn().mockResolvedValue(undefined),
    onTerminalData: vi.fn(() => () => {}),
    fileProbe: vi.fn(async (_pid: number, candidates: string[]) =>
      ({ ok: true as const, kinds: candidates.map(c => (c === 'KNOWN_ISSUES.md' ? 'markdown' as const : null)) })),
    fileOpen: (...args: unknown[]) => fileOpen(...args),
  };
  reloadFavourites();
  setPaneWidth(SIDE_PANEL_MIN_PX);
});

afterEach(() => {
  widthSpy?.mockRestore();
  document.documentElement.classList.remove('modal-open');
});

describe('formatBytes', () => {
  it('reads the way the mockup does', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4200)).toBe('4.1 KB');
    expect(formatBytes(120 * 1024)).toBe('120 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('opening a file from the conversation', () => {
  it('shows a markdown file in the pane, rendered', async () => {
    renderPane();
    await clickPath();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Known issues' })).toBeTruthy());
    expect(fileOpen).toHaveBeenCalledWith(PID, 'KNOWN_ISSUES.md', undefined);
    expect(screen.getByText('4.1 KB')).toBeTruthy();
  });

  it('shows nothing at all when main revealed the file instead', async () => {
    fileOpen = vi.fn(async () => ({ ok: true as const, action: 'revealed' as const, path: '/repo/x', name: 'x' }));
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(fileOpen).toHaveBeenCalled());
    expect(container.querySelector('.fileviewer')).toBeNull();
  });

  it('stays silent about a refusal an agent caused, rather than blaming the reader', async () => {
    fileOpen = vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const }));
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(fileOpen).toHaveBeenCalled());
    expect(container.querySelector('.fileviewer')).toBeNull();
  });

  it('says so and offers Finder when the file is past the size cap', async () => {
    fileOpen = vi.fn(async () => ({ ok: false as const, reason: 'too_large' as const, name: 'huge.md', size: 900 * 1024 }));
    renderPane();
    await clickPath();
    const note = await screen.findByText(/too large to show here/);
    expect(note.textContent).toMatch(/huge\.md/);
    expect(note.textContent).toMatch(/900 KB/);
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toBeTruthy();
  });

  it('sends the same candidate back for a Reveal, so main rechecks it', async () => {
    renderPane();
    await clickPath();
    await screen.findByRole('button', { name: 'Reveal in Finder' });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    await waitFor(() => expect(fileOpen).toHaveBeenLastCalledWith(PID, 'KNOWN_ISSUES.md', true));
  });

  it('closes on the close button', async () => {
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fileviewer')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    expect(container.querySelector('.fileviewer')).toBeNull();
  });

  it('never survives a switch to another session', async () => {
    const { container, rerender } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fileviewer')).toBeTruthy());
    rerender(
      <MainPane selection={{ pid: 77, view: 'conversation' }} sessions={sessions}
        onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />,
    );
    expect(container.querySelector('.fileviewer')).toBeNull();
  });

  it('gets out of the way of the terminal, and comes back with the conversation', async () => {
    // TerminalView builds a ResizeObserver unconditionally. Installed for
    // this test alone: leaving it defined globally would send MainPane's
    // own placement effect down its observer branch and quietly disable
    // the window-resize fallback the test below drives.
    const globals = globalThis as unknown as { ResizeObserver?: unknown };
    globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    try {
    const { container, rerender } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fileviewer')).toBeTruthy());
    const toTerminal = (
      <MainPane selection={{ pid: PID, view: 'terminal' }} sessions={sessions}
        onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />
    );
    rerender(toTerminal);
    expect(container.querySelector('.fileviewer')).toBeNull();
    rerender(
      <MainPane selection={{ pid: PID, view: 'conversation' }} sessions={sessions}
        onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />,
    );
    expect(container.querySelector('.fileviewer')).toBeTruthy();
    } finally { delete globals.ResizeObserver; }
  });
});

describe('where the viewer sits', () => {
  it('splits the pane when there is room', async () => {
    setPaneWidth(SIDE_PANEL_MIN_PX);
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fileviewer.side')).toBeTruthy());
    expect(container.querySelector('.fvscrim')).toBeNull();
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);
  });

  it('covers the conversation when the pane is too narrow to split', async () => {
    setPaneWidth(SIDE_PANEL_MIN_PX - 1);
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fileviewer.sheet')).toBeTruthy());
    expect(container.querySelector('.fvscrim')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('follows the pane, not the window: a resize past the breakpoint swaps the placement', async () => {
    setPaneWidth(SIDE_PANEL_MIN_PX);
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fileviewer.side')).toBeTruthy());
    widthSpy.mockRestore();
    setPaneWidth(400);
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(container.querySelector('.fileviewer.sheet')).toBeTruthy());
  });
});

describe('the sheet is modal, the side panel is not', () => {
  it('locks the background while it covers the conversation, and unlocks on every close path', async () => {
    setPaneWidth(SIDE_PANEL_MIN_PX - 1);
    const { container, unmount } = renderPane();
    await clickPath();
    await waitFor(() => expect(document.documentElement.classList.contains('modal-open')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);

    await clickPath();
    await waitFor(() => expect(document.documentElement.classList.contains('modal-open')).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('.fileviewer')).toBeNull());
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);

    await clickPath();
    await waitFor(() => expect(document.documentElement.classList.contains('modal-open')).toBe(true));
    // Unmounting with the sheet still open must not leave the whole app
    // unscrollable with nothing on screen to explain why.
    unmount();
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);
  });

  it('closes on a click on the scrim, but not on one that started inside it', async () => {
    setPaneWidth(SIDE_PANEL_MIN_PX - 1);
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fvscrim')).toBeTruthy());
    const scrim = container.querySelector('.fvscrim')!;
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(container.querySelector('.fileviewer')).toBeTruthy();
    fireEvent.mouseDown(scrim);
    expect(container.querySelector('.fileviewer')).toBeNull();
  });

  it('leaves Escape alone as a side panel, where the conversation still takes typing', async () => {
    setPaneWidth(SIDE_PANEL_MIN_PX);
    const { container } = renderPane();
    await clickPath();
    await waitFor(() => expect(container.querySelector('.fileviewer.side')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.fileviewer')).toBeTruthy();
  });
});
