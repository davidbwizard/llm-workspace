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
import { lstat, mkdir, readdir, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MAX_IMAGE_BYTES, sniffImage } from './images.ts';

/** Staged images kept per app run; the oldest is deleted past this. */
export const MAX_STAGED = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

export type StageRefusal = 'invalid' | 'not_image' | 'too_large' | 'failed';
export type StageResult = { ok: true; id: string } | { ok: false; reason: StageRefusal };

function toBuffer(input: unknown): Buffer | null {
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return null;
}

export function createStager(dir: string) {
  const staged = new Map<string, string>();   // id -> file, oldest first

  async function stage(input: unknown): Promise<StageResult> {
    const bytes = toBuffer(input);
    if (!bytes) return { ok: false, reason: 'invalid' };
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
   *  staged in this run is younger than that, so it is never touched.
   *
   *  Only this stager writes here, so every entry SHOULD be a file it wrote
   *  -- but the real folder has picked up stray directories, and unlink on
   *  a directory returns EPERM on macOS. Before the isDirectory() check
   *  below that meant the same lines logged on every launch, forever, with
   *  nothing able to clear them. The deliberate call: an empty stray
   *  directory is removed, which clears it for good; one with anything in
   *  it is left alone and named, because this sweep does not know what put
   *  it there and must not delete content it did not write.
   *
   *  lstat, not stat: an entry is judged by its own age and its own type,
   *  so a symlink is a link to be unlinked rather than whatever it points
   *  at, and a dangling one is still cleaned up rather than skipped. */
  async function sweep(): Promise<void> {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    const cutoff = Date.now() - MAX_AGE_MS;
    await Promise.all(names.map(async name => {
      const file = join(dir, name);
      try {
        const info = await lstat(file);
        if (info.mtimeMs >= cutoff) return;
        if (info.isDirectory()) await rmdir(file);
        else await unlink(file);
      } catch (err) {
        // One line per reason, not one line for everything: a directory
        // someone else put here, a permission problem and an outright
        // failure are three different situations and only the last is a
        // bug in this app.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;   // already gone -- a concurrent instance swept it
        if (code === 'ENOTEMPTY') {
          console.error('sweeping staged images: leaving a directory that is not empty and not ours:', file);
        } else if (code === 'EPERM' || code === 'EACCES') {
          console.error(`sweeping staged images: not permitted to delete (${code}):`, file);
        } else {
          console.error('sweeping a staged image failed:', file, err);
        }
      }
    }));
  }

  return { stage, pathFor, sweep };
}

// Any other file attached in the conversation pane. It is not attached the
// way an image is: the agent gets the file's path in the message and reads
// it with its own tools. Kept in its own folder, under the name it was
// given (cleaned), so the agent sees "report.pdf" rather than an id.
// David's call, 2026-09-17: these stay in the OS temp folder rather than
// the session's own directory, so nothing is written into a project --
// knowing Claude Code then asks before reading each one (measured the same
// day; Codex reads them without asking).

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME_CHARS = 100;

/** A name that is safe inside a single-quoted path: no directory part, no
 *  quote, backslash or backtick, no control character, no leading dot. */
export function cleanFileName(raw: string): string {
  let name = raw.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/['"`\\]/g, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  if (!name) return 'file';
  if (name.length > MAX_NAME_CHARS) {
    const ext = extname(name).slice(0, 12);
    name = name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return name;
}

export function createFileStager(dir: string) {
  const staged = new Map<string, string>();   // id -> file, oldest first

  async function stage(input: unknown, rawName: unknown): Promise<StageResult> {
    const bytes = toBuffer(input);
    if (!bytes || typeof rawName !== 'string') return { ok: false, reason: 'invalid' };
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const folder = join(dir, randomUUID());
      await mkdir(folder, { mode: 0o700 });
      const file = join(folder, cleanFileName(rawName));
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      const id = randomUUID();
      staged.set(id, file);
      while (staged.size > MAX_STAGED) {
        const [oldId, oldFile] = staged.entries().next().value as [string, string];
        staged.delete(oldId);
        await rm(join(oldFile, '..'), { recursive: true, force: true })
          .catch((err: unknown) => console.error('staged file cleanup failed:', err));
      }
      return { ok: true, id };
    } catch (err) {
      console.error('staging a file failed:', err);
      return { ok: false, reason: 'failed' };
    }
  }

  function pathFor(id: unknown): string | null {
    return typeof id === 'string' ? staged.get(id) ?? null : null;
  }

  /** Deletes upload folders older than seven days. */
  async function sweep(): Promise<void> {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    const cutoff = Date.now() - FILE_MAX_AGE_MS;
    await Promise.all(names.map(async name => {
      const folder = join(dir, name);
      try {
        if ((await stat(folder)).mtimeMs < cutoff) await rm(folder, { recursive: true, force: true });
      } catch (err) {
        console.error('sweeping a staged file failed:', err);
      }
    }));
  }

  return { stage, pathFor, sweep };
}
