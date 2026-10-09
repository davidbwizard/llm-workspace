import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexAppServer, responseForCodexPrompt, setCodexThreadName, viewCodexRequest,
} from '../../src/main/codexAppServer.ts';

import { promptDaemon, serverFrame } from '../helpers/codexServer.ts';

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

  it('preserves exact offered labels for nonblocking questions', () => {
    const request = { id: 9, method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'question', isBlocking: false,
      questions: [{ id: 'q', question: 'Choose', options: [{ label: '  Exact  ', description: '' }] }],
    } };
    expect(viewCodexRequest(request, 'thread-1')).toMatchObject({ isBlocking: false });
    expect(responseForCodexPrompt(request, { q: '  Exact  ' }))
      .toEqual({ answers: { q: { answers: ['  Exact  '] } } });
    expect(responseForCodexPrompt(request, { q: 'Exact' })).toBeNull();
  });

  it('omits null optional permission grant fields', () => {
    const request = { ...command, method: 'item/permissions/requestApproval', params: {
      ...command.params, permissions: { network: { enabled: true }, fileSystem: null },
    } };
    expect(responseForCodexPrompt(request, 'grantSession'))
      .toEqual({ permissions: { network: { enabled: true } }, scope: 'session' });
    expect(responseForCodexPrompt(request, { permissions: { network: { enabled: true } } })).toBeNull();
  });

  it('retains offered structured command decisions in main', () => {
    const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } };
    const request = { ...command, params: { ...command.params,
      additionalPermissions: { network: { enabled: true }, fileSystem: null },
      availableDecisions: ['decline', amendment],
    } };
    const prompt = viewCodexRequest(request, 'thread-1')!;
    expect(prompt.actions).toHaveLength(2);
    const action = prompt.actions![1]!;
    expect(action.label).toContain('npm');
    expect(responseForCodexPrompt(request, action.id)).toEqual({ decision: amendment });
    expect(responseForCodexPrompt(request, 'accept')).toBeNull();
    expect(responseForCodexPrompt(request, amendment)).toBeNull();
    expect(prompt.details).toContain('network');
  });

  it('marks bounded command and structured action previews as truncated', () => {
    const long = 'x'.repeat(13000);
    const request = { ...command, params: { ...command.params, command: long,
      availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: [long] } }],
    } };
    const prompt = viewCodexRequest(request, 'thread-1')!;
    expect(prompt.command).toMatch(/Preview truncated.*Open Terminal/);
    expect(prompt.actions![0]!.label).toMatch(/Preview truncated.*Open Terminal/);
  });

  const elicitation = (schema: unknown, meta: unknown = null, mode = 'form') => ({
    id: 'mcp-1', method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread-1', turnId: null, serverName: 'sample', mode,
      message: 'Approve the tool', requestedSchema: schema, _meta: meta,
    },
  });

  it.each(['form', 'openai/form', 'openaiForm'])('answers message-only %s MCP approvals with only offered session persistence', mode => {
    const request = elicitation({ type: 'object', properties: {} }, { persist: ['session'] }, mode);
    expect(viewCodexRequest(request, 'thread-1')).toMatchObject({ kind: 'elicitation', itemId: null, turnId: null });
    expect(responseForCodexPrompt(request, { action: 'accept' }))
      .toEqual({ action: 'accept', content: null, _meta: null });
    expect(responseForCodexPrompt(request, { action: 'acceptForSession' }))
      .toEqual({ action: 'accept', content: null, _meta: { persist: 'session' } });
    expect(responseForCodexPrompt(request, { action: 'decline' }))
      .toEqual({ action: 'decline', content: null, _meta: null });
    expect(responseForCodexPrompt(elicitation(null), { action: 'acceptForSession' })).toBeNull();
    expect(responseForCodexPrompt(request, { action: 'accept', _meta: { persist: 'always' } })).toBeNull();
  });

  it('validates required MCP primitive fields and constraints in main', () => {
    const request = elicitation({ type: 'object', properties: {
      name: { type: 'string', minLength: 2, maxLength: 5 },
      count: { type: 'integer', minimum: 1, maximum: 4 },
      enabled: { type: 'boolean' }, scope: { type: 'string', enum: ['one', 'all'] },
    }, required: ['name', 'count', 'enabled', 'scope'] });
    const content = { name: 'Alice', count: 2, enabled: false, scope: 'one' };
    expect(responseForCodexPrompt(request, { action: 'accept', content }))
      .toEqual({ action: 'accept', content, _meta: null });
    for (const bad of [{ ...content, name: 'A' }, { ...content, count: 1.5 },
      { ...content, enabled: 'true' }, { ...content, scope: 'injected' }, { ...content, extra: 'bad' },
      { name: 'Alice', count: 2 }]) {
      expect(responseForCodexPrompt(request, { action: 'accept', content: bad })).toBeNull();
    }
  });

  it('validates own fields for reserved property names without using inherited data', () => {
    const request = elicitation(JSON.parse('{"type":"object","properties":{"constructor":{"type":"string"},"__proto__":{"type":"boolean"}},"required":["constructor","__proto__"]}'));
    expect(responseForCodexPrompt(request, { action: 'accept', content: {} })).toBeNull();
    const content = JSON.parse('{"constructor":"chosen","__proto__":false}');
    expect(responseForCodexPrompt(request, { action: 'accept', content })).toEqual({ action: 'accept', content, _meta: null });
    const allowsEmpty = elicitation({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
    expect(responseForCodexPrompt(allowsEmpty, { action: 'accept', content: { text: '' } }))
      .toEqual({ action: 'accept', content: { text: '' }, _meta: null });
  });

  it('rejects non-object serialized content for an optional typed MCP form', () => {
    const request = elicitation({ type: 'object', properties: { optional: { type: 'string' } } });
    expect(responseForCodexPrompt(request, { action: 'accept', content: new Date('2026-01-01') })).toBeNull();
  });

  it.each([
    { mode: 'url', url: 'https://example.com/verify', message: 'Verify' },
    { mode: 'openai/userVerification', title: 'Verify', description: 'Native ceremony', challenge: 'secret' },
    { mode: 'form', requestedSchema: { type: 'object', properties: { unsupported: { type: 'array' } } } },
    { mode: 'form', requestedSchema: { type: 'object', properties: { code: { type: 'string', pattern: '[0-9]+' } } } },
  ])('keeps unsupported/native requests visible without accepting them: %j', params => {
    const request = { ...elicitation(null), params: { ...elicitation(null).params, ...params } };
    const prompt = viewCodexRequest(request, 'thread-1');
    expect(prompt).toMatchObject({ kind: 'fallback' });
    expect(prompt?.fallback).toMatch(/Terminal/);
    expect(JSON.stringify(prompt)).not.toContain('challenge');
    expect(responseForCodexPrompt(request, { action: 'accept' })).toBeNull();
  });

  // Review finding 4: an absent or dead app-server was completely silent.
  // The close handler only spoke when the connection had already reached
  // 'ready', so the two cases that matter said nothing -- a daemon that was
  // never running (state 'connecting'), and one that died, which closes
  // with no error argument at all. Meanwhile it reconnected every 5s
  // forever, rebuilding and pushing the whole session-live payload twice
  // per cycle.
  it('reports an unreachable app-server once per outage, not once per retry', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(m => { errors.push(String(m)); });
    let pushes = 0;
    const missing = join(tmpdir(), `fleet-codex-absent-${Date.now()}.sock`);
    const bridge = new CodexAppServer(missing, { retryMs: 10 });
    try {
      bridge.watch('thread-1', () => { pushes++; });
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
      const afterFirst = pushes;
      // Long enough for many more retries at 10ms.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(missing);
      expect(errors[0]).toContain('will not reach the conversation');
      // Every later retry fails to the state it is already in, so nothing
      // is pushed: no payload rebuild, no IPC, indefinitely.
      expect(pushes).toBe(afterFirst);
    } finally {
      bridge.stop();
      spy.mockRestore();
    }
  });

  it('gives up on a socket that accepts the connection but never upgrades', async () => {
    // A server that answers TCP and then says nothing left the bridge in
    // 'connecting' with no retry scheduled and nothing logged -- where a
    // changed initialize contract would land.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(m => { errors.push(String(m)); });
    const dir = mkdtempSync(join(tmpdir(), 'fleet-codex-mute-'));
    const path = join(dir, 'mute.sock');
    const accepted: import('node:net').Socket[] = [];
    const server = createServer(socket => { accepted.push(socket); /* accept, then never reply */ });
    await new Promise<void>(resolve => server.listen(path, resolve));
    const bridge = new CodexAppServer(path, { retryMs: 10_000, handshakeMs: 30 });
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 2000 });
      expect(errors[0]).toContain('handshake');
      expect(bridge.snapshot('thread-1')?.state).not.toBe('ready');
    } finally {
      bridge.stop();
      spy.mockRestore();
      // close() alone waits for live connections, and this server's whole
      // point is that it never finishes one.
      for (const socket of accepted) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('subscribes over the Unix WebSocket and resolves requests whose ids overlap setup calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-codex-test-'));
    const path = join(dir, 'server.sock');
    const replies: unknown[] = [];
    let resumes = 0;
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
          else if (message.method === 'thread/resume') {
            resumes++;
            send({ id: 2, result: { thread: { id: 'thread-1' } } });
          } else if (message.id === 42 || message.id === 1 || message.id === 2) {
            replies.push(message.result);
            send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: message.id } });
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
      expect(bridge.answer('thread-1', bridge.snapshot('thread-1')!.prompts[0]!.key, 'accept')).toEqual({ status: 'sent' });
      await vi.waitFor(() => expect(replies).toEqual([{ decision: 'accept' }]));
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0));
      for (const id of [1, 2]) {
        send({ ...command, id });
        await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
        expect(bridge.answer('thread-1', bridge.snapshot('thread-1')!.prompts[0]!.key, 'accept')).toEqual({ status: 'sent' });
        await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0));
      }
      expect(replies).toEqual([{ decision: 'accept' }, { decision: 'accept' }, { decision: 'accept' }]);
      expect(resumes).toBe(1);
    } finally {
      bridge.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Codex observer recovery', () => {
  it('replays pending prompts on initial subscription, reconnect and a fresh observer; old handles refuse reused IDs', async () => {
    const daemon = await promptDaemon();
    daemon.pending.set(42, command);
    let bridge = new CodexAppServer(daemon.path, { retryMs: 20 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
      const firstKey = bridge.snapshot('thread-1')!.prompts[0]!.key;
      daemon.disconnect();
      await vi.waitFor(() => expect(daemon.connections).toHaveLength(2));
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
      const key = bridge.snapshot('thread-1')!.prompts[0]!.key;
      expect(key).not.toBe(firstKey);
      expect(bridge.answer('thread-1', firstKey, 'accept')).toEqual({ status: 'refused', reason: 'stale' });
      bridge.stop();
      bridge = new CodexAppServer(daemon.path);
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
      const freshKey = bridge.snapshot('thread-1')!.prompts[0]!.key;
      expect(freshKey).not.toBe(key);
      expect(bridge.answer('thread-1', freshKey, 'accept')).toEqual({ status: 'sent' });
      await vi.waitFor(() => expect(daemon.replies).toMatchObject([{ id: 42, result: { decision: 'accept' } }]));
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0));
    } finally { bridge.stop(); await daemon.close(); errors.mockRestore(); }
  });

  it('does not resurrect an externally answered prompt after an outage', async () => {
    const daemon = await promptDaemon();
    daemon.pending.set(42, command);
    const bridge = new CodexAppServer(daemon.path, { retryMs: 60 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
      daemon.disconnect();
      daemon.pending.clear(); // Native TUI answered while observer was absent.
      await vi.waitFor(() => expect(daemon.connections).toHaveLength(2));
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0);
    } finally { bridge.stop(); await daemon.close(); errors.mockRestore(); }
  });

  it('does not reset sent requests on duplicate replay or include another thread', async () => {
    const daemon = await promptDaemon({ holdAnswers: true });
    const bridge = new CodexAppServer(daemon.path);
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      daemon.send(command);
      daemon.send({ ...command, id: 43, params: { ...command.params, threadId: 'child-thread' } });
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
      const key = bridge.snapshot('thread-1')!.prompts[0]!.key;
      expect(bridge.answer('thread-1', key, 'accept')).toEqual({ status: 'sent' });
      daemon.send(command);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(bridge.answer('thread-1', key, 'accept')).toEqual({ status: 'refused', reason: 'stale' });
      expect(daemon.replies).toHaveLength(1);
      daemon.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0));
    } finally { bridge.stop(); await daemon.close(); }
  });

  it('reads one bounded current-turn page for a replayed file approval and matches the exact item', async () => {
    const daemon = await promptDaemon({ items: [
      { turnId: 'other-turn', item: { type: 'fileChange', id: 'item-1', changes: [{ path: 'wrong', diff: 'wrong turn' }] } },
      { turnId: 'turn-1', item: { type: 'fileChange', id: 'item-1', changes: [{ path: 'a.ts', diff: '-before\n+after' }] } },
    ] });
    daemon.pending.set(42, { ...command, method: 'item/fileChange/requestApproval' });
    const bridge = new CodexAppServer(daemon.path);
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts[0]?.details ?? '').toContain('-before\n+after'));
      expect(daemon.methods.filter(m => m.method === 'thread/items/list')).toMatchObject([
        { params: { threadId: 'thread-1', turnId: 'turn-1', limit: 64, sortDirection: 'desc' } },
      ]);
      expect(bridge.snapshot('thread-1')!.prompts[0]!.details).not.toContain('wrong turn');
    } finally { bridge.stop(); await daemon.close(); }
  });

  it('releases completed-turn preview reads so a long subscription can hydrate subsequent approvals', async () => {
    const daemon = await promptDaemon();
    const bridge = new CodexAppServer(daemon.path);
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      for (let i = 0; i < 9; i++) {
        daemon.send({ ...command, method: 'item/fileChange/requestApproval', params: { ...command.params, turnId: `turn-${i}` } });
        await vi.waitFor(() => expect(daemon.methods.filter(m => m.method === 'thread/items/list')).toHaveLength(i + 1));
        daemon.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: `turn-${i}` } } });
        await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0));
      }
    } finally { bridge.stop(); await daemon.close(); }
  });

  it.each([
    Array.from({ length: 33 }, (_, i) => ({ path: `file-${i}.ts`, diff: '+new' })),
    [{ path: 'large.ts', diff: '+' + 'x'.repeat(13000) }],
  ].map(changes => [changes]))('marks truncated file previews so full approval scope is clear', async changes => {
    const daemon = await promptDaemon();
    const bridge = new CodexAppServer(daemon.path);
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      daemon.send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'fileChange', id: 'item-1', changes } } });
      daemon.send({ ...command, method: 'item/fileChange/requestApproval' });
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts[0]?.details ?? '').toMatch(/Preview truncated.*Open Terminal/));
    } finally { bridge.stop(); await daemon.close(); }
  });

  it('hydrates only the matching file item preview, including an event after the request', async () => {
    const daemon = await promptDaemon();
    const bridge = new CodexAppServer(daemon.path);
    const started = (id: string, diff: string) => ({ method: 'item/started', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: { type: 'fileChange', id,
        changes: [{ path: '/repo/a.ts', kind: { type: 'update', move_path: null }, diff }], status: 'inProgress' },
    } });
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      daemon.send(started('other-item', 'WRONG DIFF'));
      daemon.send({ ...command, method: 'item/fileChange/requestApproval' });
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(1));
      expect(bridge.snapshot('thread-1')!.prompts[0]!.details ?? '').not.toContain('WRONG DIFF');
      daemon.send(started('item-1', '-old\n+new'));
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')!.prompts[0]!.details ?? '').toContain('-old\n+new'));
    } finally { bridge.stop(); await daemon.close(); }
  });
});

