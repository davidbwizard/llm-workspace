import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MOBILE_IMAGE_BYTES, type OperationResult } from '../../core/remote.ts';
import type { SessionOperations } from '../sessionOperations.ts';

/** One-use capabilities issued on an authenticated socket; bytes never travel in WS frames. */
export class ImageUploads {
  private tickets = new Map<string, { token: string; handle: string; expires: number }>();
  private active = new Map<string, IncomingMessage>();
  constructor(private operations: SessionOperations) {}
  prepare(client: string, handle: string): OperationResult {
    const target = this.operations.resolve(handle);
    if (!target?.tmux || !target.sessionId) return { ok: false, reason: 'stale' };
    if (this.active.has(client)) return { ok: false, reason: 'busy' };
    const token = randomBytes(32).toString('hex');
    this.tickets.set(client, { token, handle, expires: Date.now() + 30_000 });
    return { ok: true, value: { ticket: token } };
  }
  release(client: string): void {
    this.tickets.delete(client); this.active.get(client)?.destroy(); this.active.delete(client);
  }
  async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number) => { res.writeHead(status, { Connection: 'close' }); res.end(); req.resume(); };
    const headers = req.rawHeaders.filter((_, i) => i % 2 === 0).map(h => h.toLowerCase());
    const token = req.headers['x-fleet-upload-ticket'];
    const found = headers.filter(h => h === 'x-fleet-upload-ticket').length === 1 && typeof token === 'string'
      ? [...this.tickets].find(([, t]) => t.token === token) : undefined;
    if (!found) return fail(403);
    const [client, ticket] = found; this.tickets.delete(client);
    if (ticket.expires < Date.now()) return fail(403);
    if (this.active.size >= 2 || this.active.has(client)) return fail(429);
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MOBILE_IMAGE_BYTES)) return fail(413);
    this.active.set(client, req);
    const timer = setTimeout(() => req.destroy(), 30_000);
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MOBILE_IMAGE_BYTES) { fail(413); return; }
        chunks.push(chunk);
      }
      if (this.active.get(client) !== req) return;
      const result = await this.operations.stageImage(client, ticket.handle, Buffer.concat(chunks, size));
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) {
      if (!req.destroyed) { console.error('Remote image upload failed:', (error as NodeJS.ErrnoException).code ?? 'unknown'); fail(500); }
    } finally {
      clearTimeout(timer); if (this.active.get(client) === req) this.active.delete(client);
    }
  }
}
