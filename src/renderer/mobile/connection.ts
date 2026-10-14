import { object, REMOTE_VERSION, type OperationResult } from '../../core/remote.ts';
export type ConnectionState = 'connecting' | 'ready' | 'offline';
interface Pending { resolve(result: OperationResult): void; mutation: boolean; timer: ReturnType<typeof setTimeout> }
interface Dependencies { bootstrap(): Promise<{ generation: string; ticket: string }>; socket(url: string): WebSocket }
export class MobileConnection {
  private socket?: WebSocket; private epoch = 0; private client = ''; private generation = '';
  private status: ConnectionState = 'offline'; private pending = new Map<string, Pending>();
  private listeners = new Set<() => void>(); private events = new Set<(event: string, payload: unknown) => void>();
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
    const mutation = ['send', 'answerClaude', 'answerCodex', 'launch', 'terminal:input'].includes(op);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, reason: mutation ? 'uncertain' : 'unavailable' }); }, 30_000);
      this.pending.set(id, { resolve, mutation, timer });
      try { ws.send(JSON.stringify({ v: REMOTE_VERSION, id, op, payload, client: this.client, generation: this.generation })); }
      catch { this.close(); }
    });
  }
  close(): void { ++this.epoch; this.socket?.close(); this.socket = undefined; this.settleOffline(); }
}
