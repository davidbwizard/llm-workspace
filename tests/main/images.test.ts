import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { readSessionImage, within, MAX_IMAGE_BYTES } from '../../src/main/images.ts';

// A 1x1 PNG, and the leading bytes of the other accepted formats.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

// The session folder lives under the home directory, deliberately NOT under
// the temp folders, so "inside the session" and "inside temp" are tested as
// separate roots.
let project: string;
let outside: string;
let inTemp: string;
const cwdFor = (id: string) => (id === 's1' ? project : null);

beforeAll(() => {
  const base = mkdtempSync(join(homedir(), '.llmws-images-test-'));
  project = join(base, 'project');
  outside = join(base, 'outside');
  mkdirSync(join(project, 'shots'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, 'shots', 'a.png'), PNG);
  writeFileSync(join(project, 'b.jpg'), JPEG);
  writeFileSync(join(project, 'c.gif'), GIF);
  writeFileSync(join(project, 'd.webp'), WEBP);
  writeFileSync(join(project, 'fake.png'), 'not an image at all');
  writeFileSync(join(project, 'notes.txt'), 'hello');
  writeFileSync(join(project, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(project, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
  writeFileSync(join(outside, 'secret.png'), PNG);
  symlinkSync(join(outside, 'secret.png'), join(project, 'escape.png'));
  inTemp = mkdtempSync(join(tmpdir(), 'llmws-img-'));
  writeFileSync(join(inTemp, 'shot.png'), PNG);
});

afterAll(() => {
  rmSync(join(project, '..'), { recursive: true, force: true });
  rmSync(inTemp, { recursive: true, force: true });
});

const read = (src: unknown, sessionId: unknown = 's1') => readSessionImage(sessionId, src, { cwdFor });

describe('readSessionImage', () => {
  it('returns an image inside the session folder as a data URL, by relative path', async () => {
    const r = await read('shots/a.png');
    expect(r).toEqual({ ok: true, dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
  });

  it('accepts an absolute path, a ./ path and a file:// URL to the same file', async () => {
    for (const src of [join(project, 'shots', 'a.png'), './shots/a.png', `file://${join(project, 'shots', 'a.png')}`]) {
      expect((await read(src)).ok, src).toBe(true);
    }
  });

  it('decodes a percent-encoded path', async () => {
    writeFileSync(join(project, 'with space.png'), PNG);
    expect((await read('with%20space.png')).ok).toBe(true);
  });

  it('labels each accepted format by its bytes', async () => {
    expect(await read('b.jpg')).toMatchObject({ ok: true, dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) });
    expect(await read('c.gif')).toMatchObject({ ok: true, dataUrl: expect.stringMatching(/^data:image\/gif;base64,/) });
    expect(await read('d.webp')).toMatchObject({ ok: true, dataUrl: expect.stringMatching(/^data:image\/webp;base64,/) });
  });

  it('allows the temp folders, where agents write screenshots', async () => {
    expect((await read(join(inTemp, 'shot.png'))).ok).toBe(true);
  });

  it('refuses a file outside the session folder and temp', async () => {
    expect(await read(join(outside, 'secret.png'))).toEqual({ ok: false, reason: 'outside_roots' });
    expect(await read('../outside/secret.png')).toEqual({ ok: false, reason: 'outside_roots' });
  });

  it('follows a symlink to where it really points before deciding', async () => {
    expect(await read('escape.png')).toEqual({ ok: false, reason: 'outside_roots' });
  });

  it('refuses a file whose name says image but whose bytes do not', async () => {
    expect(await read('fake.png')).toEqual({ ok: false, reason: 'not_image' });
  });

  it('refuses other types, SVG included', async () => {
    expect(await read('notes.txt')).toEqual({ ok: false, reason: 'not_image' });
    expect(await read('vector.svg')).toEqual({ ok: false, reason: 'not_image' });
  });

  it('refuses an image over the size cap without reading it', async () => {
    expect(await read('big.png')).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reports a missing file, and a folder, as not found', async () => {
    expect(await read('nope.png')).toEqual({ ok: false, reason: 'not_found' });
    expect(await read('shots')).toEqual({ ok: false, reason: 'not_image' });
  });

  it('never fetches: web and other URL schemes are refused', async () => {
    for (const src of ['https://example.com/a.png', 'http://x/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)']) {
      expect(await read(src), src).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses an unknown session, and malformed input', async () => {
    expect(await read('shots/a.png', 'other')).toEqual({ ok: false, reason: 'no_session' });
    expect(await read(42)).toEqual({ ok: false, reason: 'invalid' });
    expect(await read('shots/a.png', 7)).toEqual({ ok: false, reason: 'invalid' });
    expect(await read('')).toEqual({ ok: false, reason: 'invalid' });
    expect(await read('a\0.png')).toEqual({ ok: false, reason: 'invalid' });
    expect(await read('x'.repeat(5000))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('expands ~ to the home directory, still subject to the roots', async () => {
    const rel = realpathSync(join(project, 'shots', 'a.png')).slice(realpathSync(homedir()).length);
    expect((await read(`~${rel}`)).ok).toBe(true);
  });
});

// `within` used to be shared with the file viewer, which is why these lived
// in tests/main/files.test.ts. That viewer dropped its containment check on
// 2026-09-22 (see src/main/files.ts's header), so the function is now
// images.ts's own -- used here and by src/main/attachments.ts -- and the
// tests moved with it rather than being deleted along with the caller.
describe('within: the separator-aware containment check', () => {
  // The reason this is not `real.startsWith(root)`. A naive prefix test
  // passes /foo/barbaz as inside /foo/bar, which is a different directory.
  it('refuses a sibling whose name merely starts with the root', () => {
    expect('/foo/barbaz'.startsWith('/foo/bar')).toBe(true);
    expect(within('/foo/barbaz', '/foo/bar')).toBe(false);
    expect(within(`/foo/barbaz${sep}x.md`, '/foo/bar')).toBe(false);
  });

  it('accepts the root itself and anything genuinely under it', () => {
    expect(within('/foo/bar', '/foo/bar')).toBe(true);
    expect(within(`/foo/bar${sep}x.md`, '/foo/bar')).toBe(true);
    expect(within(`/foo/bar${sep}a${sep}b.md`, '/foo/bar')).toBe(true);
  });
});
