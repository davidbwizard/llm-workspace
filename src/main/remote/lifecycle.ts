import { DEFAULT_REMOTE, parseRemoteConfig, type RemoteConfig } from './config.ts';
export interface RemoteStatus { config: RemoteConfig; state: 'disabled' | 'starting' | 'ready' | 'error'; error: string | null }
interface Dependencies { read(): RemoteConfig; save(config: RemoteConfig): void; start(config: RemoteConfig): Promise<{ close(): Promise<void> }> }
export class RemoteLifecycle {
  private current: RemoteStatus = { config: DEFAULT_REMOTE, state: 'disabled', error: null };
  private service?: { close(): Promise<void> }; private queue = Promise.resolve(); private closed = false;
  constructor(private dependencies: Dependencies) {}
  status(): RemoteStatus { return structuredClone(this.current); }
  async initialize(): Promise<void> {
    try { this.current.config = this.dependencies.read(); await this.restart(); }
    catch (error) { this.current.state = 'error'; this.current.error = error instanceof Error ? error.message : 'Could not read remote access settings.'; }
  }
  private async restart(): Promise<void> {
    await this.service?.close(); this.service = undefined;
    this.current.error = null;
    if (!this.current.config.enabled) { this.current.state = 'disabled'; return; }
    this.current.state = 'starting';
    try { this.service = await this.dependencies.start(this.current.config); this.current.state = 'ready'; }
    catch (error) { this.current.state = 'error'; this.current.error = error instanceof Error ? error.message : 'Could not start remote access.'; }
  }
  configure(raw: unknown): Promise<RemoteStatus> {
    const work = this.queue.then(async () => {
      if (this.closed) throw new Error('Fleet is shutting down.');
      const config = parseRemoteConfig(raw);
      if (JSON.stringify(config) === JSON.stringify(this.current.config) && this.current.state !== 'error') return this.status();
      this.dependencies.save(config); this.current.config = config; await this.restart(); return this.status();
    });
    this.queue = work.then(() => {}, () => {}); return work;
  }
  async close(): Promise<void> { this.closed = true; await this.queue; await this.service?.close(); this.service = undefined; this.current.state = 'disabled'; }
}
