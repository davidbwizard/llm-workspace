import { ipcMain, type BrowserWindow } from 'electron';
import type { MailBadge } from '../mail/badges.ts';

// Fleet Mail's own channel to the window, kept out of ipc.ts. The window asks
// once on load ('mail:badges') and then receives every change ('mail:update').

export type BadgeMap = Record<number, MailBadge[]>;

export function registerMailIpc(read: () => BadgeMap): void {
  ipcMain.handle('mail:badges', () => read());
}

export function pushMail(win: BrowserWindow | null, badges: BadgeMap): void {
  if (win && !win.isDestroyed()) win.webContents.send('mail:update', badges);
}
