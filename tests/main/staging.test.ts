import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStager, MAX_STAGED } from '../../src/main/staging.ts';
import { MAX_IMAGE_BYTES } from '../../src/main/images.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'llmws-stage-')); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('createStager', () => {
  it('writes an image under a generated name, private to this user, and maps an id to it', async () => {
    const stager = createStager(join(base, 'att'));
    const r = await stager.stage(new Uint8Array(PNG));
    expect(r.ok).toBe(true);
    const path = r.ok ? stager.pathFor(r.id) : null;
    expect(path).toMatch(/\/[0-9a-f-]{36}\.png$/);
    expect(readFileSync(path!)).toEqual(PNG);
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);
  });

  it('names the file by what the bytes are, and accepts an ArrayBuffer too', async () => {
    const stager = createStager(join(base, 'att'));
    const r = await stager.stage(JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length));
    expect(r.ok && stager.pathFor(r.id)).toMatch(/\.jpg$/);
  });

  it('refuses anything that is not a real PNG, JPEG, GIF or WebP', async () => {
    const stager = createStager(join(base, 'att'));
    expect(await stager.stage(new Uint8Array(Buffer.from('<svg/>')))).toEqual({ ok: false, reason: 'not_image' });
    expect(await stager.stage(new Uint8Array(0))).toEqual({ ok: false, reason: 'not_image' });
  });

  it('refuses an image over the size cap, and input that is not bytes', async () => {
    const stager = createStager(join(base, 'att'));
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1); big.set(PNG);
    expect(await stager.stage(big)).toEqual({ ok: false, reason: 'too_large' });
    for (const bad of ['png', 42, null, { length: 3 }, [1, 2, 3]]) {
      expect(await stager.stage(bad), String(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('knows only ids it issued', async () => {
    const stager = createStager(join(base, 'att'));
    expect(stager.pathFor('nope')).toBeNull();
    expect(stager.pathFor(7)).toBeNull();
    expect(stager.pathFor('../../etc/passwd')).toBeNull();
  });

  it('keeps at most MAX_STAGED images, deleting the oldest file as it goes', async () => {
    const stager = createStager(join(base, 'att'));
    const first = await stager.stage(new Uint8Array(PNG));
    const firstPath = first.ok ? stager.pathFor(first.id) : null;
    for (let i = 0; i < MAX_STAGED; i++) await stager.stage(new Uint8Array(PNG));
    expect(first.ok && stager.pathFor(first.id)).toBeNull();
    expect(existsSync(firstPath!)).toBe(false);
    expect(readdirSync(join(base, 'att'))).toHaveLength(MAX_STAGED);
  });

  it('sweeps files older than a day left by an earlier run', async () => {
    const dir = join(base, 'att');
    const stager = createStager(dir);
    await stager.stage(new Uint8Array(PNG));          // creates the folder
    const old = join(dir, 'left-over.png');
    writeFileSync(old, PNG);
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    const fresh = join(dir, 'recent.png');
    writeFileSync(fresh, PNG);
    await stager.sweep();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
