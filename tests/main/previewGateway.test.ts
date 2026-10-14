import { afterEach, expect, it } from 'vitest';
import { createServer, request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { startPreviewGateway } from '../../src/main/remote/previewGateway.ts';
import type { RemoteConfig } from '../../src/main/remote/config.ts';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as { port: number }).port;
}
async function setup(verifyTarget = async () => true) {
  let received: IncomingHttpHeaders = {};
  const upstream = createServer((req, res) => { received = req.headers; if (req.url === '/redirect') res.writeHead(302, { location: `http://localhost:${localPort}/next?q=1` }); req.pipe(res); });
  const localPort = await listen(upstream);
  const reservation = createServer(); const port = await listen(reservation); await new Promise<void>(r => reservation.close(() => r()));
  const config: RemoteConfig = { enabled: true, port: 43180, origin: 'https://mac.tail123.ts.net', login: 'owner@example.com', previews: [{ id: 'site', project: '/tmp', label: 'Site', localPort, url: 'https://mac.tail123.ts.net:8443', managed: true, localHost: '127.0.0.1' }] };
  const gateway = await startPreviewGateway({ port, getConfig: () => config, verifyTarget }); cleanup.push(() => gateway.close());
  const headers = { host: 'mac.tail123.ts.net:8443', 'tailscale-user-login': config.login };
  const fetch = (extra: OutgoingHttpHeaders = {}, path = '/', body = '') => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers: { ...headers, ...extra } }, res => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data })); }); req.on('error', reject); req.end(body);
  });
  return { port, upstream, localPort, config, headers, fetch, received: () => received };
}
it('streams requests and sanitizes private identity, credentials and upstream host', async () => {
  const s = await setup(); const response = await s.fetch({ origin: s.config.previews[0]!.url, authorization: 'Bearer private', cookie: 'fleet=secret', 'x-forwarded-for': 'secret', 'tailscale-user-name': 'private' }, '/', 'hello');
  expect(response).toMatchObject({ status: 200, body: 'hello' });
  expect(s.received()).toMatchObject({ host: `localhost:${s.localPort}`, origin: `http://localhost:${s.localPort}` });
  for (const name of ['authorization', 'cookie', 'x-forwarded-for', 'tailscale-user-login', 'tailscale-user-name']) expect(s.received()[name]).toBeUndefined();
  expect((await s.fetch({}, '/redirect')).headers.location).toBe(s.config.previews[0]!.url + '/next?q=1');
});
it('rejects foreign origins, absent identity, duplicate identity, unmanaged routes and disabled access', async () => {
  const s = await setup();
  for (const headers of [{ origin: 'https://evil.example' }, { 'tailscale-user-login': '' }, { 'tailscale-user-login': [s.config.login, s.config.login] }, { host: 'mac.tail123.ts.net' }]) expect((await s.fetch(headers)).status).toBe(403);
  s.config.previews[0]!.managed = undefined; expect((await s.fetch()).status).toBe(403);
  s.config.previews[0]!.managed = true; s.config.enabled = false; expect((await s.fetch()).status).toBe(403);
});
it('fails closed on target ownership changes and verifier errors', async () => {
  let owns = true; const s = await setup(async () => { if (!owns) throw new Error('wrong project'); return true; });
  expect((await s.fetch()).status).toBe(200); owns = false; expect((await s.fetch()).status).toBe(502);
});
it('proxies Vite websocket protocols and messages with sanitized headers', async () => {
  const s = await setup(); const wsServer = new WebSocketServer({ server: s.upstream });
  wsServer.on('connection', (socket, req) => { expect(req.headers['tailscale-user-login']).toBeUndefined(); socket.on('message', data => socket.send(data)); });
  const client = new WebSocket(`ws://127.0.0.1:${s.port}/hmr`, 'vite-hmr', { headers: s.headers, origin: s.config.previews[0]!.url });
  cleanup.push(async () => { client.terminate(); wsServer.clients.forEach(ws => ws.terminate()); await new Promise<void>(r => wsServer.close(() => r())); });
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  expect(client.protocol).toBe('vite-hmr');
  const message = new Promise<string>(r => client.once('message', data => r(data.toString()))); client.send('update'); expect(await message).toBe('update');
});
it('revokes existing websocket connections when their route is removed', async () => {
  const s = await setup(); const wsServer = new WebSocketServer({ server: s.upstream });
  const client = new WebSocket(`ws://127.0.0.1:${s.port}/hmr`, { headers: s.headers, origin: s.config.previews[0]!.url });
  cleanup.push(async () => { client.terminate(); wsServer.clients.forEach(ws => ws.terminate()); await new Promise<void>(r => wsServer.close(() => r())); });
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const ended = new Promise<void>(r => client.once('close', () => r())); s.config.previews = []; await ended;
});
it('rechecks configuration after a pending ownership check and coalesces simultaneous requests', async () => {
  let finish!: (value: boolean) => void; let checks = 0;
  const s = await setup(() => { checks++; return new Promise<boolean>(resolve => { finish = resolve; }); });
  const first = s.fetch(); const second = s.fetch();
  await new Promise<void>(resolve => { const poll = setInterval(() => { if (checks) { clearInterval(poll); resolve(); } }, 5); });
  await new Promise(resolve => setTimeout(resolve, 20));
  s.config.previews = []; finish(true);
  expect((await first).status).toBe(403); expect((await second).status).toBe(403); expect(checks).toBe(1);
});
it('rejects absolute request targets and duplicate origins', async () => {
  const s = await setup();
  expect((await s.fetch({}, 'http://localhost/')).status).toBe(403);
  expect((await s.fetch({ Origin: [s.config.previews[0]!.url, s.config.previews[0]!.url] })).status).toBe(403);
});
it('does not upgrade websockets from a foreign origin', async () => {
  const s = await setup(); const client = new WebSocket(`ws://127.0.0.1:${s.port}/hmr`, { headers: s.headers, origin: 'https://evil.example' });
  const status = await new Promise<number>((resolve, reject) => { client.once('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); client.terminate(); }); client.on('error', () => {}); client.once('open', () => reject(new Error('Unexpected upgrade'))); });
  expect(status).toBe(403);
});

it('requires Origin on websocket upgrades', async () => {
  const s = await setup(); const client = new WebSocket(`ws://127.0.0.1:${s.port}/hmr`, { headers: s.headers });
  const status = await new Promise<number>(resolve => { client.once('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); client.terminate(); }); client.on('error', () => {}); });
  expect(status).toBe(403);
});
it('accepts cross-site top-level navigation but rejects cross-site subresources and originless writes', async () => {
  const s = await setup();
  expect((await s.fetch({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status).toBe(200);
  expect((await s.fetch({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })).status).toBe(403);
  expect((await s.fetch({}, '/', 'write')).status).toBe(403);
});
it('rejects occupied listen ports and shuts down idle websocket connections idempotently', async () => {
  const s = await setup();
  await expect(startPreviewGateway({ port: s.port, getConfig: () => s.config })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  const spare = createServer(); const port = await listen(spare); await new Promise<void>(r => spare.close(() => r()));
  const gateway = await startPreviewGateway({ port, getConfig: () => s.config, verifyTarget: async () => true });
  const wsServer = new WebSocketServer({ server: s.upstream });
  const client = new WebSocket(`ws://127.0.0.1:${port}/hmr`, { headers: s.headers, origin: s.config.previews[0]!.url });
  cleanup.push(async () => { client.terminate(); wsServer.clients.forEach(ws => ws.terminate()); await new Promise<void>(r => wsServer.close(() => r())); await gateway.close(); });
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const ended = new Promise<void>(r => client.once('close', () => r()));
  await gateway.close(); await ended; await gateway.close();
});
