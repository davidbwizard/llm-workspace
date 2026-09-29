import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { SessionRail } from '../../src/renderer/components/SessionRail.tsx';

// The off-screen effect in SessionRail has no dependency list, so it runs
// after every render. It must still SETTLE: if it stores a fresh object each
// time, every run causes another render, and a waiting card scrolled out of
// view spins the renderer forever (measured 2026-09-29: 5,876 effect runs in
// one second, "Maximum update depth exceeded").
//
// Its own file, and no @testing-library/react: that library runs everything
// inside act(), which would flush a runaway effect loop synchronously and
// hang the test instead of failing it. Here React runs on its real scheduler,
// so a loop just burns the wait below and the count shows it.
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; IntersectionObserver?: unknown };
g.IS_REACT_ACT_ENVIRONMENT = false;

// pid 2 is waiting, so its card carries data-attn and the effect watches it.
const sessions = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', junk: false, host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];

// jsdom has no IntersectionObserver. The effect builds exactly one per run,
// so counting constructions counts effect runs.
let effectRuns = 0;
class FakeIO {
  constructor() { effectRuns++; }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {} } as DOMRect;
}

/** Mounts the rail with the attention card either inside the 0-300 scroll
 *  viewport or below it, waits, and returns how often the effect ran. */
async function effectRunsWith(attnOffscreen: boolean): Promise<{ runs: number; errors: string[]; bar: string | null }> {
  effectRuns = 0;
  g.IntersectionObserver = FakeIO;
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if ((this as HTMLElement).dataset?.attn) return attnOffscreen ? rect(500, 560) : rect(10, 60);
    return rect(0, 300);
  };
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(String(a[0])); };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    root.render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} onKill={async () => ({ status: 'already_gone' })} onReattach={async () => ({ status: 'failed' as const, reason: 'not exercised' })} onResume={async () => ({ status: 'failed' as const, reason: 'not exercised' })} side="left" />);
    await new Promise(r => setTimeout(r, 500));
    const bar = host.querySelector('.railattn')?.className ?? null;
    return { runs: effectRuns, errors, bar };
  } finally {
    root.unmount();
    host.remove();
    Element.prototype.getBoundingClientRect = realRect;
    console.error = realError;
    delete g.IntersectionObserver;
  }
}

describe('SessionRail -- the off-screen attention effect', () => {
  it('settles when the attention card is in view', async () => {
    const { runs, errors, bar } = await effectRunsWith(false);
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThan(5);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toEqual([]);
    expect(bar).toBeNull();
  });

  it('settles when the attention card is scrolled out of view', async () => {
    const { runs, errors, bar } = await effectRunsWith(true);
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThan(5);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toEqual([]);
    // Settling must not come from never storing anything: the bar still shows.
    expect(bar).toBe('railattn waiting down');
  });
});
