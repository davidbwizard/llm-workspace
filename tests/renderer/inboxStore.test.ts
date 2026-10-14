import { describe, it, expect, vi } from 'vitest';
import { createActivityInboxStore, findUnreadBoundary, type InboxSession } from '../../src/renderer/state/activityInbox.ts';
const base: InboxSession = { pid: 1, sessionId: 'one', provider: 'claude', cwd: '/work', activity: 'idle', events: 10, lastProse: 'Before' };
function setup() { let saved: string | null = null; const storage = { read: () => saved, write: (s: string) => { saved = s; } }; return { storage, store: createActivityInboxStore(storage) }; }
describe('activity inbox store', () => {
  it('baselines quietly and ignores tool/user event growth', () => {
    const { store } = setup(); store.observe([base], 100); expect(store.isUnread(base)).toBe(false); expect(store.getBoundary(base)).toBeNull();
    store.observe([{ ...base, events: 20 }], 200); expect(store.isUnread(base)).toBe(false);
    const next = { ...base, events: 21, lastProse: 'After' }; store.observe([next], 300); expect(store.isUnread(next)).toBe(true);
  });
  it('detects identical repeated agent prose by event identity', () => {
    const { store } = setup(); const original = { ...base, lastProseId: 10 }; store.observe([original]);
    const next = { ...original, lastProseId: 11 }; store.observe([next]); expect(store.isUnread(next)).toBe(true);
    store.markVisible(next, { lastAgentId: 10, lastAgentText: 'Before' }); expect(store.isUnread(next)).toBe(true);
    store.markVisible(next, { lastAgentId: 11, lastAgentText: 'Before' }); expect(store.isUnread(next)).toBe(false);
  });
  it('persists unread across reload and PID replacement without transferring to a new identity', () => {
    const { store, storage } = setup(); store.observe([base]);
    const next = { ...base, lastProse: 'After' }; store.observe([next]);
    const reloaded = createActivityInboxStore(storage); const resumed = { ...next, pid: 55 }; reloaded.observe([resumed]);
    expect(reloaded.isUnread(resumed)).toBe(true);
    const replacement = { ...next, sessionId: 'different' }; reloaded.observe([replacement]); expect(reloaded.isUnread(replacement)).toBe(false);
  });
  it('requires matching visible prose to acknowledge and never clears waiting on read', () => {
    const { store } = setup(); store.observe([base], 100);
    const next = { ...base, activity: 'waiting_input', lastProse: 'After' }; store.observe([next], 200);
    store.markVisible(next, { lastAgentId: 10, lastAgentText: 'Before' }); expect(store.isUnread(next)).toBe(true);
    store.markVisible(next, { lastAgentId: 11, lastAgentText: 'After' }); expect(store.isUnread(next)).toBe(false);
    expect(store.items([next], 'needs-you')[0]?.waitingSince).toBe(200);
  });
  it('does not attribute updates without a known identity and sorts oldest observed waiting first', () => {
    const { store } = setup(); const unknown = { ...base, sessionId: null }; store.observe([unknown], 100);
    store.observe([{ ...unknown, lastProse: 'new' }], 200); expect(store.isUnread(unknown)).toBe(false);
    const a = { ...base, activity: 'waiting_permission' }; const b = { ...base, pid: 2, sessionId: 'two', activity: 'waiting_input' };
    store.observe([a], 300); store.observe([b, a], 400);
    expect(store.items([b, a], 'needs-you').map(i => i.session.pid)).toEqual([1, 2]);
  });
  it('marks only an exact known boundary and gives an honest older-page fallback', () => {
    const { store } = setup(); store.observe([base]); store.markVisible(base, { lastAgentText: 'Before', lastAgentId: 3 });
    const boundary = store.getBoundary(base);
    expect(findUnreadBoundary([{ id: 3, role: 'assistant', text: 'Before' }, { id: 4, role: 'user', text: 'go' }, { id: 5, role: 'assistant', text: 'After' }], boundary)).toEqual({ beforeTurnId: 5, unavailable: false });
    expect(findUnreadBoundary([{ id: 5, role: 'assistant', text: 'After' }], boundary)).toEqual({ beforeTurnId: null, unavailable: true });
  });
  it('bounds persisted records and rejects malformed storage', () => {
    const { store, storage } = setup(); store.observe(Array.from({ length: 1000 }, (_, i) => ({ ...base, sessionId: String(i) })), 100);
    expect(Object.keys(JSON.parse(storage.read()!).records).length).toBeLessThanOrEqual(300);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed = createActivityInboxStore({ read: () => '{broken', write: () => {} }); expect(() => malformed.observe([base])).not.toThrow(); warn.mockRestore();
  });
});

it('matches sanitized fleet prose to visible multiline transcript and still detects streaming growth', async () => {
  const { sanitizeFields } = await import('../../src/main/ipc.ts');
  const raw = 'Done.\n\t- first\r\n\u202e- second\u200b\u001b[31m!\u001b[0m';
  const payload = sanitizeFields({ lastProse: raw }, ['lastProse']);
  expect(payload.lastProse).toBe('Done.- first- second!');
  const { store } = setup(); store.observe([base]);
  const next = { ...base, lastProse: payload.lastProse, lastProseId: 12 }; store.observe([next]);
  store.markVisible(next, { lastAgentText: raw, lastAgentId: 12 }); expect(store.isUnread(next)).toBe(false);
  const grown = { ...next, lastProse: `${payload.lastProse} More` }; store.observe([grown]);
  store.markVisible(grown, { lastAgentText: raw, lastAgentId: 12 }); expect(store.isUnread(grown)).toBe(true);
  store.markVisible(grown, { lastAgentText: `${raw} More`, lastAgentId: 12 }); expect(store.isUnread(grown)).toBe(false);
});

it('waits for real enrichment before baselining pre-existing prose quietly', () => {
  const { store, storage } = setup(); const partial = { ...base, activity: null, events: null, lastProse: null, lastProseId: null };
  store.observe([partial]);
  const reloaded = createActivityInboxStore(storage); reloaded.observe([base]);
  expect(reloaded.isUnread(base)).toBe(false);
  const next = { ...base, lastProse: 'New reply' }; reloaded.observe([next]); expect(reloaded.isUnread(next)).toBe(true);
});

it('treats an enriched empty transcript as a baseline so its first reply is unread', () => {
  const { store } = setup(); store.observe([{ ...base, events: 0, lastProse: null }]);
  store.observe([base]); expect(store.isUnread(base)).toBe(true);
});
