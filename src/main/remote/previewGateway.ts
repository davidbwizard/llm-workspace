import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import type { PreviewConfig, RemoteConfig } from './config.ts';
import { inspectPreviewTarget } from './previewTarget.ts';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function headers(req: IncomingMessage, websocket = false): OutgoingHttpHeaders {
  const blocked = new Set([...HOP_HEADERS, ...(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())]);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (blocked.has(name) || name.startsWith('tailscale-') || name.startsWith('x-forwarded-') || ['forwarded', 'x-real-ip', 'authorization', 'cookie', 'set-cookie'].includes(name)) continue;
    result[name] = value;
  }
  if (websocket) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
  return result;
}
function route(req: IncomingMessage, config: RemoteConfig): PreviewConfig | undefined {
  if (!config.enabled || !config.login || req.socket.remoteAddress !== '127.0.0.1' || !req.url?.startsWith('/') || req.url.startsWith('//')) return;
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) { const key = req.rawHeaders[i]!.toLowerCase(); if (seen.has(key)) return; seen.add(key); }
  if (req.headers['tailscale-user-login'] !== config.login) return;
  const matches = config.previews.filter(p => p.managed === true && (p.localHost === '127.0.0.1' || p.localHost === '::1') && new URL(p.url).host === req.headers.host);
  if (matches.length !== 1) return;
  const preview = matches[0]!;
  if (req.headers.origin !== undefined && req.headers.origin !== preview.url) return;
  if (req.headers.origin === undefined) {
    if (req.headers.upgrade || !['GET', 'HEAD'].includes(req.method ?? '')) return;
    const site = req.headers['sec-fetch-site'];
    if ((site === 'cross-site' || site === 'same-site') && (req.method !== 'GET' || req.headers['sec-fetch-mode'] !== 'navigate' || req.headers['sec-fetch-dest'] !== 'document')) return;
  }
  return preview;
}
function reply(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) res.destroy(); else { res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(message); }
}
function refuse(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function localOrigin(preview: PreviewConfig) { return `http://localhost:${preview.localPort}`; }
function responseHeaders(upstream: IncomingMessage, preview: PreviewConfig, websocket = false) {
  const result = headers(upstream, websocket);
  const location = result.location;
  if (typeof location === 'string') {
    try {
      const target = new URL(location);
      if (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && Number(target.port || 80) === preview.localPort && !target.username && !target.password) result.location = preview.url + target.pathname + target.search + target.hash;
    } catch { /* Relative redirects already resolve on the private preview origin. */ }
  }
  return result;
}
export async function startPreviewGateway(options: {
  port: number;
  getConfig: () => RemoteConfig;
  verifyTarget?: (preview: PreviewConfig) => Promise<boolean>;
}): Promise<{ close(): Promise<void> }> {
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Invalid preview gateway port.');
  const sockets = new Set<Duplex>(); const pending = new Map<string, Promise<boolean>>(); let closed = false; let active = 0;
  const authorized = new Map<IncomingMessage, string>();
  const revocations = setInterval(() => {
    const config = options.getConfig();
    for (const [req, key] of authorized) if (JSON.stringify(route(req, config)) !== key) req.socket.destroy();
  }, 1000);
  revocations.unref();
  const verify = options.verifyTarget ?? (async (preview: PreviewConfig) => (await inspectPreviewTarget(preview.project, preview.localPort)).host === preview.localHost);
  const track = (socket: Duplex) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); for (const req of authorized.keys()) if (req.socket === socket) authorized.delete(req); }); socket.on('error', () => socket.destroy()); };
  async function allowed(req: IncomingMessage): Promise<PreviewConfig | undefined> {
    const config = options.getConfig(); const found = route(req, config); if (!found || found.localPort === options.port || found.localPort === config.port) return;
    const preview = { ...found }; const key = JSON.stringify(preview);
    let check = pending.get(key);
    if (!check) {
      let timer: ReturnType<typeof setTimeout>;
      check = Promise.race([Promise.resolve().then(() => verify(preview)), new Promise<boolean>((_, reject) => { timer = setTimeout(() => reject(new Error('Preview verification timed out.')), 5000); })]).finally(() => { clearTimeout(timer); pending.delete(key); });
      pending.set(key, check);
    }
    if (!await check) throw new Error('The preview server no longer belongs to this project.');
    if (closed || req.socket.destroyed || JSON.stringify(route(req, options.getConfig())) !== key) return;
    authorized.set(req, key);
    return preview;
  }
  function upstreamRequest(req: IncomingMessage, preview: PreviewConfig, websocket = false) {
    const outgoing = headers(req, websocket); outgoing.host = `localhost:${preview.localPort}`;
    if (outgoing.origin !== undefined) outgoing.origin = localOrigin(preview);
    const upstream = request({ host: preview.localHost, port: preview.localPort, path: req.url, method: req.method, headers: outgoing, agent: false });
    upstream.once('socket', socket => { track(socket); socket.setTimeout(30_000, () => socket.destroy(new Error('Preview upstream timed out.'))); });
    return upstream;
  }
  const server = createServer(async (req, res) => {
    if (closed || active >= 128) { reply(res, 503, 'Preview is busy.'); return; }
    active++; let released = false; const release = () => { if (!released) { released = true; active--; } }; res.once('close', () => { release(); authorized.delete(req); });
    let preview: PreviewConfig | undefined;
    try { preview = await allowed(req); } catch { reply(res, 502, 'The project server could not be verified.'); return; }
    if (!preview) { reply(res, 403, 'Private preview access denied.'); return; }
    if (req.destroyed || res.destroyed) return;
    const upstream = upstreamRequest(req, preview);
    req.once('error', () => upstream.destroy()); req.once('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy());
    upstream.on('error', () => reply(res, 502, 'The project server is unavailable.'));
    upstream.on('response', response => {
      res.writeHead(response.statusCode ?? 502, responseHeaders(response, preview!));
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    req.pipe(upstream);
  });
  server.on('connection', socket => { if (closed || sockets.size >= 256) socket.destroy(); else track(socket); });
  server.on('clientError', (_error, socket) => { if (!socket.destroyed) refuse(socket, 400); });
  server.on('upgrade', async (req, socket, head) => {
    if (closed || active >= 128) { refuse(socket, 503); return; }
    active++; socket.once('close', () => active--);
    let preview: PreviewConfig | undefined;
    try { preview = await allowed(req); } catch { refuse(socket, 502); return; }
    if (!preview || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.method !== 'GET') { refuse(socket, 403); return; }
    if (socket.destroyed) return;
    const upstream = upstreamRequest(req, preview, true);
    socket.once('close', () => upstream.destroy());
    upstream.on('error', () => { if (!socket.destroyed) socket.destroy(); });
    upstream.on('response', response => { response.destroy(); refuse(socket, 502); });
    upstream.on('upgrade', (response, target, upstreamHead) => {
      if (response.statusCode !== 101 || socket.destroyed) { target.destroy(); socket.destroy(); return; }
      const outgoing = responseHeaders(response, preview!, true);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(outgoing).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(v => `${key}: ${v}\r\n`)).join('') + '\r\n');
      (socket as Socket).setTimeout(120_000, () => socket.destroy()); target.setTimeout(120_000, () => target.destroy());
      socket.once('close', () => target.destroy()); target.once('close', () => socket.destroy());
      if (head.length) target.write(head); if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(target); target.pipe(socket);
    });
    upstream.end();
  });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000; server.timeout = 30_000; server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { clearInterval(revocations); reject(error); };
    server.once('error', failed); server.listen(options.port, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; clearInterval(revocations); for (const socket of sockets) socket.destroy();
    closing = new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    return closing;
  }
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (closed) return;
    console.error('Private preview gateway stopped:', error.code ?? 'server error');
    void close().catch(() => console.error('Private preview gateway could not close its listener.'));
  });
  return { close };
}
