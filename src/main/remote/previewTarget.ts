import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { connect } from 'node:net';
type Loopback = '127.0.0.1' | '::1';
const pending = new Map<string, Promise<{ host: Loopback }>>();
function lsof(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/lsof', args, { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('Cannot verify the preview listener. Start the project server and try again.', { cause: error }));
      else resolve(stdout);
    });
  });
}
function reachable(host: Loopback, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
/** Concurrent assets share an in-flight check; completed checks never authorize later requests. */
export function inspectPreviewTarget(project: string, port: number): Promise<{ host: Loopback }> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(new Error('Invalid preview port.'));
  if (!isAbsolute(project)) return Promise.reject(new Error('The preview project needs an absolute directory.'));
  const key = JSON.stringify([project, port]); const existing = pending.get(key); if (existing) return existing;
  const check = inspect(project, port).finally(() => pending.delete(key)); pending.set(key, check); return check;
}
async function inspect(project: string, port: number): Promise<{ host: Loopback }> {
  const root = await realpath(project);
  const listeners = await lsof(['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp']);
  const pids = [...new Set(listeners.split('\n').filter(line => /^p[1-9]\d*$/.test(line)).map(line => line.slice(1)))];
  if (!pids.length || pids.length > 16) throw new Error('No unique project listener could be verified on this port.');
  for (const pid of pids) {
    const output = await lsof(['-a', '-p', pid, '-d', 'cwd', '-Fn']);
    const directories = output.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    if (directories.length !== 1) throw new Error('Cannot verify the listener project directory.');
    let cwd: string;
    try { cwd = await realpath(directories[0]!); }
    catch (error) { throw new Error('Cannot verify the listener project directory.', { cause: error }); }
    const child = relative(root, cwd);
    if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new Error('The server on this port belongs to another project.');
  }
  for (const host of ['127.0.0.1', '::1'] as const) if (await reachable(host, port)) return { host };
  throw new Error('The project server is not reachable on localhost.');
}
