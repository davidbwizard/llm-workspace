import { afterEach, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startRemoteServer, type RemoteServices } from '../../src/main/remote/server.ts';
import { createStager } from '../../src/main/staging.ts';
import { SessionOperations } from '../../src/main/sessionOperations.ts';
import { TerminalClients } from '../../src/main/terminalClients.ts';
const config = { enabled: true, port: 43189, origin: 'https://mac.tail123.ts.net', login: 'owner@example.com', previews: [] };
let service: Awaited<ReturnType<typeof startRemoteServer>>;
let dir: string;
afterEach(async () => { await service?.close(); if (dir) rmSync(dir, { recursive: true }); });
let terminalEmit: ((event: string, payload: unknown) => void) | undefined;
async function start(withTerminal = false, openPreview?: RemoteServices['openPreview']) {
  dir = mkdtempSync(join(tmpdir(), 'fleet-remote-')); writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Fleet</title>');
  const operations = new SessionOperations({ list: () => withTerminal ? [{ pid: 10, sessionId: 's', provider: 'codex', cwd: '/tmp' }] : [], identity: () => withTerminal ? { pid: 10, sessionId: 's', provider: 'codex', started: 'start', tmux: 'owned' } : null, projects: () => [], conversation: () => null, live: () => null, send: async (_pid, _text, _sid, _client, images) => ({ status: 'sent', images }), images: createStager(join(dir, 'images')), close: async () => ({ status: 'killed' }), answerClaude: () => null, answerCodex: () => null, launch: () => null });
  const terminals = new TerminalClients({ identity: () => 'owned', attach: async (_client, _pid, _cols, _rows, emit) => { terminalEmit = emit; return { status: 'attached' }; }, detach() {}, resize() {}, size() {}, input() {}, busy: () => false });
  service = await startRemoteServer(config, { operations, terminals, assets: dir, watch: () => true, release() {}, openPreview });
}
function get(path: string, extra: Record<string, string> = {}, method = 'GET', bytes?: Buffer) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ agent: false, hostname: '127.0.0.1', port: config.port, path, method, headers: { Host: new URL(config.origin).host, 'Tailscale-User-Login': config.login, ...extra } }, res => { let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode!, body })); }); req.on('error', reject); req.end(bytes);
  });
}
it('serves authenticated assets and rejects foreign origins, methods and traversal', async () => {
  await start(); expect((await get('/')).status).toBe(200);
  expect((await get('/api/bootstrap', { 'Tailscale-User-Login': 'other' })).status).toBe(403);
  expect((await get('/api/bootstrap', { Origin: config.origin + ':8443' })).status).toBe(403);
  expect((await get('/api/bootstrap', {}, 'POST')).status).toBe(405);
  expect((await get('/%2e%2e/package.json')).status).toBe(404);
});
it('requires a ticket before app messages and binds generation before dispatch', async () => {
  await start(); const boot = JSON.parse((await get('/api/bootstrap')).body);
  const ws = new WebSocket('ws://127.0.0.1:' + config.port + '/socket', { headers: { Host: new URL(config.origin).host, Origin: config.origin, 'Tailscale-User-Login': config.login } });
  const next = () => new Promise<any>(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))));
  await new Promise(resolve => ws.once('open', resolve));
  let result = next(); ws.send(JSON.stringify({ v: 1, op: 'authenticate', ticket: boot.ticket, generation: boot.generation }));
  const ready = await result; expect(ready.event).toBe('ready');
  result = next(); ws.send(JSON.stringify({ v: 1, id: 'r1', op: 'list', client: ready.client, generation: 'wrong', payload: {} }));
  expect((await result).result).toEqual({ ok: false, reason: 'stale' });
  result = next(); ws.send(JSON.stringify({ v: 1, id: 'r2', op: 'list', client: ready.client, generation: boot.generation, payload: {} }));
  expect((await result).result).toEqual({ ok: true, value: [] }); ws.close();
});
it('closes unauthenticated and oversized websocket frames without dispatching', async () => {
  await start();
  async function socket() {
    const ws = new WebSocket('ws://127.0.0.1:' + config.port + '/socket', { headers: { Host: new URL(config.origin).host, Origin: config.origin, 'Tailscale-User-Login': config.login } });
    await new Promise(resolve => ws.once('open', resolve)); return ws;
  }
  const unauth = await socket(); const closed = new Promise(resolve => unauth.once('close', resolve));
  unauth.send(JSON.stringify({ v: 1, op: 'list' })); await closed;
  const boot = JSON.parse((await get('/api/bootstrap')).body); const large = await socket();
  const ready = new Promise(resolve => large.once('message', resolve));
  large.send(JSON.stringify({ v: 1, op: 'authenticate', ticket: boot.ticket, generation: boot.generation })); await ready;
  const rejected = new Promise<number>(resolve => large.once('close', code => resolve(code)));
  large.send('x'.repeat(65537)); expect(await rejected).toBe(1009);
});
it('limits bootstrap requests and leaves no listener after shutdown', async () => {
  await start();
  let status = 0; for (let n = 0; n < 241; n++) status = (await get('/api/bootstrap')).status;
  expect(status).toBe(429); await service.close();
  await expect(get('/')).rejects.toThrow();
});

