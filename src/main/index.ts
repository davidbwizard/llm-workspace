import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { openDb, type Db } from '../store/db.ts';
import { ingestAll, startWatcher, type Watcher, type WatchRoot } from '../watch/watcher.ts';
import { ingestSpool, rotateSpool } from '../hooks/spool.ts';
import { resolvePaths } from '../config.ts';
import { registerIpc, pushFleet } from './ipc.ts';

let db: Db | null = null;
let watcher: Watcher | null = null;
let spoolTimer: NodeJS.Timeout | null = null;
let mainWindow: BrowserWindow | null = null;

const paths = resolvePaths(homedir());

function roots(): WatchRoot[] {
  return [
    { dir: paths.claudeProjects, provider: 'claude' as const, glob: /\.jsonl$/ },
    { dir: paths.codexSessions, provider: 'codex' as const, glob: /rollout-.*\.jsonl$/ },
  ].filter(r => existsSync(r.dir));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 720, minHeight: 480,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1918',   // --ground, so the first paint is not white
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // Non-negotiable (spec §11.1). This app renders untrusted transcript
      // text; a renderer with Node reach turns that into code execution.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });

  win.once('ready-to-show', () => win.show());

  // Nothing in this app should ever open a window or navigate. will-navigate
  // alone only covers main-frame, user-initiated navigation; will-frame-navigate
  // and will-redirect close the subframe and redirect gaps (spec §11.1).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-frame-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  mkdirSync(join(homedir(), '.llm-workspace'), { recursive: true });
  db = openDb(paths.db);

  registerIpc(db);
  createWindow();

  // Catch up on anything written while the app was closed, then watch.
  ingestAll(db, roots());

  // Watcher events arrive per file and can burst; coalesce so a busy session
  // does not push a payload per line written.
  let pending: NodeJS.Timeout | null = null;
  watcher = startWatcher(db, roots(), () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; if (db) pushFleet(db, mainWindow); }, 250);
  });

  spoolTimer = setInterval(() => {
    if (!db) return;
    if (ingestSpool(db, paths.spool) > 0) pushFleet(db, mainWindow);
  }, 1000);
  rotateSpool(paths.spool, { maxAgeDays: 30, maxFiles: 20000 });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  if (spoolTimer) clearInterval(spoolTimer);
  void watcher?.close();
  db?.close();
});
