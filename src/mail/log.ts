import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import type { LetterStatus, LoopStatus, Sender, Verdict } from './files.ts';
import type { Attachment } from './letter.ts';
import type { LoopRow, PassRow } from './loop.ts';

export type MailDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  specialist TEXT NOT NULL,
  project TEXT NOT NULL,
  from_tool TEXT NOT NULL,
  status TEXT NOT NULL,
  passes INTEGER NOT NULL,
  session_id TEXT,
  tmux TEXT,
  transcript TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS letters (
  id TEXT PRIMARY KEY,
  loop_id TEXT REFERENCES loops(id),
  pass INTEGER,
  from_tool TEXT,
  project TEXT,
  to_specialist TEXT,
  subject TEXT,
  body TEXT,
  attachments TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  verdict TEXT,
  review TEXT,
  stderr_tail TEXT,
  owner_pid INTEGER,
  transcript_offset INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS letters_created ON letters (created_at);
`;

export function openMailLog(path: string): MailDb {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
    chmodSync(path, 0o600);
  }
  db.exec(SCHEMA);
  // Columns added after the first release, for logs created before them.
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

const ADDED_COLUMNS = [
  ['loops', 'session_id', 'TEXT'], ['loops', 'tmux', 'TEXT'], ['loops', 'transcript', 'TEXT'],
  ['letters', 'transcript_offset', 'INTEGER'],
] as const;

/** The live session a loop's passes go to. */
export interface LoopSession { sessionId: string | null; tmux: string | null; transcript: string | null }

export function getLoopSession(db: MailDb, loopId: string): LoopSession {
  const r = db.prepare('SELECT session_id AS sessionId, tmux, transcript FROM loops WHERE id = ?').get(loopId) as LoopSession | undefined;
  return r ?? { sessionId: null, tmux: null, transcript: null };
}

export function setLoopSession(db: MailDb, loopId: string, s: LoopSession): void {
  db.prepare('UPDATE loops SET session_id = ?, tmux = ?, transcript = ? WHERE id = ?').run(s.sessionId, s.tmux, s.transcript, loopId);
}

export interface NewLetter {
  id: string;
  loopId: string | null;
  pass: number | null;
  fromTool: Sender | null;
  project: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  attachments: Attachment[];
  status: LetterStatus;
  reason: string | null;
  ownerPid: number;
  createdAt: number;
}

export interface LetterRow {
  id: string;
  loopId: string | null;
  pass: number | null;
  fromTool: Sender | null;
  project: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  attachments: Attachment[];
  status: LetterStatus;
  reason: string | null;
  verdict: Verdict | null;
  review: string | null;
}

/** Fields left out keep their stored value. */
export interface LetterUpdate {
  status: LetterStatus;
  reason?: string | null;
  verdict?: Verdict | null;
  review?: string | null;
  stderrTail?: string | null;
  startedAt?: number;
  finishedAt?: number;
  transcriptOffset?: number;
}

export function insertLetter(db: MailDb, l: NewLetter): void {
  db.prepare(`INSERT INTO letters
      (id, loop_id, pass, from_tool, project, to_specialist, subject, body, attachments, status, reason, owner_pid, created_at)
    VALUES (@id, @loopId, @pass, @fromTool, @project, @to, @subject, @body, @attachments, @status, @reason, @ownerPid, @createdAt)`)
    .run({ ...l, attachments: JSON.stringify(l.attachments) });
}

export function letterExists(db: MailDb, id: string): boolean {
  return db.prepare('SELECT 1 FROM letters WHERE id = ?').get(id) !== undefined;
}

export function getLetter(db: MailDb, id: string): LetterRow | null {
  const r: any = db.prepare('SELECT * FROM letters WHERE id = ?').get(id);
  return r ? {
    id: r.id, loopId: r.loop_id, pass: r.pass, fromTool: r.from_tool, project: r.project, to: r.to_specialist,
    subject: r.subject, body: r.body, attachments: JSON.parse(r.attachments), status: r.status, reason: r.reason,
    verdict: r.verdict, review: r.review,
  } : null;
}

export function updateLetter(db: MailDb, id: string, u: LetterUpdate): void {
  db.prepare(`UPDATE letters SET status = @status,
      reason = COALESCE(@reason, reason), verdict = COALESCE(@verdict, verdict), review = COALESCE(@review, review),
      stderr_tail = COALESCE(@stderrTail, stderr_tail), started_at = COALESCE(@startedAt, started_at),
      finished_at = COALESCE(@finishedAt, finished_at), transcript_offset = COALESCE(@transcriptOffset, transcript_offset)
    WHERE id = @id`)
    .run({
      id, status: u.status, reason: u.reason ?? null, verdict: u.verdict ?? null, review: u.review ?? null,
      stderrTail: u.stderrTail ?? null, startedAt: u.startedAt ?? null, finishedAt: u.finishedAt ?? null,
      transcriptOffset: u.transcriptOffset ?? null,
    });
}

export function createLoop(db: MailDb, loop: LoopRow, now: number): void {
  db.prepare(`INSERT INTO loops (id, specialist, project, from_tool, status, passes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(loop.id, loop.specialist, loop.project, loop.fromTool, loop.status, loop.passes, now, now);
}

export function getLoop(db: MailDb, id: string): LoopRow | null {
  const r: any = db.prepare('SELECT * FROM loops WHERE id = ?').get(id);
  return r ? { id: r.id, specialist: r.specialist, project: r.project, fromTool: r.from_tool, status: r.status, passes: r.passes } : null;
}

export function updateLoop(db: MailDb, id: string, status: LoopStatus, passes: number, now: number): void {
  db.prepare('UPDATE loops SET status = ?, passes = ?, updated_at = ? WHERE id = ?').run(status, passes, now, id);
}

export function latestPass(db: MailDb, loopId: string): PassRow | null {
  const r: any = db.prepare('SELECT id, status, attachments FROM letters WHERE loop_id = ? ORDER BY pass DESC LIMIT 1').get(loopId);
  return r ? { id: r.id, status: r.status, attachments: JSON.parse(r.attachments) } : null;
}

/** Accepted letters in the last 24 hours. Refusals do not count. */
export function lettersInLast24h(db: MailDb, now: number): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM letters WHERE status != 'refused' AND created_at > ?`).get(now - 86_400_000) as { n: number };
  return r.n;
}

/** Cancels letters left queued or running by a Fleet that is gone, and fails
 *  their loops. A letter owned by this process's pid is from an earlier run
 *  that reused the pid. Returns the cancelled ids. */
export function cancelOrphans(db: MailDb, now: number, ownPid: number, isAlive: (pid: number) => boolean): string[] {
  const rows = db.prepare(`SELECT id, loop_id, pass, owner_pid FROM letters WHERE status IN ('queued', 'running')`)
    .all() as { id: string; loop_id: string | null; pass: number | null; owner_pid: number | null }[];
  const orphans = rows.filter(r => r.owner_pid === null || r.owner_pid === ownPid || !isAlive(r.owner_pid));
  db.transaction(() => {
    for (const r of orphans) {
      updateLetter(db, r.id, { status: 'cancelled', reason: 'Fleet stopped before this finished', finishedAt: now });
      if (r.loop_id) updateLoop(db, r.loop_id, 'failed', r.pass ?? 0, now);
    }
  })();
  return orphans.map(r => r.id);
}
