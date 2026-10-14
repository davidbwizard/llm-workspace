import { describe, expect, it } from 'vitest';
import { createNotificationTracker, DEFAULT_NOTIFICATIONS, parseNotificationPreferences, sessionNotificationKey, type NotificationSession } from '../src/core/notifications.ts';

const session = (activity: string, extra: Partial<NotificationSession> = {}): NotificationSession => ({provider:'claude',sessionId:'one',activity,name:'Private project',lastProse:'Private reply', ...extra});
const prefs = {...DEFAULT_NOTIFICATIONS, enabled:true, finished:true};
describe('session notifications', () => {
  it('quietly baselines existing sessions, deduplicates waiting and follows identity across PIDs', () => {
    const tracker = createNotificationTracker();
    expect(tracker.observe([session('waiting_input')], prefs, false, 0)).toEqual([]);
    expect(tracker.observe([session('working')], prefs, false, 1)).toEqual([]);
    expect(tracker.observe([session('waiting_permission')], prefs, false, 2)).toEqual([
      expect.objectContaining({kind:'needs-you', title:'Fleet needs you', body:'A session is waiting for your input.'}),
    ]);
    expect(tracker.observe([session('waiting_input')], prefs, false, 3)).toEqual([]);
    expect(tracker.observe([session('waiting_input')], prefs, false, 4)).toEqual([]);
  });
  it('only reports completion after observed work; idle prose alone is not a request', () => {
    const tracker = createNotificationTracker();
    tracker.observe([session('idle')], prefs, false, 0);
    expect(tracker.observe([session('idle', {lastProse:'Any questions?'})], prefs, false, 1)).toEqual([]);
    tracker.observe([session('working')], prefs, false, 2);
    expect(tracker.observe([session('idle')], prefs, false, 3)).toEqual([expect.objectContaining({kind:'finished'})]);
  });
  it('suppresses while focused, muted or disabled and never replays suppressed alerts', () => {
    for (const change of [{enabled:false}, {muted:[sessionNotificationKey(session('idle'))!]}, {}]) {
      const tracker = createNotificationTracker(); const config = {...prefs,...change};
      tracker.observe([session('working')], config, false, 0);
      expect(tracker.observe([session('waiting_input')], config, true, 1)).toEqual([]);
      expect(tracker.observe([session('waiting_input')], prefs, false, 2)).toEqual([]);
    }
  });
  it('bounds bursts and keeps previews opt-in', () => {
    const tracker = createNotificationTracker();
    const rows = Array.from({length:12}, (_,i) => session('working',{sessionId:String(i)}));
    tracker.observe(rows, prefs, false, 0);
    const alerts = tracker.observe(rows.map(s=>({...s,activity:'idle'})), prefs, false, 1);
    expect(alerts).toHaveLength(3);
    expect(JSON.stringify(alerts.map(a=>[a.title,a.body]))).not.toContain('Private');
    tracker.observe([session('working')], prefs, false, 60_000);
    expect(tracker.observe([session('idle')], {...prefs,previews:true}, false, 60_001)[0]?.body).toContain('Private project');
  });
  it('validates preferences and bounded mute identities at the boundary', () => {
    expect(parseNotificationPreferences(DEFAULT_NOTIFICATIONS)).toEqual(DEFAULT_NOTIFICATIONS);
    expect(parseNotificationPreferences({...prefs,enabled:'yes'})).toBeNull();
    expect(parseNotificationPreferences({...prefs,muted:['not a session']})).toBeNull();
    expect(parseNotificationPreferences({...prefs,muted:Array(301).fill('["claude","one"]')})).toBeNull();
    expect(parseNotificationPreferences({...prefs,extra:true})).toBeNull();
  });
});
