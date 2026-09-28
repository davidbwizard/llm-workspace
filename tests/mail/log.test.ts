import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelOrphans, createLoop, getLetter, getLoop, getLoopSession, insertLetter, setLoopSession, latestPass, letterExists, lettersInLast24h,
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

  it('keeps the log and its WAL files owner-only', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-log-')), 'mail.sqlite');
    const fileDb = openMailLog(file);
    try {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) expect([f, statSync(f).mode & 0o777]).toEqual([f, 0o600]);
    } finally {
      fileDb.close();
    }
  });

  it('stores the loop session and the pass offset', () => {
    expect(getLoopSession(db, 'L')).toEqual({ sessionId: null, tmux: null, transcript: null });
    setLoopSession(db, 'L', { sessionId: 'u', tmux: 'llmws-claude-mail-L', transcript: '/t.jsonl' });
    expect(getLoopSession(db, 'L')).toEqual({ sessionId: 'u', tmux: 'llmws-claude-mail-L', transcript: '/t.jsonl' });
    insertLetter(db, row('a'));
    updateLetter(db, 'a', { status: 'running', transcriptOffset: 42 });
    expect(db.prepare('SELECT transcript_offset AS o FROM letters WHERE id = ?').get('a')).toEqual({ o: 42 });
  });

  it('adds the session columns to a log made before them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-old-')), 'mail.sqlite');
    const old = new Database(file);
    old.exec('CREATE TABLE loops (id TEXT PRIMARY KEY, specialist TEXT NOT NULL, project TEXT NOT NULL, from_tool TEXT NOT NULL, status TEXT NOT NULL, passes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    old.exec('CREATE TABLE letters (id TEXT PRIMARY KEY, status TEXT NOT NULL, attachments TEXT NOT NULL, created_at INTEGER NOT NULL)');
    old.close();
    const upgraded = openMailLog(file);
    try {
      const cols = (t: string) => (upgraded.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
      expect(cols('loops')).toEqual(expect.arrayContaining(['session_id', 'tmux', 'transcript']));
      expect(cols('letters')).toContain('transcript_offset');
    } finally {
      upgraded.close();
    }
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
