import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function serverFrame(payload: Buffer, first = 0x81): Buffer {
  const prefix = payload.length < 126 ? 2 : payload.length <= 65535 ? 4 : 10;
  const header = Buffer.alloc(prefix);
  header[0] = first;
  header[1] = prefix === 2 ? payload.length : prefix === 4 ? 126 : 127;
  if (prefix === 4) header.writeUInt16BE(payload.length, 2);
  if (prefix === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}
/** Disposable fake daemon. Pending callbacks belong to the daemon, not a connection. */
export async function promptDaemon(opts: { handshake?: (accept: string) => string; holdAnswers?: boolean; items?: Record<string, unknown>[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-codex-replay-'));
  const path = join(dir, 'daemon.sock');
  const connections: Socket[] = [];
  const pending = new Map<string | number, Record<string, unknown>>();
  const replies: Record<string, unknown>[] = [];
  const methods: Record<string, unknown>[] = [];
  const sendTo = (socket: Socket, value: unknown) => socket.write(serverFrame(Buffer.from(JSON.stringify(value))));
  const server = createServer(socket => {
    connections.push(socket);
    let bytes = Buffer.alloc(0);
    let upgraded = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!upgraded) {
        const end = bytes.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(bytes.subarray(0, end).toString())?.[1];
        if (!key) throw new Error('Missing handshake key');
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(opts.handshake?.(accept) ?? `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        bytes = bytes.subarray(end + 4);
        upgraded = true;
      }
      while (bytes.length >= 6) {
        let length = bytes[1]! & 127;
        let offset = 2;
        if (length === 126) { if (bytes.length < 8) return; length = bytes.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (bytes.length < 14) return; length = Number(bytes.readBigUInt64BE(2)); offset = 10; }
        if (bytes.length < offset + 4 + length) return;
        const opcode = bytes[0]! & 15;
        const mask = bytes.subarray(offset, offset + 4);
        const payload = Buffer.from(bytes.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
        bytes = bytes.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString()) as Record<string, unknown>;
        if (message.method) methods.push(message);
        if (message.method === 'initialize') sendTo(socket, { id: message.id, result: {} });
        if (message.method === 'thread/resume') {
          const params = message.params as { threadId: string };
          sendTo(socket, { id: message.id, result: { thread: { id: params.threadId } } });
          for (const request of pending.values()) {
            if ((request.params as { threadId: string }).threadId === params.threadId) sendTo(socket, request);
          }
        }
        if (message.method === 'thread/items/list') sendTo(socket, { id: message.id, result: { data: opts.items ?? [], nextCursor: null, backwardsCursor: null } });
        if (Object.hasOwn(message, 'result')) {
          replies.push(message);
          if (!opts.holdAnswers) {
            const request = pending.get(message.id as string | number);
            if (request) {
              pending.delete(message.id as string | number);
              sendTo(socket, { method: 'serverRequest/resolved', params: {
                threadId: (request.params as { threadId: string }).threadId, requestId: message.id,
              } });
            }
          }
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { path, pending, replies, methods, connections,
    send(value: unknown) { sendTo(connections[connections.length - 1]!, value); },
    raw(bytes: Buffer) { connections[connections.length - 1]!.write(bytes); },
    disconnect() { connections[connections.length - 1]?.destroy(); },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
