// Images attached in the conversation pane, staged for sending.
//
// The renderer sends BYTES, never a path, whether the image was dropped,
// picked or pasted -- so main never reads a file the renderer names. Main
// checks the bytes are a real PNG, JPEG, GIF or WebP within the size cap,
// writes them to a private folder under a generated name, and hands back an
// opaque id. At send time sendKeysFor pastes that file's path, single-quoted,
// which is the form both Claude Code and Codex attach (measured 2026-09-17:
// Codex keeps a raw path with spaces as plain text). The generated name
// means no quote or unusual character can ever reach that quoting.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, sniffImage } from './images.ts';

/** Staged images kept per app run; the oldest is deleted past this. */
export const MAX_STAGED = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

export type StageRefusal = 'invalid' | 'not_image' | 'too_large' | 'failed';
export type StageResult = { ok: true; id: string } | { ok: false; reason: StageRefusal };

export function createStager(dir: string) {
  const staged = new Map<string, string>();   // id -> file, oldest first

  async function stage(input: unknown): Promise<StageResult> {
    let bytes: Buffer;
    if (input instanceof Uint8Array) bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    else if (input instanceof ArrayBuffer) bytes = Buffer.from(input);
    else return { ok: false, reason: 'invalid' };
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too_large' };
    const type = sniffImage(bytes);
    if (!type) return { ok: false, reason: 'not_image' };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${randomUUID()}.${EXT[type]}`);
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      const id = randomUUID();
      staged.set(id, file);
      while (staged.size > MAX_STAGED) {
        const [oldId, oldFile] = staged.entries().next().value as [string, string];
        staged.delete(oldId);
        await unlink(oldFile).catch((err: unknown) => console.error('staged image cleanup failed:', err));
      }
      return { ok: true, id };
    } catch (err) {
      console.error('staging an image failed:', err);
      return { ok: false, reason: 'failed' };
    }
  }

  function pathFor(id: unknown): string | null {
    return typeof id === 'string' ? staged.get(id) ?? null : null;
  }

  /** Deletes files an earlier run left behind for more than a day. Anything
   *  staged in this run is younger than that, so it is never touched. */
  async function sweep(): Promise<void> {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    const cutoff = Date.now() - MAX_AGE_MS;
    await Promise.all(names.map(async name => {
      const file = join(dir, name);
      try {
        if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
      } catch (err) {
        console.error('sweeping a staged image failed:', err);
      }
    }));
  }

  return { stage, pathFor, sweep };
}
