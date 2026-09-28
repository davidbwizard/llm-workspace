import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cancelOrphans, createLoop, getLetter, getLoop, insertLetter, latestPass, letterExists, lettersInLast24h,
  openMailLog, updateLetter, updateLoop, type MailDb, type NewLetter,
} from '../../src/mail/log.ts';

const NOW = 1_000_000_000_000;
let db: MailDb;

beforeEach(() => {
  db = openMailLog(':memory:');
  createLoop(db, { id: 'L', specialist: 'codex-reviewer', project: '/p', fromTool: 'claude', status: 'open', passes: 1 }, NOW);
});
afterEach(() => { db.close(); });

const row = (id: string, over: Partial<NewLetter> = {}): NewLetter => ({
  id, loopId: 'L', pass: 1, fromTool: 'claude', project: '/p', to: 'codex-reviewer', subject: 's', body: 'b',
  attachments: [{ path: 'spec.md', sha256: 'h', bytes: 1 }], status: 'queued', reason: null, ownerPid: 111, createdAt: NOW, ...over,
});

describe('mail log', () => {
  it('stores and updates letters', () => {
    insertLetter(db, row('a'));
    expect(letterExists(db, 'a')).toBe(true);
    updateLetter(db, 'a', { status: 'replied', verdict: 'approved', review: 'Looks good.', finishedAt: NOW + 5 });
    expect(getLetter(db, 'a')).toMatchObject({
      status: 'replied', verdict: 'approved', review: 'Looks good.', attachments: [{ path: 'spec.md', sha256: 'h', bytes: 1 }],
    });
  });

  it('finds the latest pass and updates loops', () => {
    insertLetter(db, row('a'));
    insertLetter(db, row('b', { pass: 2 }));
    expect(latestPass(db, 'L')?.id).toBe('b');
    updateLoop(db, 'L', 'limit', 2, NOW + 1);
    expect(getLoop(db, 'L')).toMatchObject({ status: 'limit', passes: 2 });
  });

  it('counts accepted letters in the last 24 hours only', () => {
    insertLetter(db, row('a'));
    insertLetter(db, row('b', { loopId: null, status: 'refused' }));
    insertLetter(db, row('c', { createdAt: NOW - 86_400_001 }));
    expect(lettersInLast24h(db, NOW)).toBe(1);
  });

  it('cancels only letters whose Fleet is gone', () => {
    insertLetter(db, row('dead', { ownerPid: 111 }));
    insertLetter(db, row('live', { ownerPid: 222 }));
    insertLetter(db, row('reused', { ownerPid: 333 }));
    expect(cancelOrphans(db, NOW, 333, pid => pid !== 111).sort()).toEqual(['dead', 'reused']);
    expect(getLetter(db, 'live')?.status).toBe('queued');
    expect(getLetter(db, 'dead')).toMatchObject({ status: 'cancelled', reason: 'Fleet stopped before this finished' });
    expect(getLoop(db, 'L')?.status).toBe('failed');
  });
});