it('requires terminal consumption acknowledgments and disconnects only the slow viewer', async () => {
  await start(true);
  const boot = JSON.parse((await get('/api/bootstrap')).body);
  const ws = new WebSocket('ws://127.0.0.1:' + config.port + '/socket', { headers: { Host: new URL(config.origin).host, Origin: config.origin, 'Tailscale-User-Login': config.login } });
  const next = () => new Promise<any>(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))));
  await new Promise(resolve => ws.once('open', resolve));
  let response = next(); ws.send(JSON.stringify({ v: 1, op: 'authenticate', ticket: boot.ticket, generation: boot.generation })); const ready = await response;
  let counter = 0;
  async function call(op: string, payload: unknown) { const result = next(); ws.send(JSON.stringify({ v: 1, id: 'req' + ++counter, op, payload, client: ready.client, generation: boot.generation })); return result; }
  const list = await call('list', {}); const handle = list.result.value[0].handle;
  // attach emits the owner event before its response; consume both.
  const attached = new Promise<void>(resolve => { const listener = (data: Buffer) => { if (JSON.parse(data.toString()).id) { ws.off('message', listener); resolve(); } }; ws.on('message', listener); });
  ws.send(JSON.stringify({ v: 1, id: 'attach', op: 'terminal:attach', payload: { handle, cols: 80, rows: 24 }, client: ready.client, generation: boot.generation })); await attached;
  response = next(); terminalEmit!('terminal:data', { pid: 10, seq: 0, data: 'first' }); const chunk = await response;
  expect(chunk.payload.delivery).toBeTypeOf('string');
  expect((await call('terminal:ack', { delivery: chunk.payload.delivery })).result.ok).toBe(true);
  const closed = new Promise(resolve => ws.once('close', resolve));
  for (let n = 0; n < 3; n++) {
    response = next(); terminalEmit!('terminal:data', { pid: 10, seq: n + 1, data: 'x'.repeat(256 * 1024) });
    await response; // Network is drained, but xterm consumption is deliberately not acknowledged.
  }
  terminalEmit!('terminal:data', { pid: 10, seq: 4, data: 'x'.repeat(256 * 1024) });
  await closed;
  expect((await get('/')).status).toBe(200);
});

it('reserves action capacity and permits cleanup after the read budget is exhausted', async () => {
  await start(); const boot = JSON.parse((await get('/api/bootstrap')).body);
  const ws = new WebSocket('ws://127.0.0.1:' + config.port + '/socket', { headers: { Host: new URL(config.origin).host, Origin: config.origin, 'Tailscale-User-Login': config.login } });
  const next = () => new Promise<any>(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))));
  await new Promise(resolve => ws.once('open', resolve));
  let response = next(); ws.send(JSON.stringify({ v: 1, op: 'authenticate', ticket: boot.ticket, generation: boot.generation })); const ready = await response;
  let counter = 0;
  async function call(op: string, payload: unknown) { const result = next(); ws.send(JSON.stringify({ v: 1, id: 'req' + ++counter, op, payload, client: ready.client, generation: boot.generation })); return result; }
  let last: any; for (let i = 0; i < 91; i++) last = await call('list', {});
  expect(last.result).toMatchObject({ ok: false, reason: 'busy' });
  expect((await call('send', { handle: 'old', text: 'hello' })).result).toMatchObject({ ok: false, reason: 'stale' });
  expect((await call('watch', { handle: null })).result.ok).toBe(true);
  expect((await call('terminal:detach', { handle: 'old' })).result.ok).toBe(true); ws.close();
});

