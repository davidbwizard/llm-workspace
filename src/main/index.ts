import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { openDb, type Db } from '../store/db.ts';
import { ingestAll, startWatcher, type Watcher, type WatchRoot } from '../watch/watcher.ts';
import { ingestSpool, rotateSpool } from '../hooks/spool.ts';
import { resolvePaths } from '../config.ts';
import { registerIpc, pushFleet } from './ipc.ts';
import { refreshLiveProcesses } from '../discovery/live.ts';

let db: Db | null = null;
let watcher: Watcher | null = null;
let spoolTimer: NodeJS.Timeout | null = null;
// Refreshes discovery/live.ts's process cache; buildFleetPayload reads that
// cache rather than sweeping itself. Declared at module scope and cleared
// in before-quit for the same reason spoolTimer is (see the comment on
// pushTimer below): a timer hidden inside the setImmediate closure would be
// unreachable from before-quit.
let discoveryTimer: NodeJS.Timeout | null = null;
// Coalesces watcher bursts into one push per 250ms (below). Declared here,
// alongside spoolTimer, rather than as a local inside the setImmediate
// closure below it used to be: a variable scoped to that closure is
// unreachable from before-quit, so nothing could ever clear it, and a
// watcher event arriving in the last 250ms before quit would fire its
// pushFleet call after db was already closed.
let pushTimer: NodeJS.Timeout | null = null;
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

  // ingestAll is synchronous and, measured against the real index (~1,360
  // files, ~194,000 events), takes ~15s cold / ~0.6s warm -- long enough to
  // block the main process's event loop before it ever processes the
  // 'ready-to-show' delivery from the renderer, so the window would not
  // even paint until this finished. Deferred one tick via setImmediate so
  // whenReady's synchronous work (opening the db, registering IPC,
  // constructing the window) hands control back to the event loop first;
  // the window then shows FleetView's loading state immediately, with real
  // data replacing it once this runs. This does not make ingestAll itself
  // non-blocking -- the main process is still unresponsive for the
  // duration of the call -- only unblocks the window's first paint, which
  // is what ingestAll(db, roots()) called inline here previously prevented.
  setImmediate(() => {
    if (!db) return;
    // Catch up on anything written while the app was closed, then watch.
    ingestAll(db, roots());

    // Watcher events arrive per file and can burst; coalesce so a busy
    // session does not push a payload per line written.
    watcher = startWatcher(db, roots(), () => {
      if (pushTimer) return;
      pushTimer = setTimeout(() => { pushTimer = null; if (db) pushFleet(db, mainWindow); }, 250);
    });

    spoolTimer = setInterval(() => {
      if (!db) return;
      if (ingestSpool(db, paths.spool) > 0) pushFleet(db, mainWindow);
    }, 1000);
    rotateSpool(paths.spool, { maxAgeDays: 30, maxFiles: 20000 });

    // Live process discovery (pgrep/ps/lsof) is async and, measured against
    // this machine's real process set, takes ~118ms wall clock even run
    // concurrently -- too slow to trigger from buildFleetPayload, which
    // runs on every coalesced push (every ~250ms, above). Refreshed here on
    // its own interval instead, into a cache buildFleetPayload reads
    // synchronously; 5s is frequent enough that a newly-started or
    // newly-ended process shows up promptly without re-running ~13
    // pgrep/ps/lsof processes several times a second. Fired once
    // immediately too, so the cache isn't empty for the first 5s after
    // launch.
    void refreshLiveProcesses();
    discoveryTimer = setInterval(() => { void refreshLiveProcesses(); }, 5000);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  if (spoolTimer) clearInterval(spoolTimer);
  if (discoveryTimer) clearInterval(discoveryTimer);
  // Cancels a coalesced push already scheduled but not yet fired. Without
  // this, a watcher event in the last 250ms before quit still fires its
  // pushFleet call after db below is closed.
  if (pushTimer) clearTimeout(pushTimer);
  void watcher?.close();
  db?.close();
  // watcher.close() above is fire-and-forget (not awaited), so a watcher
  // event already in flight can still call startWatcher's onOutcome after
  // this point and schedule a NEW pushTimer this handler never sees. Every
  // site that later checks `if (db)` before using it (the pushTimer
  // callback above, the spoolTimer callback below) needs db to actually
  // read as closed once it is -- not stay a truthy reference to a closed
  // handle, which throws TypeError on use rather than being falsy.
  db = null;
});
