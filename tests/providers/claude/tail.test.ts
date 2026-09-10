import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTail } from '../../../src/providers/claude/tail.ts';

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tail-')); file = join(dir, 'f.jsonl'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readTail', () => {
  it('reads whole lines and reports the offset after the last complete line', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const r = readTail(file, 0, null);
    expect(r.lines.map(l => l.text)).toEqual(['{"a":1}', '{"a":2}']);
    expect(r.newOffset).toBe(16);
    expect(r.restarted).toBe(false);
  });

  it('reports the byte offset of each line, for the identity triple', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const r = readTail(file, 0, null);
    expect(r.lines.map(l => l.offset)).toEqual([0, 8]);
  });

  it('reads only the tail on a second call', () => {
    writeFileSync(file, '{"a":1}\n');
    const first = readTail(file, 0, null);
    appendFileSync(file, '{"a":2}\n');
    const second = readTail(file, first.newOffset, first.inode);
    expect(second.lines.map(l => l.text)).toEqual(['{"a":2}']);
    expect(second.lines[0]!.offset).toBe(8);
  });

  it('buffers a trailing partial line instead of treating it as corrupt', () => {
    writeFileSync(file, '{"a":1}\n{"partial"');
    const r = readTail(file, 0, null);
    expect(r.lines.map(l => l.text)).toEqual(['{"a":1}']);
    expect(r.newOffset).toBe(8);
  });

  it('restarts from zero when the file shrinks', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const first = readTail(file, 0, null);
    writeFileSync(file, '{"b":1}\n');
    const second = readTail(file, first.newOffset, first.inode);
    expect(second.restarted).toBe(true);
    expect(second.lines.map(l => l.text)).toEqual(['{"b":1}']);
  });

  it('restarts from zero when the inode changes', () => {
    writeFileSync(file, '{"a":1}\n');
    const first = readTail(file, 0, null);
    rmSync(file);
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const second = readTail(file, first.newOffset, first.inode);
    expect(second.restarted).toBe(true);
    expect(second.lines).toHaveLength(2);
  });

  it('does not corrupt a multi-byte character split across chunk boundaries', () => {
    // Forces the emoji to straddle a chunk edge. Naive Buffer.toString('utf8')
    // per chunk yields U+FFFD and inflates the byte count, shifting offsets.
    writeFileSync(file, '{"a":"café 🌟"}\n{"b":2}\n');
    const r = readTail(file, 0, null, 13);
    expect(r.lines.map(l => l.text)).toEqual(['{"a":"café 🌟"}', '{"b":2}']);
    expect(() => r.lines.map(l => JSON.parse(l.text))).not.toThrow();
    expect(r.newOffset).toBe(statSync(file).size);
  });

  it('reports correct byte offsets after a multi-byte character', () => {
    writeFileSync(file, '{"a":"🌟"}\n{"b":2}\n');
    const r = readTail(file, 0, null, 7);
    const firstLen = Buffer.byteLength('{"a":"🌟"}', 'utf8') + 1;
    expect(r.lines[1]!.offset).toBe(firstLen);
  });

  it('returns nothing for an empty file', () => {
    writeFileSync(file, '');
    const r = readTail(file, 0, null);
    expect(r.lines).toEqual([]);
    expect(r.newOffset).toBe(0);
  });
});
