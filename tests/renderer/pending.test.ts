import { describe, it, expect, beforeEach } from 'vitest';
import { addPending, pendingFor, matchPending, normalise, clearPending, tickIdle, NOT_SEEN_AFTER_MS } from '../../src/renderer/state/pending.ts';

const turn = (id: number, ts: string, text: string, role: 'user' | 'assistant' = 'user') => ({ id, ts, role, text });

beforeEach(() => clearPending());

describe('matchPending', () => {
  it('matches a plain message', () => {
    const list = [{ key: 'k1', text: 'run the farm tests', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'run the farm tests')])).toEqual(['k1']);
  });

  it('matches when the log added an image marker', () => {
    const list = [{ key: 'k1', text: 'look at this', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', '[Image #1] look at this')])).toEqual(['k1']);
  });

  it('matches when codex prefixed an attached file path', () => {
    const list = [{ key: 'k1', text: 'check the log', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    const text = "Attached file: '/tmp/llm-workspace-files/a.log'\ncheck the log";
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', text)])).toEqual(['k1']);
  });

  it('ignores line-break differences', () => {
    const list = [{ key: 'k1', text: 'one\ntwo', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'one two')])).toEqual(['k1']);
  });

  it('matches an attachment-only message on time alone', () => {
    const list = [{ key: 'k1', text: '', attachments: [{ id: 'a', name: 'a.png', kind: 'image' as const, thumb: null }], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', "'/tmp/a.png'")])).toEqual(['k1']);
  });

  it('never matches a turn recorded before the send', () => {
    const list = [{ key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T09:59:00Z', 'hello')])).toEqual([]);
  });

  it('matches two quick sends in order, one turn each', () => {
    const base = Date.parse('2026-09-17T10:00:00Z');
    const list = [
      { key: 'k1', text: 'first', attachments: [], sentAt: base, queued: false, idleMs: 0 },
      { key: 'k2', text: 'second', attachments: [], sentAt: base + 100, queued: false, idleMs: 0 },
    ];
    const turns = [turn(1, '2026-09-17T10:00:01Z', 'first'), turn(2, '2026-09-17T10:00:02Z', 'second')];
    expect(matchPending(list, turns)).toEqual(['k1', 'k2']);
  });

  it('ignores turns the agent wrote', () => {
    const list = [{ key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'hello', 'assistant')])).toEqual([]);
  });

  it('leaves every entry alone when a turn matches nothing', () => {
    const list = [
      { key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 },
      { key: 'k2', text: 'world', attachments: [], sentAt: Date.parse('2026-09-17T10:00:01Z'), queued: false, idleMs: 0 },
    ];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:02Z', 'no match')])).toEqual([]);
  });
});

describe('tickIdle', () => {
  it('only advances the entry it names', () => {
    addPending(1, { text: 'a', attachments: [], sentAt: 100, queued: false });
    addPending(1, { text: 'b', attachments: [], sentAt: 200, queued: false });
    const before = pendingFor(1);
    expect(before.length).toBe(2);
    expect(before[0]?.idleMs).toBe(0);
    expect(before[1]?.idleMs).toBe(0);

    tickIdle(1, 50);

    const after = pendingFor(1);
    expect(after.length).toBe(2);
    expect(after[0]?.idleMs).toBe(50);
    expect(after[1]?.idleMs).toBe(0);
  });
});
