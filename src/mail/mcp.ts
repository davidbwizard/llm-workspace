// The small part of MCP the mail slot needs: newline-delimited JSON-RPC
// over stdio, with initialize, ping, tools/list and tools/call.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, meta?: Record<string, unknown>) => Promise<string>;
}

/** Thrown by a tool to refuse with a message the calling agent can act on. */
export class ToolRefusal extends Error {}

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

type Response = { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string } };

export async function handleMessage(msg: any, tools: McpTool[]): Promise<Response | null> {
  const id = msg?.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;   // notifications get no answer
  const ok = (result: unknown): Response => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Response => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[VERSIONS.length - 1],
        capabilities: { tools: {} },
        serverInfo: { name: 'fleet-mail', version: '1.0.0' },
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = tools.find(t => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${String(msg.params?.name)}`);
      const args = msg.params?.arguments;
      try {
        const meta = msg.params?._meta;
        const text = await tool.call(args && typeof args === 'object' ? args : {},
          meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : undefined);
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        if (e instanceof ToolRefusal) return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        throw e;
      }
    }
    default:
      return fail(-32601, `method not found: ${String(msg.method)}`);
  }
}
