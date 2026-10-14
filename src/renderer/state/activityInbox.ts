import { useEffect, useSyncExternalStore } from 'react';
import { readPref, writePref } from './prefsStorage.ts';
import { sanitizeForDisplay } from '../../core/displayText.ts';

export type InboxSession = { pid: number; sessionId: string | null; provider: string; name?: string | null; cwd: string | null; project?: string; activity?: string | null; events?: number | null; lastProse?: string | null; lastProseId?: number | null };
export type InboxKind = 'needs-you' | 'updates';
export type ReadBoundary = { lastAgentId?: number; lastAgentFingerprint: string };
export type InboxItem = { session: InboxSession; key: string; waitingSince: number | null; snippet: string | null };
type RecordEntry = { baselined: boolean; observed: string; observedId?: number; read: ReadBoundary; touched: number; waitingSince: number | null; visited?: boolean };
export const INBOX_PREF_KEY = 'llmws:activity-inbox';
const MAX_RECORDS = 300;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export function inboxSessionKey(session: InboxSession): string | null {
  return session.sessionId?.trim() && (session.provider === 'claude' || session.provider === 'codex')
    ? JSON.stringify([session.provider, session.sessionId]) : null;
}
// Persist a fingerprint, not private transcript text. Two independent hashes
// and length avoid storing arbitrarily large replies in preferences.
export function proseFingerprint(text: string | null | undefined): string {
  if (!text) return '';
  text = sanitizeForDisplay(text);
  if (!text) return '';
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
const waiting = (s: InboxSession) => s.activity === 'waiting_permission' || s.activity === 'waiting_input';
export function createActivityInboxStore(storage: { read: () => string | null; write: (raw: string) => void }) {
  let records = new Map<string, RecordEntry>();
  let loaded = false;
  let revision = 0;
  const listeners = new Set<() => void>();
  const unknownWaiting = new Map<string, number>();
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed: unknown = JSON.parse(storage.read() ?? 'null');
      if (!parsed || typeof parsed !== 'object' || !('records' in parsed) || !parsed.records || typeof parsed.records !== 'object') return;
      for (const [key, raw] of Object.entries(parsed.records).slice(0, MAX_RECORDS)) {
        if (!raw || typeof raw !== 'object') continue;
        const v = raw as Partial<RecordEntry>;
        if (typeof v.observed !== 'string' || v.observed.length > 100 || !v.read || typeof v.read.lastAgentFingerprint !== 'string' || v.read.lastAgentFingerprint.length > 100 || typeof v.touched !== 'number' || !Number.isFinite(v.touched) || (v.waitingSince !== null && (typeof v.waitingSince !== 'number' || !Number.isFinite(v.waitingSince)))) continue;
        if (v.read.lastAgentId !== undefined && (!Number.isSafeInteger(v.read.lastAgentId) || v.read.lastAgentId < 0)) continue;
        records.set(key, { ...v, baselined: v.baselined !== false } as RecordEntry);
      }
    } catch (error) { console.warn('Could not restore activity inbox:', error); }
  }
  function publish(now: number) {
    records = new Map([...records].filter(([, r]) => now - r.touched <= RETENTION_MS).sort((a, b) => b[1].touched - a[1].touched).slice(0, MAX_RECORDS));
    try { storage.write(JSON.stringify({ version: 1, records: Object.fromEntries(records) })); }
    catch (error) { console.error('Could not save activity inbox:', error); }
    revision++; listeners.forEach(fn => fn());
  }
  function observe(sessions: readonly InboxSession[], now = Date.now()) {
    load(); let changed = false;
    const unknownKeys = new Set<string>();
    for (const s of sessions) {
      const key = inboxSessionKey(s);
      if (!key) {
        const fallback = `${s.provider}:${s.pid}`;
        if (waiting(s)) { unknownKeys.add(fallback); if (!unknownWaiting.has(fallback)) { unknownWaiting.set(fallback, now); changed = true; } }
        continue;
      }
      const old = records.get(key);
      const enriched = s.events != null || s.lastProse != null || s.lastProseId != null;
      const observed = enriched ? proseFingerprint(s.lastProse) : old?.observed ?? '';
      const observedId = enriched ? s.lastProseId ?? undefined : old?.observedId;
      const baselined = old?.baselined || enriched;
      const waitingSince = waiting(s) ? old?.waitingSince ?? now : null;
      if (!old || old.observed !== observed || old.observedId !== observedId || old.baselined !== baselined || old.waitingSince !== waitingSince) {
        records.set(key, { baselined, observed, observedId, read: old?.baselined ? old.read : { lastAgentFingerprint: observed, lastAgentId: observedId }, visited: old?.visited ?? false, touched: now, waitingSince }); changed = true;
      }
    }
    for (const key of unknownWaiting.keys()) if (!unknownKeys.has(key)) { unknownWaiting.delete(key); changed = true; }
    if (changed) publish(now);
  }
  function isUnread(s: InboxSession) { load(); const key = inboxSessionKey(s); const r = key ? records.get(key) : undefined; return !!r?.observed && (r.observed !== r.read.lastAgentFingerprint || (r.observedId !== undefined && r.observedId !== r.read.lastAgentId)); }
  function getBoundary(s: InboxSession): ReadBoundary | null { load(); const key = inboxSessionKey(s); return key && records.get(key)?.visited ? records.get(key)?.read ?? null : null; }
  function markVisible(s: InboxSession, content: { lastAgentText: string; lastAgentId?: number }) {
    load(); const key = inboxSessionKey(s); if (!key) return;
    const old = records.get(key); const fingerprint = proseFingerprint(content.lastAgentText);
    // A newer fleet push must not be acknowledged by an older rendered page.
    if (!old || !fingerprint || fingerprint !== old.observed || (old.observedId !== undefined && content.lastAgentId !== old.observedId)) return;
    if (old.visited && old.read.lastAgentFingerprint === fingerprint && old.read.lastAgentId === content.lastAgentId) return;
    records.set(key, { ...old, visited: true, read: { lastAgentFingerprint: fingerprint, ...(content.lastAgentId === undefined ? {} : { lastAgentId: content.lastAgentId }) }, touched: Date.now() });
    publish(Date.now());
  }
  function items(sessions: readonly InboxSession[], kind: InboxKind): InboxItem[] {
    load(); const dedup = new Set<string>();
    return sessions.filter(s => kind === 'needs-you' ? waiting(s) : isUnread(s)).flatMap(s => {
      const key = inboxSessionKey(s) ?? `${s.provider}:${s.pid}`;
      if (dedup.has(key)) return []; dedup.add(key);
      return [{ session: s, key, waitingSince: records.get(key)?.waitingSince ?? unknownWaiting.get(key) ?? null, snippet: s.lastProse ?? null }];
    }).sort((a, b) => kind === 'needs-you' ? (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity) : 0);
  }
  return { observe, isUnread, markVisible, getBoundary, items, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => revision };
}
export const desktopInboxStore = createActivityInboxStore({ read: () => readPref(INBOX_PREF_KEY), write: raw => writePref(INBOX_PREF_KEY, raw) });
export function useActivityInbox(sessions: readonly InboxSession[], store = desktopInboxStore) {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { store.observe(sessions); }, [sessions, store]);
  return { needsYou: store.items(sessions, 'needs-you'), updates: store.items(sessions, 'updates'), isUnread: store.isUnread, markVisible: store.markVisible, getBoundary: store.getBoundary };
}
export function findUnreadBoundary(turns: readonly { id: number; role: string; text: string }[], boundary: ReadBoundary | null): { beforeTurnId: number | null; unavailable: boolean } {
  if (!boundary) return { beforeTurnId: null, unavailable: true };
  const matches = turns.filter(t => t.role === 'assistant' && (boundary.lastAgentId === undefined ? proseFingerprint(t.text) === boundary.lastAgentFingerprint : t.id === boundary.lastAgentId));
  if (matches.length !== 1) return { beforeTurnId: null, unavailable: true };
  const seen = matches[0]!;
  if (proseFingerprint(seen.text) !== boundary.lastAgentFingerprint) return { beforeTurnId: seen.id, unavailable: false };
  const index = turns.findIndex(t => t.id === seen.id);
  return { beforeTurnId: turns.slice(index + 1).find(t => t.role === 'assistant')?.id ?? null, unavailable: false };
}