describe('Codex local WebSocket validation', () => {
  it.each([
    ['RSV', serverFrame(Buffer.from('{}'), 0xc1)],
    ['orphan continuation', serverFrame(Buffer.from('{}'), 0x80)],
    ['fragmented control', serverFrame(Buffer.alloc(0), 0x09)],
    ['oversized control', serverFrame(Buffer.alloc(126), 0x89)],
    ['invalid UTF-8', serverFrame(Buffer.from([0x22, 0xff, 0x22]))],
    ['nested text fragment', Buffer.concat([serverFrame(Buffer.from('{"x":'), 0x01), serverFrame(Buffer.from('1}'))])],
    ['fragment aggregate overflow', Buffer.concat([serverFrame(Buffer.alloc(3 * 1024 * 1024, 32), 0x01),
      serverFrame(Buffer.alloc(2 * 1024 * 1024, 32), 0x00).subarray(0, 10)])],
  ])('closes on %s before accepting more requests', async (_name, frame) => {
    const daemon = await promptDaemon();
    const bridge = new CodexAppServer(daemon.path, { retryMs: 10_000 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      daemon.raw(frame as Buffer);
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('unavailable'), { timeout: 1000 });
      expect(bridge.snapshot('thread-1')?.prompts).toHaveLength(0);
    } finally { bridge.stop(); await daemon.close(); errors.mockRestore(); }
  });

  it('accepts exact handshake tokens and valid fragmented UTF-8 with interleaved ping', async () => {
    const daemon = await promptDaemon({ handshake: accept => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n` });
    const bridge = new CodexAppServer(daemon.path);
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('ready'));
      const request = Buffer.from(JSON.stringify({ ...command, params: { ...command.params, command: 'echo café' } }));
      const split = request.indexOf(Buffer.from('é')) + 1;
      daemon.raw(Buffer.concat([serverFrame(request.subarray(0, split), 0x01),
        serverFrame(Buffer.from('ping'), 0x89), serverFrame(request.subarray(split), 0x80)]));
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.prompts[0]?.command).toBe('echo café'));
    } finally { bridge.stop(); await daemon.close(); }
  });

  it('rejects a handshake accept-token suffix instead of using substring matching', async () => {
    const daemon = await promptDaemon({ handshake: accept => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}suffix\r\n\r\n` });
    const bridge = new CodexAppServer(daemon.path, { retryMs: 10_000 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      bridge.watch('thread-1', () => {});
      await vi.waitFor(() => expect(bridge.snapshot('thread-1')?.state).toBe('unavailable'));
      expect(daemon.methods).toHaveLength(0);
    } finally { bridge.stop(); await daemon.close(); errors.mockRestore(); }
  });
});

// Naming a Codex thread. Same protocol, same local Unix socket and the
// same minimal WebSocket client the subscription above uses -- the only
// write Fleet makes to the App Server besides answering a prompt the
// conversation actually raised.
describe('setCodexThreadName', () => {
  const THREAD = '01a0da0c-2964-76a2-bf2e-dbcbb26243df';

  /** A stand-in app-server on a Unix socket: completes the WebSocket
   *  upgrade, then hands each decoded client message to `handle`, which
   *  decides what (if anything) goes back. Returns the socket path and a
   *  teardown -- one fake for every case below, so no test depends on a
   *  real daemon being installed or running. */
  async function fakeServer(handle: (message: Record<string, unknown>, send: (value: unknown) => void) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-codex-name-'));
    const path = join(dir, 'server.sock');
    const live: import('node:net').Socket[] = [];
    const server = createServer(socket => {
      live.push(socket);
      let bytes = Buffer.alloc(0);
      let upgraded = false;
      const send = (value: unknown) => {
        const payload = Buffer.from(JSON.stringify(value));
        const prefix = payload.length < 126 ? Buffer.from([0x81, payload.length])
          : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
        socket.write(Buffer.concat([prefix, payload]));
      };
      socket.on('error', () => {});
      socket.on('data', chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (!upgraded) {
          const end = bytes.indexOf('\r\n\r\n');
          if (end < 0) return;
          const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(bytes.subarray(0, end).toString())?.[1];
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
          handle(JSON.parse(payload.toString()) as Record<string, unknown>, send);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    return { path, async close() {
      for (const socket of live) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    } };
  }

  it('initializes, then sets the name on exactly the thread it was given', async () => {
    const seen: Record<string, unknown>[] = [];
    const fake = await fakeServer((message, send) => {
      seen.push(message);
      if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
      // ThreadSetNameResponse is an empty object in the generated schema.
      if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
    });
    try {
      expect(await setCodexThreadName(THREAD, 'FLEET STUFF', { socketPath: fake.path }))
        .toEqual({ ok: true });
      expect(seen.map(m => m.method))
        .toEqual(['initialize', 'initialized', 'thread/name/set']);
      expect(seen[2]!.params).toEqual({ threadId: THREAD, name: 'FLEET STUFF' });
    } finally { await fake.close(); }
  });

  it("reports the app-server's own refusal instead of claiming the name was set", async () => {
    const fake = await fakeServer((message, send) => {
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (message.method === 'thread/name/set') {
        send({ id: message.id, error: { code: -32602, message: 'unknown thread' } });
      }
    });
    try {
      const result = await setCodexThreadName(THREAD, 'FLEET STUFF', { socketPath: fake.path });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/unknown thread/);
    } finally { await fake.close(); }
  });

  // A daemon that accepts the connection and then says nothing must not
  // leave the caller waiting on a promise that never settles -- the launch
  // it belongs to is blocked on it.
  it('gives up with a reason when the app-server never answers', async () => {
    const fake = await fakeServer(() => {});
    try {
      const result = await setCodexThreadName(THREAD, 'FLEET STUFF',
        { socketPath: fake.path, timeoutMs: 80 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/did not answer/i);
    } finally { await fake.close(); }
  });

  it('reports an absent daemon rather than hanging', async () => {
    const result = await setCodexThreadName(THREAD, 'FLEET STUFF',
      { socketPath: join(tmpdir(), `fleet-codex-absent-${Date.now()}.sock`), timeoutMs: 2000 });
    expect(result.ok).toBe(false);
  });

  // The last gate before the name leaves this app for another tool's own
  // state database. It refuses without opening a socket at all, so there is
  // no case where an unsafe name is even attempted.
  it('refuses an unsafe name and a malformed thread id without connecting', async () => {
    const absent = join(tmpdir(), `fleet-codex-never-${Date.now()}.sock`);
    const unsafe = await setCodexThreadName(THREAD, 'proj; danger', { socketPath: absent, timeoutMs: 50 });
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.reason).toMatch(/letters, numbers/i);
    const bad = await setCodexThreadName('not-a-thread', 'FLEET STUFF', { socketPath: absent, timeoutMs: 50 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/thread id/i);
  });
});
