import { describe, it, expect } from 'vitest';
import { makeCoalescer, MAX_FLUSH_CHARS } from '../../src/main/stream.ts';

function harness() {
  const sent: Array<{ seq: number; data: string }> = [];
  let pending: (() => void) | null = null;
  const c = makeCoalescer(4821, p => sent.push({ seq: p.seq, data: p.data }), fn => { pending = fn; });
  return { sent, c, tick: () => { const f = pending; pending = null; f?.(); } };
}

describe('terminal stream coalescing', () => {
  it('batches many small writes into one message', () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.c.push('x');
    expect(h.sent).toHaveLength(0);
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.data).toHaveLength(1000);
  });

  it('numbers messages so the renderer can detect a gap', () => {
    const h = harness();
    h.c.push('a'); h.tick();
    h.c.push('b'); h.tick();
    expect(h.sent.map(s => s.seq)).toEqual([0, 1]);
  });

  it('caps a single flush and keeps the remainder for the next one', () => {
    const h = harness();
    h.c.push('y'.repeat(MAX_FLUSH_CHARS + 500));
    h.tick();
    expect(h.sent[0]!.data).toHaveLength(MAX_FLUSH_CHARS);
    h.tick();
    expect(h.sent[1]!.data).toHaveLength(500);
  });

  it('emits nothing when there is nothing buffered', () => {
    const h = harness();
    h.tick();
    expect(h.sent).toHaveLength(0);
  });

  // The test above never actually exercises flushNow's empty-buffer guard:
  // since push() was never called, nothing was scheduled, so h.tick() is a
  // no-op regardless of what flushNow does. flushNow is only ever reachable
  // with an empty buffer via a direct call (the public flushNow() below), so
  // that is what must be tested to catch a dropped guard.
  it('flushNow on an untouched coalescer emits nothing', () => {
    const h = harness();
    h.c.flushNow();
    expect(h.sent).toHaveLength(0);
  });

  it('schedules once per burst, not once per chunk', () => {
    let scheduled = 0;
    const c = makeCoalescer(1, () => {}, () => { scheduled++; });
    c.push('a'); c.push('b'); c.push('c');
    expect(scheduled).toBe(1);
  });
});
