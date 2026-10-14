import { ipcMain, type BrowserWindow } from 'electron';
import { parseLocalPreviewUrl, type PreviewOpenResult } from '../../core/preview.ts';
import type { SessionOperations } from '../sessionOperations.ts';
import { Budget } from './auth.ts';

type OpenPreview = (project: string, url: unknown, current: () => boolean) => Promise<PreviewOpenResult>;
export async function openSessionPreview(operations: SessionOperations, open: OpenPreview, handle: string, url: unknown): Promise<PreviewOpenResult> {
  if (!parseLocalPreviewUrl(url)) return { ok: false, message: 'Use an HTTP localhost address with an explicit development server port.' };
  const target = operations.resolve(handle);
  const row = target && operations.dependencies.list().find(s => s.pid === target.pid && s.sessionId === target.sessionId && s.provider === target.provider);
  if (!row?.cwd) return { ok: false, message: 'This session changed or its project is unavailable. Reopen the session and try again.' };
  return open(row.cwd, url, () => !!operations.resolve(handle));
}

export function registerPreviewIpc(deps: { window: () => BrowserWindow | null; operations: () => SessionOperations | null; open: OpenPreview }): void {
  const requests = new Budget(12, 60_000);
  ipcMain.handle('remote:preview:open', async (event, pid: unknown, sessionId: unknown, url: unknown): Promise<PreviewOpenResult> => {
    const win = deps.window();
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      return { ok: false, message: 'Website previews are only available in Fleet’s main window.' };
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || !parseLocalPreviewUrl(url))
      return { ok: false, message: 'Select a live session and use an HTTP localhost address with a development server port.' };
    if (!requests.take()) return { ok: false, message: 'Too many preview requests. Wait a minute and try again.' };
    const operations = deps.operations();
    const session = operations?.list().find(s => s.pid === pid && s.sessionId === sessionId);
    if (!operations || !session?.handle) return { ok: false, message: 'This session changed. Reopen it and try again.' };
    return openSessionPreview(operations, deps.open, session.handle, url);
  });
}
