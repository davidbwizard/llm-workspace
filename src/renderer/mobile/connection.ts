import { object, REMOTE_VERSION, type OperationResult } from '../../core/remote.ts';
export type ConnectionState = 'connecting' | 'ready' | 'offline';
interface Pending { resolve(result: OperationResult): void; mutation: boolean; timer: ReturnType<typeof setTimeout> }
interface Dependencies { bootstrap(): Promise<{ generation: string; ticket: string }>; socket(url: string): WebSocket }
export class MobileConnection {
  private socket?: WebSocket; private epoch = 0; private client = ''; private generation = '';
  private status: ConnectionState = 'offline'; private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>(); private events = new Set<(event: string, payload: unknown) => void>();
  private sendingReply = false;
  private opening?: ReturnType<typeof setTimeout>;
  constructor(private origin: string, private dependencies: Dependencies = {
    bootstrap: async () => { const response = await fetch('/api/bootstrap', { cache: 'no-store', credentials: 'omit' }); if (!response.ok) throw new Error('Private connection refused. Check Tailscale and the Mac settings.'); return response.json(); },
    socket: url => new WebSocket(url),
  }) {}
  state = (): ConnectionState => this.status;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onEvent(listener: (event: string, payload: unknown) => void) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  private setState(value: ConnectionState) { this.status = value; for (const listener of this.listeners) listener(); }
  private settleOffline() {
    clearTimeout(this.opening);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, reason: p.mutation ? 'uncertain' : 'unavailable' }); }
    this.pending.clear(); this.setState('offline');
  }
  async connect(): Promise<void> {
    this.close(); const epoch = ++this.epoch; this.setState('connecting');
    this.opening = setTimeout(() => { if (epoch === this.epoch) this.close(); }, 15_000);
    try {
      const bootstrap = await this.dependencies.bootstrap(); if (epoch !== this.epoch) return;
      const ws = this.dependencies.socket(this.origin.replace(/^https:/, 'wss:') + '/socket'); this.socket = ws;
      ws.onopen = () => { if (epoch === this.epoch) ws.send(JSON.stringify({ v: REMOTE_VERSION, op: 'authenticate', ...bootstrap })); };
      ws.onmessage = message => {
        if (epoch !== this.epoch) return;
        let p: Record<string, unknown> | null;
        try { p = object(JSON.parse(String(message.data))); } catch { this.close(); return; }
        if (!p) return;
        if (p.event === 'ready' && p.generation === bootstrap.generation && typeof p.client === 'string') {
          clearTimeout(this.opening); this.generation = p.generation as string; this.client = p.client; this.setState('ready'); return;
        }
        if (this.status !== 'ready') return;
        if (typeof p.id === 'string') {
          const request = this.pending.get(p.id); if (!request) return;
          this.pending.delete(p.id); clearTimeout(request.timer); request.resolve(p.result as OperationResult);
        } else if (typeof p.event === 'string' && p.client === this.client && p.generation === this.generation) {
          for (const listener of this.events) listener(p.event, p.payload);
        }
      };
      ws.onclose = () => { if (epoch === this.epoch) this.settleOffline(); };
      ws.onerror = () => { if (epoch === this.epoch) { ws.close(); this.settleOffline(); } };
    } catch { if (epoch === this.epoch) this.settleOffline(); }
  }
  request(op: string, payload: unknown): Promise<OperationResult> {
    const ws = this.socket;
    if (this.status !== 'ready' || !ws || ws.readyState !== 1) return Promise.resolve({ ok: false, reason: 'unavailable' });
    if (this.pending.size >= 128) return Promise.resolve({ ok: false, reason: 'busy' });
    const id = crypto.randomUUID();
    const mutation = ['send', 'answerClaude', 'answerCodex', 'launch', 'close', 'terminal:input'].includes(op);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, reason: mutation ? 'uncertain' : 'unavailable' }); }, 30_000);
      this.pending.set(id, { resolve, mutation, timer });
      try { ws.send(JSON.stringify({ v: REMOTE_VERSION, id, op, payload, client: this.client, generation: this.generation })); }
      catch { this.close(); }
    });
  }
  async sendReply(handle: string, text: string, images: File[]): Promise<OperationResult> {
    if (this.sendingReply) return { ok: false, reason: 'busy', message: 'Another reply is still sending on this device. Wait for it to finish.' };
    this.sendingReply = true; const epoch = this.epoch;
    try {
      const ids: string[] = [];
      if (images.length) {
        const cleared = await this.request('image:clear', {}); if (!cleared.ok) return cleared;
        for (const file of images) {
          const result = await this.uploadImage(handle, file); if (!result.ok) return result;
          ids.push((result.value as { id: string }).id);
        }
      }
      if (epoch !== this.epoch) return { ok: false, reason: 'unavailable', message: 'Connection changed. Your reply has not been sent.' };
      return await this.request('send', { handle, text, ...(ids.length ? { images: ids } : {}) });
    } finally { this.sendingReply = false; }
  }
  async uploadImage(handle: string, file: File): Promise<OperationResult> {
    const epoch = this.epoch;
    const prepared = await this.request('image:prepare', { handle });
    if (!prepared.ok) return prepared;
    const ticket = (prepared.value as { ticket: string }).ticket;
    try {
      const response = await fetch('/api/images', {
        method: 'POST', credentials: 'omit', headers: { 'X-Fleet-Upload-Ticket': ticket, 'Content-Type': 'application/octet-stream' },
        body: file, signal: AbortSignal.timeout(30_000),
      });
      if (epoch !== this.epoch) return { ok: false, reason: 'stale' };
      if (!response.ok) return { ok: false, reason: 'unavailable', message: `Image upload failed (${response.status}). Try again after checking the connection.` };
      return await response.json() as OperationResult;
    } catch { return { ok: false, reason: 'unavailable', message: 'Image upload interrupted. Your reply has not been sent.' }; }
  }
  close(): void { ++this.epoch; this.socket?.close(); this.socket = undefined; this.settleOffline(); }
}
