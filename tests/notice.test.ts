import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

describe('NOTICE', () => {
  it('exists', () => {
    expect(existsSync('NOTICE')).toBe(true);
  });

  it('carries the upstream MIT copyright line verbatim', () => {
    const notice = readFileSync('NOTICE', 'utf8');
    expect(notice).toContain('Copyright (c) 2026 Chaitanya Giri');
    expect(notice).toContain('MIT');
    expect(notice).toContain('munder-difflin');
  });

  it('lists every source file that carries harvested code', () => {
    const notice = readFileSync('NOTICE', 'utf8');
    const hits = execFileSync('grep', ['-rl', 'harvested', 'src'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(hits.length).toBeGreaterThan(0);
    for (const file of hits) expect(notice).toContain(file);
  });
});
