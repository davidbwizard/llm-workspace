import { app, BrowserWindow, shell, nativeTheme, Menu } from 'electron';
import { join } from 'node:path';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { openDb, type Db } from '../store/db.ts';
import { ingestAll, startWatcher, type Watcher, type WatchRoot } from '../watch/watcher.ts';
import { ingestSpool, rotateSpool } from '../hooks/spool.ts';
import { refreshHelperIfInstalled } from '../hooks/switch.ts';
import { refreshStatusLineIfInstalled } from '../hooks/usageSwitch.ts';
import { pruneSnapshots } from '../providers/claude/statusLine.ts';
import { resolvePaths } from '../config.ts';
import { registerIpc, pushFleet, refreshPushEnrichment, refreshChecks } from './ipc.ts';
import { refreshLiveProcesses } from '../discovery/live.ts';
import { adoptRunningSessions } from './sessions.ts';
import { readStoredTheme } from './appearance.ts';
import { notifySessionChanged, pushSessionLive, watchSessionFor, type WatchDeps } from './sessionLive.ts';
import { contextMenuTemplate } from './contextMenu.ts';
import { applyLoginPathOnce } from './loginPath.ts';

// The release-only shape of watchSessionFor's deps -- window close and
// before-quit only ever call it with pid: null (stop watching), which
// never reaches processes()/buildPayload()/send() at all (see
// watchSessionFor's own doc comment on why teardown-on-null never touches
// deps), so there is nothing real for these three to do.
const NOOP_WATCH_DEPS: WatchDeps = { processes: () => [], buildPayload: () => null, send: () => {} };

let db: Db | null = null;
let watcher: Watcher | null = null;
let spoolTimer: NodeJS.Timeout | null = null;
// Refreshes discovery/live.ts's process cache; buildFleetPayload reads that
// cache rather than sweeping itself. Declared at module scope and cleared
// in before-quit for the same reason spoolTimer is (see the comment on
// pushTimer below): a timer hidden inside a closure would be unreachable
// from before-quit.
let discoveryTimer: NodeJS.Timeout | null = null;
// Coalesces watcher bursts into one push per 250ms (below). Declared here,
// alongside spoolTimer, rather than as a local inside a closure: a variable
// scoped to a closure is unreachable from before-quit, so nothing could
// ever clear it, and a watcher event arriving in the last 250ms before quit
// would fire its pushFleet call after db was already closed.
let pushTimer: NodeJS.Timeout | null = null;
let mainWindow: BrowserWindow | null = null;
// Guards startBackgroundWork (below) so ingestAll, the watcher and
// spoolTimer start exactly once, no matter which of its two triggers fires
// first.
let backgroundStarted = false;

const paths = resolvePaths(homedir());

function roots(): WatchRoot[] {
  return [
    { dir: paths.claudeProjects, provider: 'claude' as const, glob: /\.jsonl$/ },
    { dir: paths.codexSessions, provider: 'codex' as const, glob: /rollout-.*\.jsonl$/ },
  ].filter(r => existsSync(r.dir));
}

/** The window's very first frame is painted before any stylesheet exists,
 *  so these two are theme.css's own --ground values, duplicated here of
 *  necessity. tests/renderer/theme.test.ts pins them to the tokens so they
 *  cannot drift unnoticed -- drift here is invisible to every renderer
 *  test and shows up only as a flash of the wrong colour on launch. */
