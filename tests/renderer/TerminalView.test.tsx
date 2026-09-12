import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { TerminalView, MAX_QUEUED_TERMINAL_PAYLOADS } from '../../src/renderer/components/TerminalView.tsx';

// Captures every xterm call the component makes, so tests can assert on
// exactly what reached the (real, un-mockable-in-jsdom) terminal without
// ever instantiating it -- the same reasoning the brief's own sample gives:
// xterm.js needs a real DOM the way jsdom doesn't provide, so the mock
// below stands in for it, and Task 14's manual pass is what verifies the
// real thing renders.
const writes: string[] = [];
let resizeCb: ((e: { cols: number; rows: number }) => void) | null = null;
let dataCb: ((text: string) => void) | null = null;
let webglShouldThrow = false;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24;
    loadAddon() {}
    open() {}
    dispose() {}
    onResize(cb: (e: { cols: number; rows: number }) => void) { resizeCb = cb; return { dispose() { resizeCb = null; } }; }
    onData(cb: (text: string) => void) { dataCb = cb; return { dispose() { dataCb = null; } }; }
    write(d: string) { writes.push(d); }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { if (webglShouldThrow) throw new Error('no webgl in this jsdom'); } dispose() {} },
}));

// jsdom has no ResizeObserver at all (not an xterm concern -- a plain
// jsdom gap), so it's stubbed the same way xterm itself is above: a
// no-op stand-in, not something under test here. The component's own
// resize-driven behaviour is exercised through term.onResize (resizeCb),
// not through this observer firing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

let handler: ((p: unknown) => void) | null = null;

beforeEach(() => {
  writes.length = 0;
  resizeCb = null;
  dataCb = null;
  handler = null;
  webglShouldThrow = false;
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    attach: vi.fn(async () => ({ status: 'attached', backlog: 'previous output\n' })),
    detach: vi.fn(async () => ({ status: 'detached' })),
    resize: vi.fn(async () => ({ status: 'resized' })),
    sendRaw: vi.fn(async () => ({ status: 'sent' })),
    onTerminalData: (cb: (p: unknown) => void) => { handler = cb; return () => { handler = null; }; },
  };
});

