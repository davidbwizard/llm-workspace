export type NotificationPreferences = {
  enabled: boolean;
  needsYou: boolean;
  finished: boolean;
  onlyAway: boolean;
  previews: boolean;
  muted: string[];
};
export const NOTIFICATION_PREF_KEY = 'llmws:notifications';
export const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  enabled:false, needsYou:true, finished:false, onlyAway:true, previews:false, muted:[],
};
export type NotificationSession = {provider:string; sessionId:string|null; activity?:string|null; name?:string|null; lastProse?:string|null};
export type NotificationTarget = {provider:string; sessionId:string};
export function sessionNotificationKey(s: NotificationSession): string | null {
  return (s.provider === 'claude' || s.provider === 'codex') && typeof s.sessionId === 'string' && s.sessionId.length > 0 && s.sessionId.length <= 256
    ? JSON.stringify([s.provider, s.sessionId]) : null;
}
export function parseNotificationPreferences(value: unknown): NotificationPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !Object.hasOwn(DEFAULT_NOTIFICATIONS, k))) return null;
  for (const key of ['enabled','needsYou','finished','onlyAway','previews']) if (typeof v[key] !== 'boolean') return null;
  if (!Array.isArray(v.muted) || v.muted.length > 300) return null;
  for (const key of v.muted) {
    if (typeof key !== 'string' || key.length > 300) return null;
    try {
      const pair: unknown = JSON.parse(key);
      if (!Array.isArray(pair) || pair.length !== 2 || sessionNotificationKey({provider:pair[0],sessionId:pair[1]}) !== key) return null;
    } catch { return null; }
  }
  return {...v, muted:[...new Set(v.muted)]} as NotificationPreferences;
}
export type SessionNotification = NotificationTarget & {key:string; kind:'needs-you'|'finished'; title:string; body:string};
const waiting = (activity: string | null | undefined) => activity === 'waiting_permission' || activity === 'waiting_input';
function preview(value: string | null | undefined, max: number) { return (value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }

/** Observe even while disabled/focused, so turning alerts on never replays a backlog. */
export function createNotificationTracker() {
  let previous = new Map<string, string | null | undefined>();
  let sent: number[] = [];
  return {
    observe(sessions: readonly NotificationSession[], prefs: NotificationPreferences, focused: boolean, now = Date.now()): SessionNotification[] {
      const next = new Map<string, string | null | undefined>();
      const alerts: SessionNotification[] = [];
      sent = sent.filter(time => now - time < 30_000);
      for (const s of sessions) {
        const key = sessionNotificationKey(s);
        if (!key || next.has(key)) continue;
        next.set(key, s.activity);
        if (!previous.has(key) || !prefs.enabled || prefs.muted.includes(key) || (prefs.onlyAway && focused)) continue;
        const prior = previous.get(key);
        const kind = prefs.needsYou && waiting(s.activity) && !waiting(prior) ? 'needs-you'
          : prefs.finished && prior === 'working' && s.activity === 'idle' ? 'finished' : null;
        if (!kind || sent.length >= 3) continue;
        const title = kind === 'needs-you' ? 'Fleet needs you' : 'Fleet session finished';
        const generic = kind === 'needs-you' ? 'A session is waiting for your input.' : 'A session has finished its current work.';
        const label = preview(s.name, 80);
        const detail = prefs.previews ? preview(s.lastProse, 160) : '';
        alerts.push({key, provider:s.provider, sessionId:s.sessionId!, kind, title,
          body:prefs.previews ? [label, kind === 'needs-you' ? 'Waiting for your input.' : detail || 'Finished its current work.'].filter(Boolean).join(' — ') : generic});
        sent.push(now);
      }
      previous = next;
      return alerts;
    },
  };
}
export type NotificationStatus = {preferences:NotificationPreferences; supported:boolean; error:string|null};
