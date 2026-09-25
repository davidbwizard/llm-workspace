import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer, responseForCodexPrompt, viewCodexRequest } from '../../src/main/codexAppServer.ts';

const command = {
  id: 42,
  method: 'item/commandExecution/requestApproval',
  params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
    command: 'npm test', cwd: '/repo', reason: 'Run the tests' },
};

describe('Codex app-server prompts', () => {
  it('keeps the exact request identity and only accepts decisions for that request', () => {
    const prompt = viewCodexRequest(command, 'thread-1');
    expect(prompt).toMatchObject({ key: 'number:42', kind: 'command', command: 'npm test' });
    expect(responseForCodexPrompt(command, 'accept')).toEqual({ decision: 'accept' });
    expect(responseForCodexPrompt(command, 'made-up')).toBeNull();
    expect(viewCodexRequest(command, 'other-thread')).toBeNull();
  });

  it('grants only the permissions Codex requested and can deny them', () => {
    const request = {
      id: 'permission-1', method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-2', cwd: '/repo',
        permissions: { network: { enabled: true } } },
    };
    expect(responseForCodexPrompt(request, 'grantTurn'))
      .toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(responseForCodexPrompt(request, 'deny')).toEqual({ permissions: {}, scope: 'turn' });
    expect(responseForCodexPrompt(request, 'accept')).toBeNull();
  });

  it('requires one valid answer for each question', () => {
    const request = {
      id: 3, method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-3', isBlocking: true,
        questions: [
          { id: 'scope', header: 'Scope', question: 'Which?', options: [
            { label: 'One', description: 'One file' }, { label: 'All', description: 'Every file' },
          ] },
          { id: 'reason', header: 'Reason', question: 'Why?', options: null },
        ] },
    };
    expect(responseForCodexPrompt(request, { scope: 'All', reason: 'Needed' })).toEqual({
      answers: { scope: { answers: ['All'] }, reason: { answers: ['Needed'] } },
    });
    expect(responseForCodexPrompt(request, { scope: 'Other', reason: 'Needed' })).toBeNull();
    expect(responseForCodexPrompt(request, { scope: 'One' })).toBeNull();
    expect(responseForCodexPrompt(request, { scope: 'One', reason: 'line\nenter' })).toBeNull();
  });

  it('subscribes over the Unix WebSocket and resolves the exact live request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-codex-test-'));
    const path = join(dir, 'server.sock');
    const replies: unknown[] = [];
    let send: (value: unknown) => void = () => {};
    const server = createServer(socket => {
      let bytes = Buffer.alloc(0);
      let upgraded = false;
      send = value => {
        const payload = Buffer.from(JSON.stringify(value));
        const prefix = payload.length < 126 ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
        socket.write(Buffer.concat([prefix, payload]));
      };
      socket.on('data', chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (!upgraded) {
          const end = bytes.indexOf('\r\n\r\n');
          if (end < 0) return;
          const header = bytes.subarray(0, end).toString();
          const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(header)?.[1];
          if (!key) throw new Error('No WebSocket key');
          const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          bytes = bytes.subarray(end + 4);
          upgraded = true;
        }
        while (bytes.length >= 6) {
          let length = bytes[1]! & 127;
          let offset = 2;
          if (length === 126) { if (bytes.length < 8) return; length = bytes.readUInt16BE(2); offset = 4; }
          if (bytes.length < offset + 4 + length) return;
          const mask = bytes.subarray(offset, offset + 4);
          const payload = Buffer.from(bytes.subarray(offset + 4, offset + 4 + length));
          for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
          bytes = bytes.subarray(offset + 4 + length);
          const message = JSON.parse(payload.toString()) as { id?: number; method?: string; result?: unknown };
          if (message.method === 'initialize') send({ id: 1, result: { userAgent: 'fake' } });
          else if (message.method === 'thread/resume') send({ id: 2, result: { thread: { id: 'thread-1' } } });
          else if (message.id === 42) {
            replies.push(message.result);
            send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 42 } });
          }
        }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    const bridge = new CodexAppServer(path);
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      send(command);
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
      expect(bridge.answer('other-thread', 'number:42', 'accept')).toEqual({ status: 'refused', reason: 'stale' });
      expect(bridge.answer('thread-1', 'number:42', 'accept')).toEqual({ status: 'sent' });
      await vi.waitFor(() => expect(replies).toEqual([{ decision: 'accept' }]));
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0));
    } finally {
      bridge.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
