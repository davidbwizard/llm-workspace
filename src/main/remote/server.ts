import { createServer } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { object, REMOTE_VERSION, type OperationResult, type RemoteOperation } from '../../core/remote.ts';
import type { SessionOperations } from '../sessionOperations.ts';
import type { TerminalClients } from '../terminalClients.ts';
import { SessionActions } from '../sessionActions.ts';
import { ImageUploads } from './imageUploads.ts';
import { authorize, Budget, Tickets } from './auth.ts';
import { parseRemoteConfig, type RemoteConfig } from './config.ts';
export interface RemoteServices {
  operations: SessionOperations; terminals: TerminalClients; assets: string;
  watch(client: string, pid: number | null, emit: (payload: unknown) => void): boolean;
  release(client: string): void;
  previews?(handle: string): Promise<unknown>;
}
export async function startRemoteServer(raw: RemoteConfig, services: RemoteServices) {
  const config = parseRemoteConfig(raw);
  if (!config.enabled) return { close: async () => {} };
  const root = realpathSync(services.assets);
  if (!statSync(resolve(root, 'index.html')).isFile()) throw new Error('Mobile build is missing. Run npm run build:mobile.');
  const generation = randomUUID(); const tickets = new Tickets(); const receipts = new SessionActions();
  const requests = new Budget(240, 60_000); const handshakes = new Budget(60, 60_000);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const uploads = new ImageUploads(services.operations);
  let stopping = false;
  const pending = new Set<Promise<void>>();
  const cleanups = new Set<() => void>();
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
    const fail = (status: number) => { res.writeHead(status); res.end(); };
    if (stopping || !requests.take()) return fail(429);
    if (!authorize(req, config)) return fail(403);
    if (req.method === 'POST' && req.url === '/api/images') {
      if (!authorize(req, config, true)) { req.resume(); return fail(403); }
      const work = uploads.receive(req, res); pending.add(work); void work.finally(() => pending.delete(work)); return;
    }
    if (req.method !== 'GET') { req.resume(); return fail(405); }
    if (req.url === '/api/bootstrap') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ v: REMOTE_VERSION, generation, ticket: tickets.issue() })); return;
    }
    try {
      const pathname = decodeURIComponent((req.url ?? '').split('?')[0]!);
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.split('/').includes('..') || pathname.includes('\0')) return fail(404);
      const file = realpathSync(resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)));
      if (!file.startsWith(root + sep) || !statSync(file).isFile()) return fail(404);
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
      const mime = types[extname(file)]; if (!mime) return fail(404);
      res.setHeader('Content-Type', mime); res.end(readFileSync(file));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(error instanceof URIError) && !['ENOENT', 'ENOTDIR'].includes(code ?? '')) console.error('Remote asset read failed:', code ?? 'invalid path');
      fail(404);
    }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000; server.timeout = 30_000;
  server.on('upgrade', (req, socket, head) => {
    if (stopping || !handshakes.take() || wss.clients.size >= 8 || req.url !== '/socket' || !authorize(req, config, true)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const output = new Map<string, { bytes: number; at: number }>(); let outputBytes = 0; let terminalHandle: string | null = null;
    const client = randomUUID(); let authenticated = false; let cleaned = false; let alive = true; let sequence = 0;
    const frames = new Budget(512, 1000);
    const readBudget = new Budget(90, 60_000); const mutationBudget = new Budget(30, 60_000);
    const terminalBudget = new Budget(120, 60_000); const rawBudget = new Budget(256 * 1024, 1000);
    const send = (value: unknown) => {
      if (ws.readyState !== WebSocket.OPEN || cleaned) return;
      const data = JSON.stringify(value);
      if (ws.bufferedAmount + Buffer.byteLength(data) > 1024 * 1024) { ws.terminate(); cleanup(); return; }
      ws.send(data, error => { if (error) { ws.terminate(); cleanup(); } });
    };
    const emit = (event: string, payload: unknown) => {
      const p = object(payload);
      if (event === 'terminal:exit' && p?.reason === 'slow_viewer') { ws.terminate(); cleanup(); return; }
      if (event === 'terminal:data' && typeof p?.data === 'string') {
        const bytes = Buffer.byteLength(p.data) + 256;
        if (outputBytes + bytes > 1024 * 1024 || output.size >= 256) { ws.terminate(); cleanup(); return; }
        const delivery = randomUUID(); output.set(delivery, { bytes, at: Date.now() }); outputBytes += bytes;
        payload = { ...p, delivery };
      }
      send({ event, payload, generation, client, sequence: ++sequence });
    };
    const authTimer = setTimeout(() => { ws.terminate(); cleanup(); }, 5000);
    const heartbeat = setInterval(() => { if (!alive || (output.size > 0 && Date.now() - output.values().next().value!.at > 15_000)) { ws.terminate(); cleanup(); return; } alive = false; ws.ping(); }, 7000);
    const cleanup = () => {
      if (cleaned) return; cleaned = true; clearTimeout(authTimer); clearInterval(heartbeat); cleanups.delete(cleanup); output.clear(); outputBytes = 0;
      uploads.release(client); services.terminals.release(client); services.release(client); services.operations.release(client);
    };
    cleanups.add(cleanup);
    ws.on('pong', () => { alive = true; }); ws.on('close', cleanup); ws.on('error', () => { ws.terminate(); cleanup(); });
    async function dispatch(op: string, payload: unknown): Promise<OperationResult> {
      if (cleaned || stopping) return { ok: false, reason: 'unavailable' };
      const p = object(payload);
      switch (op) {
        case 'terminal:detach': {
          // Releasing this socket's resources needs no still-live session identity.
          services.terminals.release(client); output.clear(); outputBytes = 0; terminalHandle = null;
          return { ok: true, value: { status: 'detached' } };
        }
        case 'terminal:ack': {
          const receipt = typeof p?.delivery === 'string' ? output.get(p.delivery) : undefined;
          if (!receipt) return { ok: false, reason: 'invalid' };
          output.delete(p!.delivery as string); outputBytes -= receipt.bytes;
          return { ok: true, value: null };
        }
        case 'list': return { ok: true, value: services.operations.list() };
        case 'projects': return { ok: true, value: services.operations.projects() };
        case 'conversation': case 'live': return services.operations.read(client, op, payload);
        case 'image:prepare': return typeof p?.handle === 'string' ? uploads.prepare(client, p.handle) : { ok: false, reason: 'invalid' };
        case 'image:clear': await services.operations.discardImages(client); return { ok: true, value: null };
        case 'send': case 'answerClaude': case 'answerCodex': case 'launch': case 'close': return services.operations.mutate(client, op as RemoteOperation, payload);
        case 'watch': {
          if (p?.handle === null) return { ok: true, value: services.watch(client, null, () => {}) };
          const target = typeof p?.handle === 'string' ? services.operations.resolve(p.handle) : null;
          return target ? { ok: true, value: services.watch(client, target.pid, data => emit('session:live', data)) } : { ok: false, reason: 'stale' };
        }
        case 'previews': return typeof p?.handle === 'string' && services.previews ? { ok: true, value: await services.previews(p.handle) } : { ok: false, reason: 'unsupported' };
        case 'terminal:attach': case 'terminal:resize': case 'terminal:input': case 'terminal:control': {
          if (op === 'terminal:input' && (typeof p?.data !== 'string' || !rawBudget.take(Buffer.byteLength(p.data)))) return { ok: false, reason: 'busy' };
          const target = typeof p?.handle === 'string' ? services.operations.resolve(p.handle) : null;
          if (!target?.tmux) return { ok: false, reason: 'stale' };
          let result: unknown;
          if (op === 'terminal:control') result = services.terminals.takeControl(client, target.pid);
          else if (op === 'terminal:input') {
            if (typeof p!.data !== 'string') return { ok: false, reason: 'invalid' };
            result = services.terminals.input(client, target.pid, p!.data);
          } else {
            if (typeof p!.cols !== 'number' || typeof p!.rows !== 'number') return { ok: false, reason: 'invalid' };
            if (op === 'terminal:attach' && terminalHandle !== p!.handle) {
              services.terminals.release(client); output.clear(); outputBytes = 0; terminalHandle = p!.handle as string;
            }
            result = op === 'terminal:attach' ? await services.terminals.attach(client, target.pid, p!.cols, p!.rows, emit) : services.terminals.resize(client, target.pid, p!.cols, p!.rows);
            if (cleaned) services.terminals.release(client);
          }
          return { ok: true, value: result };
        }
        default: return { ok: false, reason: 'unsupported' };
      }
    }
    ws.on('message', (data, binary) => {
      if (binary || !frames.take()) { ws.terminate(); cleanup(); return; }
      let p: Record<string, unknown> | null;
      try { p = object(JSON.parse(data.toString())); } catch { ws.terminate(); cleanup(); return; }
      if (!authenticated) {
        if (p?.v !== REMOTE_VERSION || p.op !== 'authenticate' || p.generation !== generation || !tickets.consume(p.ticket)) { ws.terminate(); cleanup(); return; }
        authenticated = true; clearTimeout(authTimer); send({ event: 'ready', client, generation }); return;
      }
      if (!p || p.v !== REMOTE_VERSION || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || typeof p.op !== 'string') { ws.terminate(); cleanup(); return; }
      const id = p.id; const op = p.op; const payload = p.payload;
      if (p.client !== client || p.generation !== generation) { send({ id, result: { ok: false, reason: 'stale' } }); return; }
      const mutation = ['send', 'answerClaude', 'answerCodex', 'launch', 'close', 'image:prepare'].includes(op);
      const releases = op === 'terminal:detach' || (op === 'watch' && object(payload)?.handle === null);
      const exempt = releases || op === 'terminal:input' || op === 'terminal:ack';
      const budget = mutation ? mutationBudget : op.startsWith('terminal:') ? terminalBudget : readBudget;
      if (!exempt && !budget.take()) { send({ id, result: { ok: false, reason: 'busy' } }); return; }
      const work = (async () => {
        try {
          const result = mutation ? await receipts.run(String(object(payload)?.handle ?? 'launch'), id, JSON.stringify([op, payload]), () => dispatch(op, payload)) : await dispatch(op, payload);
          send({ id, result });
        } catch { console.error('Remote operation failed:', op); send({ id, result: { ok: false, reason: mutation ? 'uncertain' : 'unavailable' } }); }
      })();
      pending.add(work); void work.finally(() => pending.delete(work));
    });
  });
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolveReady(); }); });
  server.on('error', error => console.error('Remote server error:', (error as NodeJS.ErrnoException).code ?? 'unknown'));
  let closing: Promise<void> | undefined;
  return { close(): Promise<void> {
    if (closing) return closing;
    stopping = true; receipts.close();
    for (const ws of wss.clients) ws.terminate(); for (const cleanup of cleanups) cleanup();
    closing = (async () => {
      await new Promise<void>(resolveClosed => { server.close(() => resolveClosed()); server.closeAllConnections(); });
      await new Promise<void>(resolveClosed => wss.close(() => resolveClosed()));
      await Promise.allSettled([...pending]);
    })(); return closing;
  } };
}
