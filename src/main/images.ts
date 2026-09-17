// Images an agent's reply links to, read for the conversation pane.
//
// The renderer never loads a local file itself: its CSP allows `img-src
// 'self' data:` and nothing else, and it stays that way. Instead it asks
// main for (sessionId, src) and gets back a data: URL or a refusal. The src
// comes straight out of agent-written Markdown, so it is untrusted: main
// resolves it against the session's own folder -- taken from main's event
// log, never from the renderer -- follows symlinks to where they really
// point, and only reads files that (a) sit inside that folder or a temp
// folder, (b) are PNG, JPEG, GIF or WebP by their leading bytes, not just
// their name, and (c) are no larger than MAX_IMAGE_BYTES. SVG is excluded:
// it is a document format, not a picture. Nothing is ever fetched.
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SRC_CHARS = 4096;

export type ImageRefusal = 'invalid' | 'no_session' | 'outside_roots' | 'not_found' | 'not_image' | 'too_large';
export type ImageResult = { ok: true; dataUrl: string } | { ok: false; reason: ImageRefusal };

type Deps = {
  /** The session's working folder from main's own records, or null. */
  cwdFor: (sessionId: string) => string | null;
};

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

/** The format the bytes themselves declare, or null. Shared with
 *  attachments.ts. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const refuse = (reason: ImageRefusal): ImageResult => ({ ok: false, reason });

/** src as written -> an absolute path, or null if it is not a local path at
 *  all. A scheme other than file: (https, data, javascript, ...) is never a
 *  local path; web images are not fetched. */
function toPath(src: string, cwd: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    if (!src.toLowerCase().startsWith('file:')) return null;
    try { return fileURLToPath(src); } catch { return null; }
  }
  let p = src;
  if (p.includes('%')) {
    try { p = decodeURIComponent(p); } catch { /* not percent-encoding after all; use as written */ }
  }
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function realOrNull(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

export const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

export async function readSessionImage(sessionId: unknown, src: unknown, deps: Deps): Promise<ImageResult> {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) return refuse('invalid');
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_SRC_CHARS || src.includes('\0')) return refuse('invalid');

  const cwd = deps.cwdFor(sessionId);
  if (!cwd) return refuse('no_session');
  const path = toPath(src.trim(), cwd);
  if (!path || path.includes('\0')) return refuse('invalid');

  const real = await realOrNull(path);
  if (!real) return refuse('not_found');
  const roots = (await Promise.all([cwd, tmpdir(), '/tmp'].map(realOrNull))).filter((r): r is string => !!r);
  if (!roots.some(root => within(real, root))) return refuse('outside_roots');

  const declared = MIME_BY_EXT[extname(real).toLowerCase()];
  if (!declared) return refuse('not_image');
  let info;
  try { info = await stat(real); } catch { return refuse('not_found'); }
  if (!info.isFile()) return refuse('not_image');
  if (info.size > MAX_IMAGE_BYTES) return refuse('too_large');

  let bytes: Buffer;
  try { bytes = await readFile(real); } catch { return refuse('not_found'); }
  // The size was checked before reading; a file that grew in between is
  // still refused rather than sent.
  if (bytes.length > MAX_IMAGE_BYTES) return refuse('too_large');
  const actual = sniffImage(bytes);
  // The name must say image AND the bytes must agree on being one. A .jpg
  // that is really a PNG is still a picture, so the bytes' own type wins.
  if (!actual) return refuse('not_image');
  return { ok: true, dataUrl: `data:${actual};base64,${bytes.toString('base64')}` };
}
