import { ipcMain, Notification, type BrowserWindow } from 'electron';
import { createNotificationTracker, DEFAULT_NOTIFICATIONS, NOTIFICATION_PREF_KEY, parseNotificationPreferences,
  type NotificationSession, type NotificationStatus, type NotificationTarget } from '../core/notifications.ts';
import { readAllPrefs, writePref, type PrefsDb } from './prefs.ts';

export function registerNotifications(deps: {db:PrefsDb; window:()=>BrowserWindow|null; open:()=>void; sessions:()=>readonly NotificationSession[]}) {
  let preferences = {...DEFAULT_NOTIFICATIONS};
  let error: string | null = null;
  let pending: NotificationTarget | null = null;
  const tracker = createNotificationTracker();
  const active = new Set<Notification>();
  const raw = readAllPrefs(deps.db)[NOTIFICATION_PREF_KEY];
  if (raw) {
    try { const parsed = parseNotificationPreferences(JSON.parse(raw)); if (!parsed) throw new Error('Invalid preferences'); preferences = parsed; }
    catch (e) { error = 'Could not restore notification settings. Notifications are off.'; console.error(error, e); }
  }
  const status = (): NotificationStatus => ({preferences, supported:Notification.isSupported(), error});
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    const win = deps.window();
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  };
  function show(title:string, body:string, target?:NotificationTarget) {
    if (!Notification.isSupported()) { error = 'Notifications are not supported on this computer.'; return; }
    try {
      const notification = new Notification({title, body});
      active.add(notification);
      const cleanup = () => active.delete(notification);
      notification.once('close', cleanup);
      notification.once('failed', (_event, message) => { cleanup(); error = 'Notification delivery failed. Check macOS notification settings for Fleet.'; console.error('Fleet notification failed:', message); });
      notification.once('click', () => {
        cleanup();
        // Revalidate identity at click time. Never operate on a reused PID.
        pending = target && deps.sessions().some(s => s.provider === target.provider && s.sessionId === target.sessionId)
          ? {provider:target.provider, sessionId:target.sessionId} : null;
        deps.open();
        const win = deps.window();
        if (pending && win && !win.isDestroyed()) win.webContents.send('notifications:open', pending);
      });
      notification.show();
      // Keep the native handles bounded even when the OS retains notification history.
      if (active.size > 20) { const oldest = active.values().next().value; oldest?.close(); if (oldest) active.delete(oldest); }
    } catch (e) { error = 'Could not show the notification.'; console.error(error, e); }
  }
  ipcMain.handle('notifications:get', event => trusted(event) ? status() : null);
  ipcMain.handle('notifications:set', (event, value:unknown) => {
    if (!trusted(event)) throw new Error('Notification settings are unavailable here.');
    const parsed = parseNotificationPreferences(value);
    if (!parsed) throw new Error('Invalid notification settings.');
    if (!writePref(deps.db, NOTIFICATION_PREF_KEY, JSON.stringify(parsed)).ok) throw new Error('Could not save notification settings.');
    preferences = parsed; error = null;
    return status();
  });
  let lastTest = -Infinity;
  ipcMain.handle('notifications:test', event => {
    if (!trusted(event)) throw new Error('Notifications are unavailable here.');
    if (!preferences.enabled) throw new Error('Enable notifications first.');
    if (Date.now() - lastTest < 5000) throw new Error('Wait a moment before testing again.');
    lastTest = Date.now(); error = null;
    show('Fleet notifications', 'You will be notified when a session needs you.');
    return status();
  });
  ipcMain.handle('notifications:take-open', event => {
    if (!trusted(event)) return null;
    const target = pending; pending = null;
    return target;
  });
  return {
    observe(sessions:readonly NotificationSession[]) {
      const win = deps.window();
      for (const alert of tracker.observe(sessions, preferences, !!win && !win.isDestroyed() && win.isFocused())) show(alert.title, alert.body, alert);
    },
    dispose() { for (const n of active) n.close(); active.clear(); },
  };
}
