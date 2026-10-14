import { expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { authorize, Tickets } from '../../src/main/remote/auth.ts';
const config = { enabled: true, port: 43180, origin: 'https://mac.tail123.ts.net', login: 'owner@example.com', previews: [] };
function request(extra: string[] = [], origin = config.origin) {
  return { rawHeaders: ['Host', 'mac.tail123.ts.net', 'Tailscale-User-Login', config.login, 'Origin', origin, ...extra], socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
}
it('requires unique proxy identity, host and exact origin', () => {
  expect(authorize(request(), config, true)).toBe(true);
  expect(authorize(request(['Tailscale-User-Login', config.login]), config, true)).toBe(false);
  expect(authorize(request([], config.origin + ':8443'), config, true)).toBe(false);
  expect(authorize({ ...request(), socket: { remoteAddress: '192.168.1.2' } } as IncomingMessage, config, true)).toBe(false);
});
it('consumes bounded expiring bootstrap tickets once', () => {
  let now = 0; const tickets = new Tickets(() => now);
  const token = tickets.issue(); expect(token).toHaveLength(64);
  expect(tickets.consume(token)).toBe(true); expect(tickets.consume(token)).toBe(false);
  const old = tickets.issue(); now = 600_001; expect(tickets.consume(old)).toBe(false);
});
