import { lstatSync, unlinkSync, type Stats } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';

export function validateRelaySocketNode(stat: Stats, uid: number, directory: boolean, privateDirectory = true): void {
  if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & (directory && !privateDirectory ? 0o022 : 0o077)) !== 0
    || !(directory ? stat.isDirectory() : stat.isSocket()))
    throw new Error('The private Codex relay path has unsafe ownership or permissions.');
}
/** Remove only a proven stale, owned socket at the main-generated endpoint.
 * A live listener, symlink, foreign inode or ambiguous error is preserved. */
export async function prepareCodexRelaySocket(path: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Cannot verify ownership of the private Codex relay socket.');
  validateRelaySocketNode(lstatSync(dirname(dirname(path))), uid, true, false);
  validateRelaySocketNode(lstatSync(dirname(path)), uid, true);
  let inode: Stats;
  try { inode = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  validateRelaySocketNode(inode, uid, false);
  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('timeout', () => { probe.destroy(); reject(new Error('Cannot determine whether the Codex relay socket is live.')); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error('A live process already owns the Codex relay socket.');
  let current: Stats;
  try { current = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  validateRelaySocketNode(current, uid, false);
  if (current.ino !== inode.ino || current.dev !== inode.dev) throw new Error('The Codex relay socket changed during repair.');
  unlinkSync(path);
}

