// Images a person attached to a prompt, for the conversation pane.
//
// Codex is handled the same way with one difference: the line its prompt is
// indexed at (an item_completed record) names an attached image only by
// path, and that path is often a temp file that will not last. The pixels
// are inline in the same turn's response_item user message, written just
// before it, so main reads backwards to that message -- stopping at the
// turn's own task_started, so an earlier turn's image can never be taken.
//
// Claude Code writes an attached image into the transcript itself, as a
// base64 block beside the prompt's text (which carries an "[Image #N]"
// placeholder). The index keeps only the text, so the pixels are read back
// on demand: every event row already records the transcript file and the
// byte offset of its line. Main looks those up by the turn's id -- the
// renderer never supplies a path -- confirms the file is under Claude's
// projects folder, reads that one line (capped), and returns each inline
// PNG, JPEG, GIF or WebP whose bytes agree, up to MAX_ATTACHMENTS.
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { MAX_IMAGE_BYTES, sniffImage, within } from './images.ts';

export const MAX_ATTACHMENTS = 20;
/** One prompt line with its images inline; beyond this it is not read. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** How far back a Codex prompt may look for its turn's inline images. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_LINES = 200;
const CHUNK = 256 * 1024;

export type TurnSource = {
  provider: string; kind: string; agentId: string | null; sourceFile: string; sourceOffset: number;
};
export type AttachmentRefusal = 'invalid' | 'not_found' | 'outside_roots' | 'unreadable' | 'too_large';
export type AttachmentResult = { ok: true; images: string[] } | { ok: false; reason: AttachmentRefusal };

type Deps = {
  /** The turn's event row, from main's own index, or null. */
  sourceFor: (turnId: number) => TurnSource | null;
  /** Where each provider's transcripts live: ~/.claude/projects and
   *  ~/.codex/sessions. A file outside its provider's folder is refused. */
  roots: { claude: string; codex: string };
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
  // Only what a person typed into a top-level session: subagent prompts and
  // tool results can carry images too, but they are not "yours".
  if ((src.provider !== 'claude' && src.provider !== 'codex')
    || src.kind !== 'prompt.submitted' || src.agentId !== null) return refuse('invalid');
  if (!Number.isInteger(src.sourceOffset) || src.sourceOffset < 0) return refuse('invalid');

  const [file, root] = await Promise.all([realOrNull(src.sourceFile), realOrNull(deps.roots[src.provider])]);
  if (!file) return refuse('not_found');
  if (!root || !within(file, root)) return refuse('outside_roots');

  let raw: Buffer | 'too_large' | null;
  try { raw = await readLine(file, src.sourceOffset); } catch { return refuse('not_found'); }
  if (raw === null) return refuse('not_found');
  if (raw === 'too_large') return refuse('too_large');

  let record: unknown;
  try { record = JSON.parse(raw.toString('utf8')); } catch { return refuse('unreadable'); }
  if (src.provider === 'codex') return { ok: true, images: await codexImagesFor(file, src.sourceOffset, record) };
  const content = (record as { message?: { content?: unknown } } | null)?.message?.content;
  return { ok: true, images: Array.isArray(content) ? claudeImages(content) : [] };
}

/** Bytes that really are one of the accepted formats, as a data: URL. */
function toDataUrl(declared: unknown, base64: unknown): string | null {
  if (typeof declared !== 'string' || !ALLOWED.has(declared)) return null;
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(base64, 'base64');
  const actual = sniffImage(bytes);
  return actual ? `data:${actual};base64,${bytes.toString('base64')}` : null;
}

function claudeImages(content: unknown[]): string[] {
  const images: string[] = [];
  for (const block of content) {
    if (images.length >= MAX_ATTACHMENTS) break;
    const b = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null;
    if (b?.type !== 'image' || b.source?.type !== 'base64') continue;
    const u = toDataUrl(b.source.media_type, b.source.data);
    if (u) images.push(u);
  }
  return images;
}

const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/;

function codexImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const images: string[] = [];
  for (const block of content) {
    if (images.length >= MAX_ATTACHMENTS) break;
    const b = block as { type?: unknown; image_url?: unknown } | null;
    if (b?.type !== 'input_image' || typeof b.image_url !== 'string') continue;
    const m = DATA_URL.exec(b.image_url);
    const u = m ? toDataUrl(m[1], m[2]) : null;
    if (u) images.push(u);
  }
  return images;
}

type CodexRecord = { type?: unknown; payload?: { type?: unknown; role?: unknown; turn_id?: unknown; content?: unknown } } | null;
const isCodexUserMessage = (r: CodexRecord) =>
  r?.type === 'response_item' && r.payload?.type === 'message' && r.payload?.role === 'user';

async function codexImagesFor(file: string, offset: number, indexed: unknown): Promise<string[]> {
  const rec = indexed as CodexRecord;
  if (isCodexUserMessage(rec)) return codexImages(rec!.payload!.content);
  const turn = rec?.payload?.turn_id;
  if (typeof turn !== 'string') return [];
  const fh = await open(file, 'r');
  try {
    let lines = 0;
    for await (const line of linesBackward(fh, offset)) {
      if (++lines > MAX_SCAN_LINES) break;
      let r: CodexRecord;
      try { r = JSON.parse(line.toString('utf8')) as CodexRecord; } catch { continue; }
      if (r?.type === 'event_msg' && r.payload?.type === 'task_started' && r.payload?.turn_id === turn) break;
      if (isCodexUserMessage(r)) return codexImages(r!.payload!.content);
    }
    return [];
  } finally {
    await fh.close();
  }
}

/** The file's lines ending before `end`, nearest first, within
 *  MAX_SCAN_BYTES. A long line is gathered from its pieces and joined once. */
async function* linesBackward(fh: FileHandle, end: number): AsyncGenerator<Buffer> {
  let pos = end;
  let parts: Buffer[] = [];   // the line being assembled, in file order
  while (pos > 0 && end - pos < MAX_SCAN_BYTES) {
    const size = Math.min(CHUNK, pos);
    pos -= size;
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, pos);
    let stop = bytesRead;
    for (let i = bytesRead - 1; i >= 0; i--) {
      if (buf[i] !== 0x0a) continue;
      const line = Buffer.concat([buf.subarray(i + 1, stop), ...parts]);
      parts = [];
      stop = i;
      if (line.length > 0) yield line;
    }
    if (stop > 0) parts.unshift(Buffer.from(buf.subarray(0, stop)));
  }
  if (pos === 0 && parts.length > 0) yield Buffer.concat(parts);
}
