import { describe, it, expect, beforeEach } from 'vitest';
import { addPending, pendingFor, matchPending, normalise, clearPending, tickIdle, markQueued, NOT_SEEN_AFTER_MS } from '../../src/renderer/state/pending.ts';

const turn = (id: number, ts: string, text: string, role: 'user' | 'assistant' = 'user') => ({ id, ts, role, text });

beforeEach(() => clearPending());

describe('matchPending', () => {
  it('matches a plain message', () => {
    const list = [{ key: 'k1', text: 'run the farm tests', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'run the farm tests')])).toEqual(['k1']);
  });

  it('matches when the log added an image marker', () => {
    const list = [{ key: 'k1', text: 'look at this', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', '[Image #1] look at this')])).toEqual(['k1']);
  });

  it('matches when codex prefixed an attached file path', () => {
    const list = [{ key: 'k1', text: 'check the log', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' }];
    const text = "Attached file: '/tmp/llm-workspace-files/a.log'\ncheck the log";
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', text)])).toEqual(['k1']);
  });

  it('ignores line-break differences', () => {
    const list = [{ key: 'k1', text: 'one\ntwo', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'one two')])).toEqual(['k1']);
  });

  it('matches an attachment-only message on time alone', () => {
    const list = [{ key: 'k1', text: '', attachments: [{ id: 'a', name: 'a.png', kind: 'image' as const, thumb: null }], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', "'/tmp/a.png'")])).toEqual(['k1']);
  });

  it('never matches a turn recorded before the send', () => {
    const list = [{ key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(list, [turn(1, '2026-09-17T09:59:00Z', 'hello')])).toEqual([]);
  });

  it('matches two quick sends in order, one turn each', () => {
    const base = Date.parse('2026-09-17T10:00:00Z');
    const list = [
      { key: 'k1', text: 'first', attachments: [], sentAt: base, queued: false, idleMs: 0, sessionId: 's1' },
      { key: 'k2', text: 'second', attachments: [], sentAt: base + 100, queued: false, idleMs: 0, sessionId: 's1' },
    ];
    const turns = [turn(1, '2026-09-17T10:00:01Z', 'first'), turn(2, '2026-09-17T10:00:02Z', 'second')];
    expect(matchPending(list, turns)).toEqual(['k1', 'k2']);
  });

  it('ignores turns the agent wrote', () => {
    const list = [{ key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'hello', 'assistant')])).toEqual([]);
  });

  it('leaves every entry alone when a turn matches nothing', () => {
    const list = [
      { key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0, sessionId: 's1' },
      { key: 'k2', text: 'world', attachments: [], sentAt: Date.parse('2026-09-17T10:00:01Z'), queued: false, idleMs: 0, sessionId: 's1' },
    ];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:02Z', 'no match')])).toEqual([]);
  });

  it('enforces exclusivity when two entries have identical text', () => {
    const base = Date.parse('2026-09-17T10:00:00Z');
    const list = [
      { key: 'k1', text: 'deploy', attachments: [], sentAt: base, queued: false, idleMs: 0, sessionId: 's1' },
      { key: 'k2', text: 'deploy', attachments: [], sentAt: base + 100, queued: false, idleMs: 0, sessionId: 's1' },
    ];
    const turns = [
      turn(1, '2026-09-17T10:00:01Z', 'deploy'),
      turn(2, '2026-09-17T10:00:03Z', 'deploy'),
    ];
    expect(matchPending(list, turns)).toEqual(['k1', 'k2']);
  });

  // Finding 1 (final review, 2026-09-17): "each turn matches at most one
  // entry" only held within a single call -- the `taken` set above is local.
  // ConversationView re-runs matchPending from scratch, against the full
  // turn list, on every page change, so without a set that survives across
  // calls a turn that already matched one entry is free to match a
  // DIFFERENT entry the next time the same turn is walked again. `used`
  // (threaded in by the caller as a ref) is what closes that gap.
  it('does not let a turn matched on an earlier call match a different entry on a later one', () => {
    const base = Date.parse('2026-09-17T10:00:00Z');
    const turns = [turn(1, '2026-09-17T10:00:01Z', 'continue')];
    const used = new Set<number>();

    const first = [{ key: 'k1', text: 'continue', attachments: [], sentAt: base, queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(first, turns, used)).toEqual(['k1']);

    // k1 is gone from the caller's list now (ConversationView drops a
    // matched entry immediately), but the same turn is still in the full
    // turn list on the next call -- exactly what an unrelated turn landing
    // (an agent reply, nothing new from the person) triggers.
    const second = [{ key: 'k2', text: 'continue', attachments: [], sentAt: base + 100, queued: false, idleMs: 0, sessionId: 's1' }];
    expect(matchPending(second, turns, used)).toEqual([]);
  });
});

// Finding 4 (final review, 2026-09-17) -- spec 4.4: "Dropped when the pid
// leaves the fleet." clearPending had no production caller, so an entry
// sent into one session stayed visible forever, and a pid the OS later
// reused for an entirely different session would show the OLD session's
// pending text in the NEW session's conversation. Stamping every entry with
// the sessionId it was sent into, and filtering on it here, mirrors the
// `drafts` store in ConversationView.tsx -- see its own doc comment for why
// the pid alone is not a safe identity.
describe('pendingFor', () => {
  it('only returns entries stamped with the session on screen', () => {
    addPending(1, { text: 'for s1', attachments: [], sentAt: 100, queued: false, sessionId: 's1' });
    addPending(1, { text: 'for s2', attachments: [], sentAt: 200, queued: false, sessionId: 's2' });

    expect(pendingFor(1, 's1').map(p => p.text)).toEqual(['for s1']);
    expect(pendingFor(1, 's2').map(p => p.text)).toEqual(['for s2']);
  });

  // The pid-reuse hazard itself: the OS hands pid 1 to a brand-new process,
  // the app resolves it to a different session, and the OLD session's
  // never-matched entry must not bleed into the new session's pane.
  it('drops a pending entry once its pid resolves to a different session', () => {
    addPending(1, { text: 'stale', attachments: [], sentAt: 100, queued: false, sessionId: 's1' });
    expect(pendingFor(1, 's2')).toEqual([]);
  });

  it('never matches when the session on screen is unidentified, even against an unidentified entry', () => {
    addPending(1, { text: 'ambiguous', attachments: [], sentAt: 100, queued: false, sessionId: null });
    expect(pendingFor(1, null)).toEqual([]);
  });
});

describe('tickIdle', () => {
  it('advances all entries by the same amount', () => {
    addPending(1, { text: 'a', attachments: [], sentAt: 100, queued: false, sessionId: 's1' });
    addPending(1, { text: 'b', attachments: [], sentAt: 200, queued: false, sessionId: 's1' });
    const before = pendingFor(1, 's1');
    expect(before.length).toBe(2);
    expect(before[0]?.idleMs).toBe(0);
    expect(before[1]?.idleMs).toBe(0);

    tickIdle(1, 50);

    const after = pendingFor(1, 's1');
    expect(after.length).toBe(2);
    expect(after[0]?.idleMs).toBe(50);
    expect(after[1]?.idleMs).toBe(50);
  });
});

describe('markQueued', () => {
  it('sets queued flag for an existing entry', () => {
    const key = addPending(1, { text: 'hello', attachments: [], sentAt: 100, queued: false, sessionId: 's1' });
    const before = pendingFor(1, 's1');
    expect(before[0]?.queued).toBe(false);

    markQueued(1, key, true);

    const after = pendingFor(1, 's1');
    expect(after[0]?.queued).toBe(true);
  });

  it('does not throw when key does not exist', () => {
    addPending(1, { text: 'hello', attachments: [], sentAt: 100, queued: false, sessionId: 's1' });
    expect(() => markQueued(1, 'nonexistent', true)).not.toThrow();
  });
});
