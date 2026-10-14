import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RemoteConfig } from './config.ts';
function header(req: IncomingMessage, name: string): string | null {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  return values.length === 1 ? values[0]! : null;
}
/** Only a local Tailscale Serve proxy is trusted; the listener never binds to LAN. */
export function authorize(req: IncomingMessage, config: RemoteConfig, requireOrigin = false): boolean {
  const origin = header(req, 'origin');
  if (origin === null && req.rawHeaders.some((v, i) => i % 2 === 0 && v.toLowerCase() === 'origin')) return false;
  return req.socket.remoteAddress === '127.0.0.1' && header(req, 'host') === new URL(config.origin).host
    && header(req, 'tailscale-user-login') === config.login
    && (requireOrigin ? origin === config.origin : origin === null || origin === config.origin);
}
export class Tickets {
  private tickets = new Map<string, number>();
  constructor(private now = Date.now) {}
  issue(): string {
    for (const [key, expires] of this.tickets) if (expires <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 64) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('hex'); this.tickets.set(ticket, this.now() + 600_000); return ticket;
  }
  consume(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const expires = this.tickets.get(value); this.tickets.delete(value); return expires !== undefined && expires > this.now();
  }
}
export class Budget {
  private start = 0; private used = 0;
  constructor(private limit: number, private period: number) {}
  take(amount = 1): boolean {
    const now = Date.now(); if (now - this.start >= this.period) { this.start = now; this.used = 0; }
    this.used += amount; return this.used <= this.limit;
  }
}
