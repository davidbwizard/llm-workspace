import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLetterId, mailPaths, newLetterId, writeFileAtomic } from '../../src/mail/files.ts';

describe('mail files', () => {
  it('makes ids that pass its own check, and rejects path-like ids', () => {
    const id = newLetterId();
    expect(isLetterId(id)).toBe(true);
    expect(newLetterId()).not.toBe(id);
    for (const bad of ['../x', `${id}/..`, id.toUpperCase(), id.slice(1), 42, null]) expect(isLetterId(bad)).toBe(false);
  });

  it('writes atomically with owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-'));
    const file = join(dir, 'out', 'a.json');
    writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'out')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, 'out'))).toEqual(['a.json']);
  });

  it('lays out the mail folder', () => {
    expect(mailPaths('/m')).toEqual({
      dir: '/m', inbox: '/m/inbox', out: '/m/out', work: '/m/work',
      config: '/m/config.json', letters: '/m/letters',
    });
  });
});
