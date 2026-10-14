import { DEFAULT_REMOTE, parseRemoteConfig, type RemoteConfig } from './config.ts';
export interface RemoteStatus { config: RemoteConfig; state: 'disabled' | 'starting' | 'ready' | 'error'; error: string | null }
interface Dependencies { read(): RemoteConfig; save(config: RemoteConfig): void; start(config: RemoteConfig): Promise<{ close(): Promise<void> }> }
export class RemoteLifecycle {
  private current: RemoteStatus = { config: DEFAULT_REMOTE, state: 'disabled', error: null };
  private service?: { close(): Promise<void> }; private queue = Promise.resolve(); private closed = false;
  private configurationPending = 0;
  constructor(private dependencies: Dependencies) {}
  status(): RemoteStatus { return structuredClone(this.current); }
  async initialize(): Promise<void> {
    try { this.current.config = this.dependencies.read(); await this.restart(); }
    catch (error) { this.current.state = 'error'; this.current.error = error instanceof Error ? error.message : 'Could not read remote access settings.'; }
  }
  private async restart(): Promise<void> {
    this.current.state = 'starting';
    this.current.error = null;
    await this.service?.close(); this.service = undefined;
    if (!this.current.config.enabled) { this.current.state = 'disabled'; return; }
    this.current.state = 'starting';
    try { this.service = await this.dependencies.start(this.current.config); this.current.state = 'ready'; }
    catch (error) { this.current.state = 'error'; this.current.error = error instanceof Error ? error.message : 'Could not start remote access.'; }
  }
  configure(raw: unknown): Promise<RemoteStatus> {
    return this.configureQueued(raw);
  }
  configureIfCurrent(raw: unknown, expected: RemoteConfig): Promise<RemoteStatus> {
    // A settings restart waits for active remote requests to drain. A preview
    // request must not queue its save behind that restart and deadlock it.
    if (this.configurationPending || this.closed || JSON.stringify(expected) !== JSON.stringify(this.current.config))
      return Promise.reject(new Error('Remote settings changed. Try opening the website again.'));
    return this.configureQueued(raw, expected);
  }
  private configureQueued(raw: unknown, expected?: RemoteConfig): Promise<RemoteStatus> {
    this.configurationPending++;
    const work = this.queue.then(async () => {
      if (this.closed) throw new Error('Fleet is shutting down.');
      if (expected && JSON.stringify(expected) !== JSON.stringify(this.current.config))
        throw new Error('Remote settings changed. Try opening the website again.');
      const config = parseRemoteConfig(raw);
      if (JSON.stringify(config) === JSON.stringify(this.current.config) && this.current.state !== 'error') return this.status();
      // Preview routes read current config on each request. Keep the socket
      // alive so a phone can receive the result of its own preview setup.
      const routesOnly = this.current.state === 'ready'
        && JSON.stringify({ ...config, previews: [] }) === JSON.stringify({ ...this.current.config, previews: [] });
      this.dependencies.save(config); this.current.config = config;
      if (!routesOnly) await this.restart();
      return this.status();
    }).finally(() => { this.configurationPending--; });
    this.queue = work.then(() => {}, () => {}); return work;
  }
  async close(): Promise<void> { this.closed = true; await this.queue; await this.service?.close(); this.service = undefined; this.current.state = 'disabled'; }
}
