import { expect, it, vi } from 'vitest';
import { MobileConnection } from '../../src/renderer/mobile/connection.ts';
class Socket {
  readyState = 1; sent: any[] = []; onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.onclose?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
it('marks lost mutations uncertain and never resends them after reconnect', async () => {
  const sockets: Socket[] = [];
  const client = new MobileConnection('https://mac.tail.ts.net', { bootstrap: async () => ({ generation: 'g', ticket: 't' }), socket: () => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; } });
  await client.connect(); const first = sockets[0]!; first.onopen?.(); first.receive({ event: 'ready', generation: 'g', client: 'c1' });
  const pending = client.request('send', { handle: 'h', text: 'hello' }); first.close();
  expect(await pending).toEqual({ ok: false, reason: 'uncertain' });
  await client.connect(); const second = sockets[1]!; second.onopen?.(); second.receive({ event: 'ready', generation: 'g', client: 'c2' });
  expect(second.sent.map(p => p.op)).toEqual(['authenticate']);
  const listener = vi.fn(); client.onEvent(listener); first.receive({ event: 'session:live', client: 'c1', generation: 'g', payload: {} });
  expect(listener).not.toHaveBeenCalled(); client.close();
});
it('serializes upload and send across session views and stops before sending after reconnect', async () => {
  const client = new MobileConnection('https://mac.tail.ts.net');
  let finish!: (value: any) => void;
  const upload = vi.spyOn(client, 'uploadImage').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, value: { status: 'sent' } });
  const first = client.sendReply('first-session', '', [new File(['image'], 'image.png')]);
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(await client.sendReply('second-session', 'hello', [])).toMatchObject({ ok: false, reason: 'busy' });
  expect(request.mock.calls.filter(c => c[0] === 'image:clear')).toHaveLength(1);
  client.close(); finish({ ok: true, value: { id: 'old-connection-image' } });
  expect(await first).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(request.mock.calls.filter(c => c[0] === 'send')).toHaveLength(0);
  expect(await client.sendReply('second-session', 'hello', [])).toMatchObject({ ok: true });
});
it.each(['disconnect', 'timeout'] as const)('marks preview setup %s uncertain and never repeats setup on reconnect', async failure => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const client = new MobileConnection('https://mac.tail.ts.net', { bootstrap: async () => ({ generation: 'g', ticket: 't' }), socket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; } });
  try {
    await client.connect(); const first = sockets[0]!; first.onopen?.(); first.receive({ event: 'ready', generation: 'g', client: 'c1' });
    const pending = client.request('preview:open', { handle: 'h', url: 'http://localhost:3000/path' });
    expect(first.sent.filter(request => request.op === 'preview:open')).toHaveLength(1);
    if (failure === 'disconnect') first.close(); else await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ ok: false, reason: 'uncertain' });
    await client.connect(); const second = sockets[1]!; second.onopen?.(); second.receive({ event: 'ready', generation: 'g', client: 'c2' });
    expect(second.sent.map(request => request.op)).toEqual(['authenticate']);
  } finally { client.close(); vi.useRealTimers(); }
});
