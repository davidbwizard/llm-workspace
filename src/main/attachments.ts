// Images a person attached to a Claude prompt, for the conversation pane.
//
// Claude Code writes an attached image into the transcript itself, as a
// base64 block beside the prompt's text (which carries an "[Image #N]"
// placeholder). The index keeps only the text, so the pixels are read back
// on demand: every event row already records the transcript file and the
// byte offset of its line. Main looks those up by the turn's id -- the
// renderer never supplies a path -- confirms the file is under Claude's
// projects folder, reads that one line (capped), and returns each inline
// PNG, JPEG, GIF or WebP whose bytes agree, up to MAX_ATTACHMENTS.
import { open, realpath, stat } from 'node:fs/promises';
import { MAX_IMAGE_BYTES, sniffImage, within } from './images.ts';

export const MAX_ATTACHMENTS = 20;
/** One prompt line with its images inline; beyond this it is not read. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type TurnSource = {
  provider: string; kind: string; agentId: string | null; sourceFile: string; sourceOffset: number;
};
export type AttachmentRefusal = 'invalid' | 'not_found' | 'outside_roots' | 'unreadable' | 'too_large';
export type AttachmentResult = { ok: true; images: string[] } | { ok: false; reason: AttachmentRefusal };

type Deps = {
  /** The turn's event row, from main's own index, or null. */
  sourceFor: (turnId: number) => TurnSource | null;
  /** Claude's projects folder (~/.claude/projects). */
  projectsRoot: string;
};

const refuse = (reason: AttachmentRefusal): AttachmentResult => ({ ok: false, reason });

async function realOrNull(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

/** The bytes from `offset` up to (not including) the next newline, or to
 *  EOF. 'too_large' past MAX_LINE_BYTES; null if the offset is past the end. */
async function readLine(file: string, offset: number): Promise<Buffer | 'too_large' | null> {
  const size = (await stat(file)).size;
  if (offset >= size) return null;
  const fh = await open(file, 'r');
  try {
    const parts: Buffer[] = [];
    let pos = offset, total = 0;
    const chunk = Buffer.alloc(256 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (bytesRead === 0) break;
      const nl = chunk.subarray(0, bytesRead).indexOf(0x0a);
      const take = nl === -1 ? bytesRead : nl;
      total += take;
      if (total > MAX_LINE_BYTES) return 'too_large';
      parts.push(Buffer.from(chunk.subarray(0, take)));
      if (nl !== -1) break;
      pos += bytesRead;
    }
    return Buffer.concat(parts);
  } finally {
    await fh.close();
  }
}

export async function readTurnImages(turnId: unknown, deps: Deps): Promise<AttachmentResult> {
  if (typeof turnId !== 'number' || !Number.isInteger(turnId) || turnId <= 0) return refuse('invalid');
  const src = deps.sourceFor(turnId);
  if (!src) return refuse('not_found');
  // Only what a person typed into a top-level Claude session: subagent
  // prompts and tool results can carry images too, but they are not "yours".
  if (src.provider !== 'claude' || src.kind !== 'prompt.submitted' || src.agentId !== null) return refuse('invalid');
  if (!Number.isInteger(src.sourceOffset) || src.sourceOffset < 0) return refuse('invalid');

  const [file, root] = await Promise.all([realOrNull(src.sourceFile), realOrNull(deps.projectsRoot)]);
  if (!file) return refuse('not_found');
  if (!root || !within(file, root)) return refuse('outside_roots');

  let raw: Buffer | 'too_large' | null;
  try { raw = await readLine(file, src.sourceOffset); } catch { return refuse('not_found'); }
  if (raw === null) return refuse('not_found');
  if (raw === 'too_large') return refuse('too_large');

  let record: unknown;
  try { record = JSON.parse(raw.toString('utf8')); } catch { return refuse('unreadable'); }
  const content = (record as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return { ok: true, images: [] };

  const images: string[] = [];
  for (const block of content) {
    if (images.length >= MAX_ATTACHMENTS) break;
    const source = (block as { type?: unknown; source?: Record<string, unknown> })?.type === 'image'
      ? (block as { source?: Record<string, unknown> }).source : undefined;
    if (!source || source.type !== 'base64' || typeof source.data !== 'string') continue;
    if (typeof source.media_type !== 'string' || !ALLOWED.has(source.media_type)) continue;
    if (source.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) continue;
    const bytes = Buffer.from(source.data, 'base64');
    const actual = sniffImage(bytes);
    if (!actual) continue;
    images.push(`data:${actual};base64,${bytes.toString('base64')}`);
  }
  return { ok: true, images };
}
