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
