import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { RemoteConfig } from './config.ts';
function canonical(path: string): string | null {
  try { return realpathSync(path); }
  catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; }
}
function available(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000); socket.once('connect', () => finish(true)); socket.once('timeout', () => finish(false)); socket.once('error', () => finish(false));
  });
}
export async function previewsForProject(config: RemoteConfig, project: string, probe = available) {
  const real = canonical(project); if (!real) return [];
  return Promise.all(config.previews.filter(p => canonical(p.project) === real).map(async p => ({ id: p.id, label: p.label, url: p.url, available: await probe(p.localPort, p.localHost ?? '127.0.0.1') })));
}