const FIRST_PAINT_BG = { dark: '#1a1918', light: '#f6f5f3' } as const;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 720, minHeight: 480,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? FIRST_PAINT_BG.dark : FIRST_PAINT_BG.light,
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
  // No watcher must outlive the window it was pushing to -- a leaked
  // fs.watch handle is exactly the class of bug this app has been bitten by
  // before (leaked processes). watchSessionFor(null, ...) is idempotent
  // (a no-op with nothing watched), so this is safe even when the window
  // closing was itself the trigger that already tore the watch down.
  win.on('closed', () => { mainWindow = null; watchSessionFor(null, NOOP_WATCH_DEPS); });

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

  // The right-click edit menu. contextMenuTemplate (src/main/contextMenu.ts)
  // is pure -- it decides WHAT the menu contains from `params` alone, with
  // no webContents of its own to call anything on. This is the one place
  // that turns its plain data into a real Electron menu: 'suggestion' items
  // get a click that calls the real replaceMisspelling; 'role' items need
  // no click handler at all (Electron performs cut/copy/paste/select-all
  // itself for a MenuItem carrying that role). An empty template (neither
  // editable nor a text selection) never calls popup() -- no menu at all,
  // per contextMenuTemplate's own doc comment, rather than an empty one.
  win.webContents.on('context-menu', (_event, params) => {
    const items = contextMenuTemplate(params);
    if (items.length === 0) return;
    Menu.buildFromTemplate(items.map(item => {
      if (item.kind === 'separator') return { type: 'separator' };
      if (item.kind === 'suggestion') {
        return { label: item.label, click: () => win.webContents.replaceMisspelling(item.label) };
      }
      return { label: item.label, role: item.role, enabled: item.enabled };
    })).popup();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

/** ingestAll is synchronous and, measured against the real index (~1,390
 *  files, ~200,000 events), takes ~523ms warm -- long enough that if it is
 *  already running when the renderer's first fleet:list request arrives,
 *  that request queues behind it and waits out however much is left. JS
 *  cannot preempt a running synchronous call, so no amount of reordering
 *  elsewhere fixes that once ingestAll has actually started -- the only
 *  fix is to never START it until the first reply is already on its way
 *  out. registerIpc's fleet:list handler (src/main/ipc.ts) answers from
 *  whatever the index already holds without touching ingestAll or
 *  fleetState (see buildFleetListPayload's doc comment there) and, only
 *  once that reply is queued for delivery, calls this via setImmediate --
 *  see the registerIpc call below. Also called as a fallback from
 *  did-finish-load, in case the renderer never calls fleet:list at all
 *  (e.g. a failed preload, Task 5): ingestAll, the watcher and spool
 *  rotation must run regardless of whether this window's UI works.
 *  Idempotent via backgroundStarted so whichever of the two triggers fires
 *  first is authoritative and the other is a no-op -- this is what makes
 *  the ordering real rather than a race either trigger could "win".
 */
function startBackgroundWork(): void {
  if (backgroundStarted || !db) return;
  backgroundStarted = true;

  // Catch up on anything written while the app was closed, then watch.
  // pushFleet reads whatever refreshPushEnrichment last cached (see its
  // doc comment in src/main/ipc.ts) rather than querying itself, so it
  // never touches the database on any of these triggers.
  // ingestAll catches per FILE (so a busy-timeout throw on one file's write
  // is already only a skip), but a throw from the corpus walk itself is
  // outside that and escapes. Unwrapped here it would not just crash the
  // main process: it would skip the watcher and the spool timer below and
  // leave the app running with no ingestion at all. Logged with its reason,
  // never swallowed. Nothing is lost for long -- startWatcher runs with
  // ignoreInitial false, so its own initial scan re-walks the same corpus.
  try {
    ingestAll(db, roots());
  } catch (err) {
    console.error('startup ingest failed, the watcher will catch up:', err instanceof Error ? err.message : String(err));
  }
  pushFleet(mainWindow);

  // Watcher events arrive per file and can burst; coalesce so a busy
  // session does not push a payload per line written. notifySessionChanged
  // is called unconditionally on every outcome, not only when pushTimer
  // schedules a fleet push -- it does its own, separate 250ms coalescing
  // (src/main/sessionLive.ts) keyed to whichever session the conversation
  // pane is currently watching, which is not the same session a fleet push
  // fires for.
  watcher = startWatcher(db, roots(), (_path, _provider, out) => {
    notifySessionChanged(new Set(out.events.map(e => e.sessionId)));
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; pushFleet(mainWindow); }, 250);
  });

  // Quick answers (final review I1): Claude flips its status file to
  // waiting just BEFORE the PermissionRequest hook is written, so the
  // status-file push goes out with no prompt. The tick that ingests that
  // event must push the watched session itself, or the card waits for the
  // 5s sweep.
  spoolTimer = setInterval(() => {
    if (!db) return;
    const touched = new Set<string>();
    // A write that outwaits better-sqlite3's 5s busy timeout throws, and an
    // interval callback has no caller to catch it -- unwrapped, that is an
    // unhandled exception and the whole main process goes with it. Rare
    // while one instance runs; steadily less rare with a packaged build
    // beside a dev one. ingestSpool only removes a spool file once its row
    // is written, so whatever failed is still on disk for the next tick to
    // retry. Logged with its reason, never swallowed -- the same shape
    // sessionLive.ts already uses for its own ingestSpool call.
    let written = 0;
    try {
      written = ingestSpool(db, paths.spool, 'claude', touched);
    } catch (err) {
      console.error('spool ingest failed, retrying on the next tick:', err instanceof Error ? err.message : String(err));
    }
    // touched can only be non-empty when rows were actually written, so
    // reading it as well as `written` changes nothing on the happy path --
    // it is what still pushes the rows that landed before a throw, which
    // are committed and would otherwise wait for an unrelated later push.
    if (written > 0 || touched.size > 0) {
      pushFleet(mainWindow);
      notifySessionChanged(touched);
    }
  }, 1000);
  rotateSpool(paths.spool, { maxAgeDays: 30, maxFiles: 20000 });
  // Usage and context: one snapshot per session, never removed by the
  // helper -- a week without a rewrite means the session is long gone.
  pruneSnapshots(paths.statusLineDir, { maxAgeDays: 7 });
}

