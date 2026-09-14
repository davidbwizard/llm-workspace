import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { TerminalView } from '../../src/renderer/components/TerminalView.tsx';

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
// Every options object a `new Terminal(...)` call in the component received,
// in order. This is the only way to pin BUG 1 (huge letter-spacing/overlap/
// blank-glyph rectangles): xterm measures cell width against a real canvas
// 2D context, which this mock cannot reproduce -- but the actual defect was
// never in xterm's measurement, it was in the STRING the component handed
// it ('var(--f-mono)', which canvas text measurement never resolves). That
// is exactly the argument this array captures.
const terminalOptions: Array<{ fontFamily?: string }> = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24;
    constructor(opts: { fontFamily?: string }) { terminalOptions.push(opts); }
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
  terminalOptions.length = 0;
  resizeCb = null;
  dataCb = null;
  handler = null;
  webglShouldThrow = false;
  // The component attaches from inside an animation frame, deliberately: the
  // mount-tick fit measures the element before the rail has taken its share of
  // the row, so attaching there would tell main a width that is too wide, and
  // the pty main spawns (and tmux's own redraw inside it) would be laid out at
  // that wrong width. jsdom's rAF is a real timer, which these tests -- driven
  // by `await Promise.resolve()` -- would never reach. Run the callback
  // synchronously so the tests exercise the same path, in the same order,
  // without waiting on a frame that never comes.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  // No test relies on a --f-mono left over from a previous one -- each
  // test that cares sets (or deliberately clears) it itself.
  document.documentElement.style.removeProperty('--f-mono');
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    attach: vi.fn(async () => ({ status: 'attached' })),
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

  // BUG 1: xterm measures cell width against a real canvas 2D context,
  // which never resolves a CSS custom property -- passing the literal
  // string 'var(--f-mono)' as fontFamily measures every cell against
  // whatever fallback the canvas context substitutes, not against the real
  // font. That mismatch produced the huge letter-spacing, overlapping and
  // mis-wrapped lines, and blank-glyph rectangles from the report. Pinned
  // here on the actual string reaching the constructor, not on any visual
  // symptom (which this mocked Terminal cannot render at all).
  it('resolves the real --f-mono font stack at runtime instead of handing xterm a raw var() string', async () => {
    document.documentElement.style.setProperty('--f-mono', '"Test Mono", monospace');
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    expect(terminalOptions).toHaveLength(1);
    expect(terminalOptions[0]!.fontFamily).toBe('"Test Mono", monospace');
    expect(terminalOptions[0]!.fontFamily).not.toContain('var(');
  });

  // The fallback matters on its own: getComputedStyle can read back '' if
  // this ever mounts before the stylesheet defining the token has applied.
  // Without a fallback that would hand xterm an empty fontFamily, not
  // merely the wrong one.
  it('falls back to a real font stack when --f-mono resolves empty', async () => {
    render(<TerminalView pid={4821} />); // beforeEach never sets --f-mono
    await Promise.resolve();
    const family = terminalOptions[0]!.fontFamily;
    expect(family).toBeTruthy();
    expect(family).not.toContain('var(');
  });

  // Fix-wave item 3: webglShouldThrow was declared and reset every
  // beforeEach but never actually set true anywhere, so the WebGL-init-
  // failure -> canvas/DOM-fallback branch (TerminalView.tsx's try/catch
  // around `new WebglAddon()`) was never exercised by this suite at all.
  // No GPU context in CI/most dev machines running headless is exactly
  // when this branch is real, not hypothetical.
  it('falls back to the canvas/DOM renderer without throwing when WebGL init fails', async () => {
    webglShouldThrow = true;
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    // The rest of the component still works -- WebGL is an optimisation,
    // not a requirement (TerminalView's own doc comment on the addon).
    handler?.({ version: 1, pid: 4821, seq: 0, data: 'still works' });
    expect(writes).toContain('still works');
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

  it('does not attach until the corrected fit has run, so the pty is spawned at the real width', async () => {
    // The ordering IS the bug. The mount-tick fit measures this element before
    // the rail beside it has taken its share of the row, so it reads too wide.
    // Attaching there tells main that width; main would spawn the pty (and
    // tmux's own redraw inside it) at that wrong width, and the later
    // corrected fit resizes the pane but cannot unwrite output already
    // rendered -- which is the mid-word wrapping that appeared on every
    // switch back to this view. So: hold the frame, prove nothing attached,
    // then release it.
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });

    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    expect(window.fleet!.attach).not.toHaveBeenCalled();

    frame!(0);
    await Promise.resolve();
    expect(window.fleet!.attach).toHaveBeenCalledTimes(1);
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
});