async function client() {
  const boot = JSON.parse((await get('/api/bootstrap')).body);
  const ws = new WebSocket('ws://127.0.0.1:' + config.port + '/socket', { headers: { Host: new URL(config.origin).host, Origin: config.origin, 'Tailscale-User-Login': config.login } });
  const next = () => new Promise<any>(resolve => ws.once('message', d => resolve(JSON.parse(d.toString()))));
  await new Promise(resolve => ws.once('open', resolve));
  const response = next(); ws.send(JSON.stringify({ v: 1, op: 'authenticate', ticket: boot.ticket, generation: boot.generation })); const ready = await response;
  let n = 0;
  return { ws, call: async (op: string, payload: unknown = {}) => { const result = next(); ws.send(JSON.stringify({ v: 1, id: 'r' + ++n, op, payload, client: ready.client, generation: boot.generation })); return (await result).result; } };
}
it('prepares a website on the authenticated phone connection and rejects extra authority fields', async () => {
  const calls: unknown[] = [];
  await start(true, async (handle, url) => { calls.push([handle, url]); return { ok: true, url: 'https://mac.tail123.ts.net:8444/game' }; });
  const phone = await client(); const handle = (await phone.call('list')).value[0].handle;
  expect(await phone.call('preview:open', { handle, url: 'http://localhost:5199/game', project: '/other' })).toEqual({ ok: false, reason: 'invalid' });
  expect(calls).toHaveLength(0);
  expect(await phone.call('preview:open', { handle, url: 'http://localhost:5199/game' })).toEqual({ ok: true, value: { ok: true, url: 'https://mac.tail123.ts.net:8444/game' } });
  expect(calls).toEqual([[handle, 'http://localhost:5199/game']]);
  expect((await phone.call('list')).value[0].handle).toBe(handle);
  phone.ws.close();
});
it('uploads validated image bytes using a one-use origin-bound ticket and sends only owned IDs', async () => {
  await start(true); const phone = await client(); const tablet = await client();
  const handle = (await phone.call('list')).value[0].handle;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXYAAAAASUVORK5CYII=', 'base64');
  const ticket = (await phone.call('image:prepare', { handle })).value.ticket;
  expect((await get('/api/images', { 'X-Fleet-Upload-Ticket': ticket }, 'POST', png)).status).toBe(403);
  const headers = { Origin: config.origin, 'X-Fleet-Upload-Ticket': ticket };
  const upload = await get('/api/images', headers, 'POST', png);
  const result = JSON.parse(upload.body); expect(result.ok).toBe(true); const id = result.value.id;
  expect((await get('/api/images', headers, 'POST', png)).status).toBe(403);
  expect(await tablet.call('send', { handle, text: '', images: [id] })).toMatchObject({ ok: false, reason: 'invalid' });
  expect(await phone.call('send', { handle, text: '', images: [id] })).toMatchObject({ ok: true, value: { status: 'sent', images: [id] } });
  const badTicket = (await phone.call('image:prepare', { handle })).value.ticket;
  expect(JSON.parse((await get('/api/images', { Origin: config.origin, 'X-Fleet-Upload-Ticket': badTicket }, 'POST', Buffer.from('not an image'))).body)).toMatchObject({ ok: false, reason: 'invalid' });
  const largeTicket = (await phone.call('image:prepare', { handle })).value.ticket;
  expect((await get('/api/images', { Origin: config.origin, 'X-Fleet-Upload-Ticket': largeTicket, 'Content-Length': String(10 * 1024 * 1024 + 1) }, 'POST')).status).toBe(413);
  expect(await phone.call('close', { handle })).toMatchObject({ ok: true, value: { status: 'killed' } });
  phone.ws.close(); tablet.ws.close();
});
it('revokes outstanding upload tickets when their device disconnects', async () => {
  await start(true); const phone = await client(); const handle = (await phone.call('list')).value[0].handle;
  const ticket = (await phone.call('image:prepare', { handle })).value.ticket;
  const closed = new Promise(resolve => phone.ws.once('close', resolve)); phone.ws.close(); await closed;
  expect((await get('/api/images', { Origin: config.origin, 'X-Fleet-Upload-Ticket': ticket }, 'POST', Buffer.from('image'))).status).toBe(403);
});
