type Emit = (event: string, payload: unknown) => void;
export interface TerminalClientDeps {
  identity(pid: number): string | null;
  attach(client: string, pid: number, cols: number, rows: number, emit: Emit): Promise<{ status: string; reason?: string }>;
  detach(client: string, pid: number): void;
  resize(client: string, pid: number, cols: number, rows: number): void;
  size(pid: number, cols: number, rows: number): void;
  restoreSize?(pid: number): void;
  input(client: string, pid: number, data: string): void;
  busy(pid: number): boolean;
}
interface Viewer { identity: string; emit: Emit; generation: number }
interface Pane { cols: number; rows: number; owner: string | null; viewers: Map<string, Viewer> }
export type TerminalResult = { status: 'attached' | 'sent' | 'resized' | 'controlled' | 'detached' } | { status: 'refused'; reason: string };
function sizeOK(cols: number, rows: number): boolean { return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 2 && cols <= 500 && rows <= 300; }

/** Device lifetimes and input ownership are separate from the agent process. */
export class TerminalClients {
  private panes = new Map<number, Pane>();
  private generation = 0;
  constructor(private readonly deps: TerminalClientDeps) {}
  async attach(client: string, pid: number, cols: number, rows: number, emit: Emit): Promise<TerminalResult> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !sizeOK(cols, rows)) return { status: 'refused', reason: 'invalid' };
    const identity = this.deps.identity(pid);
    if (!identity) return { status: 'refused', reason: 'stale' };
    const prior = this.panes.get(pid)?.viewers.get(client);
    if (prior) return prior.identity === identity ? { status: 'attached' } : { status: 'refused', reason: 'stale' };
    let pane = this.panes.get(pid);
    if (!pane) { pane = { cols, rows, owner: null, viewers: new Map() }; this.panes.set(pid, pane); }
    const generation = ++this.generation;
    pane.viewers.set(client, { identity, emit, generation });
    try {
      const result = await this.deps.attach(client, pid, pane.cols, pane.rows, (event, payload) => {
        if (pane!.viewers.get(client)?.generation === generation) emit(event, payload);
      });
      if (result.status !== 'attached') { this.release(client, pid); return { status: 'refused', reason: result.reason ?? 'unavailable' }; }
      if (pane.viewers.get(client)?.generation !== generation) return { status: 'refused', reason: 'stale' };
      if (!pane.owner) pane.owner = client;
      this.deps.size(pid, pane.cols, pane.rows);
      this.broadcast(pid, pane);
      return { status: 'attached' };
    } catch (error) { this.release(client, pid); throw error; }
  }
  private broadcast(pid: number, pane: Pane): void {
    for (const [client, viewer] of pane.viewers) viewer.emit('terminal:control', { pid, controlling: pane.owner === client, cols: pane.cols, rows: pane.rows });
  }
  private check(client: string, pid: number, ownership = true): TerminalResult | null {
    const pane = this.panes.get(pid); const viewer = pane?.viewers.get(client);
    if (!viewer || this.deps.identity(pid) !== viewer.identity) return { status: 'refused', reason: 'stale' };
    if (ownership && pane!.owner !== client) return { status: 'refused', reason: 'not_controller' };
    if (this.deps.busy(pid)) return { status: 'refused', reason: 'busy' };
    return null;
  }
  takeControl(client: string, pid: number): TerminalResult {
    const refusal = this.check(client, pid, false); if (refusal) return refusal;
    const pane = this.panes.get(pid)!; pane.owner = client; this.broadcast(pid, pane); return { status: 'controlled' };
  }
  resize(client: string, pid: number, cols: number, rows: number): TerminalResult {
    if (!sizeOK(cols, rows)) return { status: 'refused', reason: 'invalid_size' };
    const refusal = this.check(client, pid); if (refusal) return refusal;
    const pane = this.panes.get(pid)!;
    if (pane.cols === cols && pane.rows === rows) return { status: 'resized' };
    this.deps.size(pid, cols, rows);
    for (const id of pane.viewers.keys()) this.deps.resize(id, pid, cols, rows);
    pane.cols = cols; pane.rows = rows; this.broadcast(pid, pane);
    return { status: 'resized' };
  }
  input(client: string, pid: number, data: string): TerminalResult {
    if (typeof data !== 'string' || !data || Buffer.byteLength(data) > 64 * 1024) return { status: 'refused', reason: 'invalid_data' };
    const refusal = this.check(client, pid); if (refusal) return refusal;
    this.deps.input(client, pid, data); return { status: 'sent' };
  }
  canAct(client: string, pid: number): boolean { const owner = this.panes.get(pid)?.owner; return !owner || owner === client; }
  release(client: string, onlyPid?: number): void {
    for (const [pid, pane] of this.panes) {
      if (onlyPid !== undefined && onlyPid !== pid) continue;
      if (!pane.viewers.delete(client)) continue;
      try { this.deps.detach(client, pid); }
      finally {
        if (!pane.viewers.size) { this.panes.delete(pid); this.deps.restoreSize?.(pid); }
        else { if (pane.owner === client) pane.owner = null; this.broadcast(pid, pane); }
      }
    }
  }
  close(): void { for (const pane of [...this.panes.values()]) for (const client of [...pane.viewers.keys()]) this.release(client); }
}
