import { createConnection, createServer, type Socket } from 'node:net';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TMUX_NAME } from './tmux.ts';
import { CodexThreadTracker, WebSocketRpcObserver } from './codexRelayProtocol.ts';

// Standalone electron-vite entry. Fleet starts it under ELECTRON_RUN_AS_NODE
// in its own tmux session, so a Fleet restart cannot drop the native TUI's
// connection to Codex. Only fixed, main-generated paths and names reach it.
const [socketPath, backendPath, tuiName] = process.argv.slice(2);
if (!socketPath || !backendPath || !tuiName || !/^llmws-codex-relay-[0-9a-f]{8}$/.test(tuiName)
  || !TMUX_NAME.test(tuiName) || !socketPath.startsWith('/')) {
  console.error('Codex relay: invalid launch arguments');
  process.exit(2);
}

function setOption(key: string, value: string): boolean {
  try {
    execFileSync('tmux', ['set-option', '-t', `=${tuiName}:`, key, value], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch (error) {
    console.error('Codex relay: could not update tmux identity:', error);
    return false;
  }
}

function tuiExists(): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${tuiName}:`], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

process.umask(0o077);
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
let active: Socket | null = null;
let everSawTui = false;
const startedAt = Date.now();

const server = createServer(client => {
  if (active && !active.destroyed) { client.destroy(); return; }
  active = client;
  let backend: Socket;
  const tracker = new CodexThreadTracker(id => {
    if (id === null) { setOption('@llmws-codex-connected', '0'); return; }
    if (setOption('@llmws-codex-thread', id)) setOption('@llmws-codex-connected', '1');
    else setOption('@llmws-codex-connected', '0');
  });
  tracker.disconnected();
  const fromTui = new WebSocketRpcObserver(true, value => tracker.fromTui(value), () => tracker.disconnected());
  const fromServer = new WebSocketRpcObserver(false, value => tracker.fromServer(value), () => tracker.disconnected());
  try { backend = createConnection(backendPath); }
  catch (error) {
    console.error('Codex relay: App Server connection failed:', error);
    client.destroy();
    return;
  }
  client.on('data', bytes => fromTui.feed(bytes));
  backend.on('data', bytes => fromServer.feed(bytes));
  client.pipe(backend);
  backend.pipe(client);
  client.on('close', () => { tracker.disconnected(); backend.destroy(); if (active === client) active = null; });
  backend.on('close', () => { tracker.disconnected(); client.destroy(); });
  client.on('error', error => console.error('Codex relay: TUI socket error:', error));
  backend.on('error', error => console.error('Codex relay: App Server socket error:', error));
});

server.on('error', error => { console.error('Codex relay: listener failed:', error); process.exitCode = 1; });
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  const timer = setInterval(() => {
    if (tuiExists()) { everSawTui = true; return; }
    if (!everSawTui && Date.now() - startedAt < 30_000) return;
    clearInterval(timer);
    active?.destroy();
    server.close();
  }, 3000);
  timer.unref();
});
server.on('close', () => {
  try { unlinkSync(socketPath); }
  catch (error) { console.error('Codex relay: could not remove socket:', error); }
});
