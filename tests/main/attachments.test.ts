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
  readTurnImages(id, { sourceFor: () => src, roots: { claude: root, codex: join(root, '..', 'codex-sessions') } });

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

  it('refuses anything that is not a top-level prompt from a known provider', async () => {
    expect(await read(7, { ...prompt(offsets.two!), kind: 'prose' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await read(7, { ...prompt(offsets.two!), provider: 'gemini' })).toEqual({ ok: false, reason: 'invalid' });
    // A Codex row must point into Codex's own folder, not Claude's.
    expect(await read(7, { ...prompt(offsets.two!), provider: 'codex' })).toEqual({ ok: false, reason: 'outside_roots' });
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

describe('readTurnImages -- Codex', () => {
  // Codex indexes a prompt at its item_completed record, which names an
  // attached image only by path. The pixels are inline in the same turn's
  // response_item user message, written earlier in the file.
  let codexRoot: string;
  let rollout: string;
  const at: Record<string, number> = {};
  const url = (b: Buffer, media = 'image/png') => `data:${media};base64,${b.toString('base64')}`;
  const rec = (type: string, payload: unknown) => JSON.stringify({ timestamp: 't', type, payload }) + '\n';
  const started = (turn: string) => rec('event_msg', { type: 'task_started', turn_id: turn });
  const userMsg = (...content: unknown[]) => rec('response_item', { type: 'message', role: 'user', content });
  const completed = (turn: string) => rec('event_msg', { type: 'item_completed', turn_id: turn,
    item: { type: 'UserMessage', content: [{ type: 'local_image', path: '/gone.png' }, { type: 'text', text: '[Image #1] hi' }] } });

  beforeAll(() => {
    codexRoot = join(root, '..', 'codex-sessions');
    mkdirSync(join(codexRoot, '2026'), { recursive: true });
    rollout = join(codexRoot, '2026', 'rollout-x.jsonl');
    const lines: Array<[string, string]> = [
      ['t0start', started('T0')],
      ['t0msg', userMsg({ type: 'input_image', image_url: url(PNG) })],   // an EARLIER turn's image
      ['t0done', completed('T0')],
      ['t1start', started('T1')],
      ['t1ctx', rec('turn_context', { turn_id: 'T1' })],
      ['t1msg', userMsg({ type: 'input_text', text: '' }, { type: 'input_image', image_url: url(PNG) },
        { type: 'input_image', image_url: url(Buffer.from('<svg/>'), 'image/svg+xml') },
        { type: 'input_image', image_url: 'https://example.com/a.png' },
        { type: 'input_image', image_url: url(Buffer.from('not png')) },
        { type: 'input_text', text: '' })],
      ['t1done', completed('T1')],
      ['t2start', started('T2')],
      ['t2msg', userMsg({ type: 'input_text', text: 'no images' })],
      ['t2done', completed('T2')],
      ['t3start', started('T3')],
      ['t3done', completed('T3')],     // no user message of its own in the turn
    ];
    let o = 0, body = '';
    for (const [name, text] of lines) { at[name] = o; o += Buffer.byteLength(text); body += text; }
    writeFileSync(rollout, body);
  });

  const codex = (sourceOffset: number, sourceFile = rollout): TurnSource =>
    ({ provider: 'codex', kind: 'prompt.submitted', agentId: null, sourceFile, sourceOffset });
  const readCodex = (src: TurnSource) =>
    readTurnImages(9, { sourceFor: () => src, roots: { claude: root, codex: codexRoot } });

  it("returns the turn's inline images, skipping any that are not real pictures", async () => {
    expect(await readCodex(codex(at.t1done!))).toEqual({ ok: true, images: [url(PNG)] });
  });

  it("never reaches back into an earlier turn's images", async () => {
    expect(await readCodex(codex(at.t2done!))).toEqual({ ok: true, images: [] });
    expect(await readCodex(codex(at.t3done!))).toEqual({ ok: true, images: [] });
  });

  it('reads a user message indexed at its own line too', async () => {
    expect(await readCodex(codex(at.t0msg!))).toEqual({ ok: true, images: [url(PNG)] });
  });

  it('requires the rollout to be under the Codex sessions folder', async () => {
    expect(await readCodex(codex(at.two ?? 0, transcript))).toEqual({ ok: false, reason: 'outside_roots' });
  });
});
