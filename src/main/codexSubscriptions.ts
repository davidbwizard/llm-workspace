import type { CodexAppServer, CodexAnswerResult } from './codexAppServer.ts';
import type { CodexSnapshot } from '../core/codexPrompt.ts';
type Observer = Pick<CodexAppServer, 'watch' | 'stop' | 'snapshot' | 'answer'>;

/** One request store per thread, shared by every viewing device. */
export class CodexSubscriptions {
  private clients = new Map<string, string>();
  private threads = new Map<string, { observer: Observer; listeners: Map<string, () => void> }>();
  constructor(private readonly create: () => Observer) {}

  watch(threadId: string, changed: () => void): void;
  watch(clientId: string, threadId: string, changed: () => void): void;
  watch(a: string, b: string | (() => void), c?: () => void): void {
    const client = typeof b === 'string' ? a : 'desktop';
    const thread = typeof b === 'string' ? b : a;
    const changed = typeof b === 'string' ? c! : b;
    if (this.clients.get(client) === thread) {
      this.threads.get(thread)!.listeners.set(client, changed);
      return;
    }
    this.release(client);
    let entry = this.threads.get(thread);
    const fresh = !entry;
    if (!entry) {
      entry = { observer: this.create(), listeners: new Map() };
      this.threads.set(thread, entry);
    }
    this.clients.set(client, thread);
    entry.listeners.set(client, changed);
    if (fresh) {
      const current = entry;
      entry.observer.watch(thread, () => {
        for (const listener of [...current.listeners.values()]) listener();
      });
    }
  }
  release(client: string): void {
    const thread = this.clients.get(client);
    if (!thread) return;
    this.clients.delete(client);
    const entry = this.threads.get(thread)!;
    entry.listeners.delete(client);
    if (!entry.listeners.size) { this.threads.delete(thread); entry.observer.stop(); }
  }
  snapshot(thread: string): CodexSnapshot | null { return this.threads.get(thread)?.observer.snapshot(thread) ?? null; }
  answer(thread: unknown, key: unknown, answer: unknown): CodexAnswerResult {
    if (typeof thread !== 'string') return { status: 'refused', reason: 'stale' };
    return this.threads.get(thread)?.observer.answer(thread, key, answer) ?? { status: 'refused', reason: 'stale' };
  }
  stop(): void { for (const client of [...this.clients.keys()]) this.release(client); }
}