describe('TerminalView', () => {
  it('writes bytes imperatively, never through React state', async () => {
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    handler?.({ version: 1, pid: 4821, seq: 0, data: 'hello' });
    expect(writes).toContain('hello');
  });

  it('ignores bytes addressed to a different session', async () => {
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    handler?.({ version: 1, pid: 9999, seq: 0, data: 'not mine' });
    expect(writes).not.toContain('not mine');
  });

  it('detaches and unsubscribes on unmount so a closed view stops streaming', async () => {
    const { unmount } = render(<TerminalView pid={4821} />);
    await Promise.resolve();
    unmount();
    expect(window.fleet!.detach).toHaveBeenCalledWith(4821);
    // The mock's onTerminalData sets `handler` on subscribe and clears it
    // back to null via the returned unsubscribe function -- if the cleanup
    // forgot to call it, handler would still be the live callback here.
    expect(handler).toBeNull();
  });

  it('writes backlog before any live byte queued ahead of it, never interleaved', async () => {
    let resolveAttach!: (v: { status: string; backlog: string }) => void;
    const pending = new Promise<{ status: string; backlog: string }>(res => { resolveAttach = res; });
    window.fleet!.attach = vi.fn(() => pending) as never;

    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    // A live chunk arrives on the broadcast channel before attach's own
    // promise has resolved -- the subscription is registered before attach
    // is awaited, precisely because it must not miss data racing ahead of
    // the reply. It must still queue rather than write straight through.
    handler?.({ version: 1, pid: 4821, seq: 0, data: 'raced-ahead' });
    expect(writes).not.toContain('raced-ahead');

    resolveAttach({ status: 'attached', backlog: 'BACKLOG\n' });
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toContain('BACKLOG\n');
    expect(writes).toContain('raced-ahead');
    expect(writes.indexOf('BACKLOG\n')).toBeLessThan(writes.indexOf('raced-ahead'));
  });

  it('resizes tmux through fleet.resize on every FitAddon resize, since tmux never learns the size on its own', async () => {
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    resizeCb?.({ cols: 120, rows: 40 });
    expect(window.fleet!.resize).toHaveBeenCalledWith(4821, 120, 40);
  });

  it('sends keystrokes typed into the terminal back through sendRaw', async () => {
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    dataCb?.('');
    expect(window.fleet!.sendRaw).toHaveBeenCalledWith(4821, '');
  });

  it('renders why, not a blank terminal, when attach refuses a non-tmux session', async () => {
    window.fleet!.attach = vi.fn(async () => ({ status: 'refused', reason: 'not_tmux' })) as never;
    const { container } = render(<TerminalView pid={4821} />);
    // The refusal arrives via attach's promise, which resolves the state
    // update outside any React event handler -- act() is what flushes that
    // update synchronously so the assertions below see the settled render.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('.term')).toBeNull();
    expect(container.textContent).toMatch(/tmux/i);
  });

  it('renders why when the tmux session has already ended', async () => {
    window.fleet!.attach = vi.fn(async () => ({ status: 'refused', reason: 'session_gone' })) as never;
    const { container } = render(<TerminalView pid={4821} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toMatch(/ended/i);
  });

  it('flags a gap visibly instead of silently rendering corrupted output when seq skips', async () => {
    const { container } = render(<TerminalView pid={4821} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => {
      handler?.({ version: 1, pid: 4821, seq: 0, data: 'a' });
      handler?.({ version: 1, pid: 4821, seq: 2, data: 'b' }); // seq 1 never arrived
    });
    expect(container.textContent).toMatch(/missing|gap|dropped/i);
  });

  it('does not flag a gap when seq increments normally', async () => {
    const { container } = render(<TerminalView pid={4821} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => {
      handler?.({ version: 1, pid: 4821, seq: 0, data: 'a' });
      handler?.({ version: 1, pid: 4821, seq: 1, data: 'b' });
    });
    expect(container.textContent).not.toMatch(/missing|gap|dropped/i);
  });

  // Fix-wave item 2: the pre-backlog queue used to grow without limit while
  // attach's own promise was still pending -- against the stream's real
  // ~30 MB/s ceiling, a slow or contended attach turns that into unbounded
  // renderer memory. Held pending here the same way the ordering test above
  // does, so payloads pile up in the queue rather than being applied.
  it('caps the pre-backlog queue rather than growing it without limit, and flags the gap visibly', async () => {
    let resolveAttach!: (v: { status: string; backlog: string }) => void;
    const pending = new Promise<{ status: string; backlog: string }>(res => { resolveAttach = res; });
    window.fleet!.attach = vi.fn(() => pending) as never;

    const { container } = render(<TerminalView pid={4821} />);
    await Promise.resolve();

    // One more than the cap arrives before backlog does -- the last one
    // must be the one that gets dropped, not silently accepted and grown
    // past the limit.
    act(() => {
      for (let i = 0; i < MAX_QUEUED_TERMINAL_PAYLOADS + 1; i++) {
        handler?.({ version: 1, pid: 4821, seq: i, data: `chunk-${i}` });
      }
    });

    await act(async () => {
      resolveAttach({ status: 'attached', backlog: 'BACKLOG\n' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writes).toContain('BACKLOG\n');
    expect(writes).toContain(`chunk-${MAX_QUEUED_TERMINAL_PAYLOADS - 1}`); // last one kept
    expect(writes).not.toContain(`chunk-${MAX_QUEUED_TERMINAL_PAYLOADS}`); // the overflow one, dropped
    expect(container.textContent).toMatch(/missing|gap|dropped/i);
  });
});