app.whenReady().then(async () => {
  // FIRST, and awaited, because everything after it can shell out. A GUI
  // launch (Finder, Dock, Spotlight) hands this process a minimal PATH
  // that has no tmux, claude or codex on it -- see src/main/loginPath.ts.
  // One assignment to process.env.PATH here is what makes every later
  // spawn in the process see the real one, rather than each call site
  // growing its own env. Measured 2026-09-21 on this machine: ~470ms for a
  // real zsh profile, bounded at execFileSoft's 2s, and a failure leaves
  // the inherited PATH alone rather than blocking startup. That delay
  // before the first frame is the price of never spawning against a PATH
  // we already know is wrong.
  const pathResult = await applyLoginPathOnce();
  if (pathResult.status === 'failed') {
    console.error('PATH: could not ask the login shell, using the inherited PATH:', pathResult.error);
  } else if (pathResult.status === 'applied') {
    // The one line that makes this visible. A GUI-launched app's failure
    // mode here is silent by construction -- the PATH is simply short and
    // every Launch fails later, somewhere else -- so what was added is
    // worth stating outright rather than inferring from a failure. The
    // ADDED directories, not the whole PATH: that is the part that was not
    // there before, and it stays one readable line. Silent under
    // `npm run dev`, where there is never anything to add.
    console.log('PATH: added from the login shell:', pathResult.added.join(' '));
  }

  mkdirSync(join(homedir(), '.llm-workspace'), { recursive: true });

  // Quick answers, spec §4 "Spool privacy": the spool now holds commands
  // and plan text. mkdirSync's `mode` is only honoured on creation, so an
  // already-existing spool from before this app enforced 0700 (or one the
  // helper created before its own umask fix) needs its own chmod to be
  // tightened, not just created narrow going forward.
  mkdirSync(paths.spool, { recursive: true, mode: 0o700 });
  // Best-effort (must not block startup), but never silent: the error names
  // the folder and the reason, never any spooled file's contents.
  try { chmodSync(paths.spool, 0o700); } catch (e) { console.error('Quick answers: could not tighten the spool folder to 0700:', e); }

  // Quick answers, spec §4: "On every app start with hooks installed,
  // refresh the copy if its content differs." app.getAppPath() is the
  // project root in dev and the asar/app root when packaged, and
  // electron-builder.yml ships src/hooks/*.sh at that same relative path,
  // so this one resolution works in both. Reading it back out of the asar
  // is fine: Electron's fs is asar-aware, and refreshStableCopy only ever
  // READS the source before writing its own copy to ~/.llm-workspace/bin.
  refreshHelperIfInstalled(paths, join(app.getAppPath(), 'src/hooks/helper.sh'));
  // Same rule for the "Usage and context" status line script.
  refreshStatusLineIfInstalled(paths, join(app.getAppPath(), 'src/hooks/statusline.sh'));

  db = openDb(paths.db);

  // Before createWindow, not after: backgroundColor below is read once, at
  // construction. shouldUseDarkColors then reflects this choice for an
  // explicit Light or Dark, and the OS setting for 'system'.
  nativeTheme.themeSource = readStoredTheme(paths.appearance);

  // startBackgroundWork (above) is passed through so the fleet:list handler
  // can trigger it itself, strictly after answering -- the primary trigger
  // for the ordering this change exists to guarantee. The third and fourth
  // arguments are forward references to pushAfterDiscoverySweep, declared
  // further down in this same function -- safe because registerIpc only
  // stores these closures and calls them later (from session:kill and
  // session:launch/session:reattach, in response to a future IPC message),
  // never during this synchronous setup, by which point
  // pushAfterDiscoverySweep has long since been assigned. A freshly
  // launched or reattached session gets the identical immediate refresh a
  // kill already does, rather than sitting stale in the rail for up to 5s.
  registerIpc(db, startBackgroundWork, () => pushAfterDiscoverySweep(), () => pushAfterDiscoverySweep());
  createWindow();

  // Live process discovery (pgrep/ps/lsof) has nothing to do with the
  // sqlite index and, measured against this machine's real process set,
  // takes ~118ms wall clock run concurrently, with the event loop
  // confirmed still responsive throughout -- started immediately rather
  // than gated behind startBackgroundWork/ingestAll, so open sessions
  // (spec S7.1a) truly never wait on the index. getCachedLiveProcesses
  // (src/discovery/live.ts) returns [] until this first sweep resolves --
  // buildFleetListPayload's openSessions is honestly empty until then.
  // Every sweep also refreshes pushFleet's enrichment cache
  // (refreshPushEnrichment, src/main/ipc.ts) and pushes: a process
  // starting or ending, or its transcript changing, between sweeps is
  // something only this trigger can surface (a watcher/spool/ingest event
  // happening to fire around the same time no longer implies anything
  // about either, now that pushFleet reads a cache instead of querying).
  // db is re-checked, not narrowed from the enclosing scope, for the same
  // shutdown-race reason as the pushTimer callback above.
  //
  // Also reused, via the forward reference passed to registerIpc above, as
  // session:kill's post-kill refresh: a successful kill re-runs the exact
  // same sweep-refresh-push a scheduled tick would, just immediately
  // rather than waiting out however much of the 5s interval is left.
  const pushAfterDiscoverySweep = () => {
    // Rebuilds the pid->tmux-name registry from tmux itself before this
    // sweep's own push -- synchronous and cheap (list-sessions plus one
    // list-panes per matched name), and the ONLY thing that makes a
    // restart's very first render already know which cards are tmux-
    // backed, since `byPid` (src/main/sessions.ts) starts empty on every
    // launch of this app. Also what lets a session's tmux status recover
    // if it ended between sweeps (see adoptRunningSessions' own doc
    // comment) -- run every 5s here, not just once at startup.
    adoptRunningSessions();
    void refreshLiveProcesses().then(processes => {
      if (!db) return;
      refreshPushEnrichment(db, processes);
      pushFleet(mainWindow);
      // Runs even when nothing is watched (a no-op then -- see
      // pushSessionLive's own doc comment): this is also the trigger that
      // notices a watched pid has exited (buildPayload's null, since
      // getCachedLiveProcesses() was just refreshed above) and releases the
      // watch, rather than leaving an fs.watch pointed at a dead process.
      pushSessionLive();
    });
  };
  pushAfterDiscoverySweep();
  discoveryTimer = setInterval(pushAfterDiscoverySweep, 5000);

  // The dependency sweep (design §3). Deliberately NOT awaited: a full pass
  // is ~11s on this machine, almost all of it `codex doctor`, and nothing
  // about opening a window or reading indexed history depends on it. The
  // result is cached in ipc.ts and pushed to the window when it lands, so
  // the panel shows "checking" for as long as it really is checking rather
  // than the app holding its first frame back for eleven seconds.
  //
  // Safe to start here and only here: applyLoginPathOnce was awaited at the
  // top of this function, so runChecks' own whenLoginPathApplied() gate is
  // already satisfied. That gate is what makes the ordering a stated
  // dependency rather than a property of these two statements' order --
  // without the repaired PATH, every probe reports "missing" on a machine
  // where all three are installed (src/main/loginPath.ts).
  // The one line that makes the sweep's outcome visible, for the same
  // reason the PATH line above exists: on a packaged, Finder-launched
  // build there is no terminal to watch, and "every dependency reports
  // missing" is a failure whose only other symptom is a screen that
  // quietly says the wrong thing. One line, one state per dependency,
  // never the doctor output (which can run to thousands of characters and
  // is for the person on screen, not the log).
  void refreshChecks(mainWindow).then(r => {
    if (r) console.log('checks:', r.checks.map(c => `${c.id}=${c.state}`).join(' '));
  });

  // Fallback trigger for startBackgroundWork -- see its doc comment.
  // did-finish-load fires once the window has actually finished loading
  // its page; a working renderer's mount effect calls fleet:list well
  // before that point (its whole script has to run first), so this never
  // wins the race against the primary, handler-triggered path above -- it
  // only fires at all when that primary trigger never did.
  mainWindow?.webContents.once('did-finish-load', startBackgroundWork);

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
  // Same reasoning as the pushTimer clear above, for the session-live
  // watch's own fs.watch and coalesce timer -- belt-and-suspenders with the
  // 'closed' handler's own call to this (win.on('closed') above), since
  // before-quit runs regardless of whether that handler already fired.
  watchSessionFor(null, NOOP_WATCH_DEPS);
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
