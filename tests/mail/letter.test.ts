import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLetter } from '../../src/mail/letter.ts';

const NOW = Date.parse('2026-09-28T18:00:00Z');
const SPECIALISTS = ['codex-reviewer', 'claude-reviewer'];
let project: string;

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'mail-project-')));
  mkdirSync(join(project, 'docs'));
  mkdirSync(join(project, '.git'));
  writeFileSync(join(project, 'docs/spec.md'), 'spec v1');
  writeFileSync(join(project, '.env'), 'SECRET=1');
  writeFileSync(join(project, '.git/config'), '[core]');
  writeFileSync(join(project, 'big.md'), 'x'.repeat(200_001));
  symlinkSync('/etc/hosts', join(project, 'hosts-link'));
});

const letter = (over: Record<string, unknown> = {}) => ({
  version: 1, id: 'a'.repeat(32), from: { tool: 'claude', project }, to: 'codex-reviewer',
  subject: 'Review the spec', body: 'Please review.', attachments: ['docs/spec.md'], re: null,
  sentAt: new Date(NOW - 1000).toISOString(), ...over,
});
const reason = (over: Record<string, unknown>) => {
  const r = checkLetter(letter(over), NOW, SPECIALISTS);
  return r.ok ? null : r.reason;
};

describe('checkLetter', () => {
  it('accepts a good letter and fingerprints its attachment', () => {
    expect(checkLetter(letter(), NOW, SPECIALISTS)).toEqual({
      ok: true,
      letter: expect.objectContaining({ id: 'a'.repeat(32), from: { tool: 'claude', project }, attachments: ['docs/spec.md'] }),
      attachments: [{ path: 'docs/spec.md', sha256: createHash('sha256').update('spec v1').digest('hex'), bytes: 7 }],
    });
  });

  it('refuses malformed letters', () => {
    expect(checkLetter(null, NOW, SPECIALISTS)).toEqual({ ok: false, reason: 'letter is not a JSON object' });
    const wrong = 'letter is missing fields or has the wrong types';
    expect(reason({ id: '../../etc' })).toBe(wrong);
    expect(reason({ re: 'nope' })).toBe(wrong);
    expect(reason({ from: { tool: 'gemini', project } })).toBe(wrong);
    expect(reason({ from: { tool: 'claude', project: 'relative/path' } })).toBe(wrong);
  });

  it('refuses expired, oversized and misaddressed letters', () => {
    expect(reason({ sentAt: new Date(NOW - 11 * 60_000).toISOString() })).toBe('expired: sent more than 10 minutes ago');
    expect(reason({ to: 'poet' })).toBe('unknown specialist "poet"; known: codex-reviewer, claude-reviewer');
    expect(reason({ subject: 's'.repeat(201) })).toBe('subject is over 200 characters');
    expect(reason({ body: 'b'.repeat(20_001) })).toBe('body is over 20 KB');
    expect(reason({ attachments: Array(6).fill('docs/spec.md') })).toBe('more than 5 attachments');
    expect(reason({ from: { tool: 'claude', project: join(project, 'missing') } })).toBe('project folder not found (ENOENT)');
  });

  it('keeps attachments inside the project and away from secrets', () => {
    expect(reason({ attachments: ['/etc/hosts'] })).toBe(`attachment is outside the project ${project}: /etc/hosts`);
    expect(reason({ attachments: ['hosts-link'] })).toBe(`attachment is outside the project ${project}: hosts-link`);
    expect(reason({ attachments: ['.env'] })).toBe('attachment looks like a secret: .env');
    expect(reason({ attachments: ['.git/config'] })).toBe('attachment looks like a secret: .git/config');
    expect(reason({ attachments: ['docs'] })).toBe('attachment is not a file: docs');
    expect(reason({ attachments: ['big.md'] })).toBe('attachment is over 200 KB: big.md');
    expect(reason({ attachments: ['nope.md'] })).toBe('attachment not found: nope.md (ENOENT)');
  });

  it('refuses an unreadable attachment instead of throwing', () => {
    const locked = join(project, 'locked.md');
    writeFileSync(locked, 'locked');
    chmodSync(locked, 0o000);
    try {
      expect(reason({ attachments: ['locked.md'] })).toBe('attachment cannot be read: locked.md (EACCES)');
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it('refuses the home folder or the disk root as a project', () => {
    const why = 'project is the home folder or the disk root; start the agent in a project folder';
    expect(reason({ from: { tool: 'claude', project: homedir() }, attachments: [] })).toBe(why);
    expect(reason({ from: { tool: 'claude', project: '/' }, attachments: [] })).toBe(why);
  });
});
