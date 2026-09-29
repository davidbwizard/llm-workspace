import { describe, it, expect } from 'vitest';
import { handleMessage, ToolRefusal, type McpTool } from '../../src/mail/mcp.ts';

const echo: McpTool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, call: async args => String(args.text) };
const refuser: McpTool = { name: 'no', description: 'No', inputSchema: { type: 'object' }, call: async () => { throw new ToolRefusal('Not today.'); } };
const tools = [echo, refuser];

describe('handleMessage', () => {
  it('completes the handshake', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools)).toEqual({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fleet-mail', version: '1.0.0' } },
    });
    expect(await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, tools))
      .toMatchObject({ result: { protocolVersion: '2025-11-25' } });
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools)).toBeNull();
  });

  it('lists and calls tools', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, tools)).toEqual({
      jsonrpc: '2.0', id: 3,
      result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }, { name: 'no', description: 'No', inputSchema: { type: 'object' } }] },
    });
    expect(await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }, tools))
      .toEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'hi' }] } });
  });

  it("hands the call's _meta to the tool", async () => {
    let seen: unknown = null;
    const spy: McpTool = { name: 'spy', description: 'Spy', inputSchema: { type: 'object' }, call: async (_a, meta) => { seen = meta; return 'ok'; } };
    await handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'spy', arguments: {}, _meta: { 'x-codex-turn-metadata': { thread: 't1' } } } }, [spy]);
    expect(seen).toEqual({ 'x-codex-turn-metadata': { thread: 't1' } });
  });

  it('reports refusals as tool errors and unknowns as protocol errors', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no', arguments: {} } }, tools))
      .toEqual({ jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'Not today.' }], isError: true } });
    expect(await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }, tools))
      .toMatchObject({ error: { code: -32602 } });
    expect(await handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, tools)).toMatchObject({ error: { code: -32601 } });
  });
});
