import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTurnImages, MAX_ATTACHMENTS, type TurnSource } from '../../src/main/attachments.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const b64 = (b: Buffer) => b.toString('base64');
const img = (data: string, media = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: media, data } });
const line = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';

let root: string;           // stands in for ~/.claude/projects
let transcript: string;
const offsets: Record<string, number> = {};
let outsideFile: string;

beforeAll(() => {
  const base = mkdtempSync(join(homedir(), '.llmws-attach-test-'));
  root = join(base, 'projects');
  mkdirSync(join(root, 'proj'), { recursive: true });
  transcript = join(root, 'proj', 's1.jsonl');
  const lines: Array<[string, string]> = [
    ['plain', line('just text')],
    ['two', line([{ type: 'text', text: '[Image #1] [Image #2] look' }, img(b64(PNG)), img(b64(PNG))])],
    ['svg', line([{ type: 'text', text: '[Image #1]' }, img(b64(Buffer.from('<svg/>')), 'image/svg+xml')])],
    ['liar', line([{ type: 'text', text: '[Image #1]' }, img(b64(Buffer.from('not a png')))])],
    ['url', line([{ type: 'text', text: '[Image #1]' }, { type: 'image', source: { type: 'url', url: 'https://x/a.png' } }])],
    ['many', line([{ type: 'text', text: 'x' }, ...Array.from({ length: MAX_ATTACHMENTS + 5 }, () => img(b64(PNG)))])],
    ['nested', line([{ type: 'tool_result', content: [img(b64(PNG))] }])],
  ];
  let at = 0, body = '';
  for (const [name, text] of lines) { offsets[name] = at; at += Buffer.byteLength(text); body += text; }
  writeFileSync(transcript, body + '{"not":"terminated"');
  offsets.unterminated = at;
  outsideFile = join(base, 'elsewhere.jsonl');
  writeFileSync(outsideFile, line([{ type: 'text', text: '[Image #1]' }, img(b64(PNG))]));
  symlinkSync(outsideFile, join(root, 'proj', 'link.jsonl'));
});

afterAll(() => rmSync(join(root, '..'), { recursive: true, force: true }));

const prompt = (sourceOffset: number, sourceFile = transcript): TurnSource =>
  ({ provider: 'claude', kind: 'prompt.submitted', agentId: null, sourceFile, sourceOffset });
const read = (id: unknown, src: TurnSource | null) =>
  readTurnImages(id, { sourceFor: () => src, projectsRoot: root });

describe('readTurnImages', () => {
  it('returns every attached image on the line, in order, as data URLs', async () => {
    const r = await read(7, prompt(offsets.two!));
    expect(r).toEqual({ ok: true, images: [`data:image/png;base64,${b64(PNG)}`, `data:image/png;base64,${b64(PNG)}`] });
  });

  it('returns no images for a message that has none', async () => {
    expect(await read(7, prompt(offsets.plain!))).toEqual({ ok: true, images: [] });
  });

  it('skips blocks that are not a real PNG, JPEG, GIF or WebP, or are not inline', async () => {
    expect(await read(7, prompt(offsets.svg!))).toEqual({ ok: true, images: [] });
    expect(await read(7, prompt(offsets.liar!))).toEqual({ ok: true, images: [] });
    expect(await read(7, prompt(offsets.url!))).toEqual({ ok: true, images: [] });
  });

  it('ignores images nested in tool results -- only what the person attached', async () => {
    expect(await read(7, prompt(offsets.nested!))).toEqual({ ok: true, images: [] });
  });

  it('caps how many images one message can return', async () => {
    const r = await read(7, prompt(offsets.many!));
    expect(r.ok && r.images.length).toBe(MAX_ATTACHMENTS);
  });

  it('refuses anything that is not a top-level Claude prompt', async () => {
    expect(await read(7, { ...prompt(offsets.two!), kind: 'prose' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await read(7, { ...prompt(offsets.two!), provider: 'codex' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await read(7, { ...prompt(offsets.two!), agentId: 'sub' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await read(7, null)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses a transcript outside the projects folder, symlinked or not', async () => {
    expect(await read(7, prompt(0, outsideFile))).toEqual({ ok: false, reason: 'outside_roots' });
    expect(await read(7, prompt(0, join(root, 'proj', 'link.jsonl')))).toEqual({ ok: false, reason: 'outside_roots' });
  });

  it('reports a missing file, an offset past the end, and a line that is not JSON', async () => {
    expect(await read(7, prompt(0, join(root, 'proj', 'gone.jsonl')))).toEqual({ ok: false, reason: 'not_found' });
    expect(await read(7, prompt(10_000_000))).toEqual({ ok: false, reason: 'not_found' });
    expect(await read(7, prompt(offsets.two! + 5))).toEqual({ ok: false, reason: 'unreadable' });
    expect(await read(7, prompt(offsets.unterminated!))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses malformed ids', async () => {
    for (const id of ['7', 0, -1, 1.5, null, Number.NaN]) {
      expect(await read(id, prompt(offsets.two!)), String(id)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});
