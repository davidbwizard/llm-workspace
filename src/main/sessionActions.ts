import type { OperationResult } from '../core/remote.ts';
interface Receipt { fingerprint: string; promise: Promise<OperationResult>; expires: number; pending: boolean }
interface Job { run(): Promise<void>; cancel(): void; timer: ReturnType<typeof setTimeout> }

/** At-most-once within one server generation; crashed effects remain uncertain. */
export class SessionActions {
  private receipts = new Map<string, Receipt>();
  private prompts = new Map<string, number>();
  private queues = new Map<string, Job[]>();
  private closed = false;
  constructor(private readonly options: { capacity?: number; queueTimeoutMs?: number; ttlMs?: number } = {}) {}
  claimPrompt(session: string, prompt: string): boolean {
    this.prune(); const key = JSON.stringify([session, prompt]);
    if (this.prompts.has(key) || this.prompts.size >= (this.options.capacity ?? 1024)) return false;
    this.prompts.set(key, Date.now() + (this.options.ttlMs ?? 30 * 60_000)); return true;
  }
  releasePrompt(session: string, prompt: string): void { this.prompts.delete(JSON.stringify([session, prompt])); }
  private prune(): void {
    const now = Date.now();
    for (const [key, r] of this.receipts) if (!r.pending && r.expires <= now) this.receipts.delete(key);
    for (const [key, expires] of this.prompts) if (expires <= now) this.prompts.delete(key);
  }
  run(session: string, request: string, fingerprint: string, effect: () => Promise<OperationResult>): Promise<OperationResult> {
    this.prune();
    if (this.closed) return Promise.resolve({ ok: false, reason: 'unavailable' });
    const key = JSON.stringify([session, request]); const prior = this.receipts.get(key);
    if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.resolve({ ok: false, reason: 'invalid' });
    const queue = this.queues.get(session) ?? [];
    if (this.receipts.size >= (this.options.capacity ?? 1024) || queue.length >= 32) return Promise.resolve({ ok: false, reason: 'busy' });
    let resolve!: (r: OperationResult) => void;
    const promise = new Promise<OperationResult>(r => { resolve = r; });
    const receipt: Receipt = { fingerprint, promise, expires: Infinity, pending: true };
    this.receipts.set(key, receipt);
    let canceled = false;
    const finish = (result: OperationResult) => {
      receipt.pending = false; receipt.expires = Date.now() + (this.options.ttlMs ?? 30 * 60_000); resolve(result);
    };
    const job: Job = {
      timer: setTimeout(() => { canceled = true; finish({ ok: false, reason: 'busy' }); }, this.options.queueTimeoutMs ?? 30_000),
      cancel: () => { canceled = true; clearTimeout(job.timer); finish({ ok: false, reason: 'unavailable' }); },
      run: async () => {
        clearTimeout(job.timer);
        if (!canceled) {
          try { finish(await effect()); }
          catch (error) { console.error('Fleet action outcome uncertain:', error instanceof Error ? error.message : 'unknown error'); finish({ ok: false, reason: 'uncertain' }); }
        }
        queue.shift();
        if (queue.length) void queue[0]!.run(); else this.queues.delete(session);
      },
    };
    queue.push(job); this.queues.set(session, queue);
    if (queue.length === 1) void job.run();
    return promise;
  }
  busy(session: string): boolean { return (this.queues.get(session)?.length ?? 0) > 0; }
  close(): void {
    this.closed = true;
    // Executing effects cannot safely be canceled. Drop only queued work.
    for (const queue of this.queues.values()) for (const job of queue.slice(1)) job.cancel();
  }
}
export const sessionActions = new SessionActions();
