import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Shared by Fleet's post office and the mail slot. The slot runs under plain
// Node, so this file must never import the database library.

export type Sender = 'claude' | 'codex';
export type LetterStatus = 'queued' | 'running' | 'replied' | 'refused' | 'failed' | 'timed_out' | 'cancelled';
export type LoopStatus = 'open' | 'approved' | 'limit' | 'failed';
export type Verdict = 'approved' | 'changes_requested';
export const FINAL_STATUSES: readonly LetterStatus[] = ['replied', 'refused', 'failed', 'timed_out', 'cancelled'];

/** What the slot writes into inbox/<id>.json. */
export interface Letter {
  version: 1;
  id: string;
  /** `pid`: the sending CLI's process (the slot's parent). `meta`: the tool
   *  call's `_meta`, which Codex fills; used to find a Codex sender's session. */
  from: { tool: Sender; project: string; pid?: number; meta?: Record<string, unknown> };
  to: string;
  subject: string;
  body: string;
  attachments: string[];
  re: string | null;
  sentAt: string;
}

/** What Fleet writes into out/<id>.json for check_mail. */
export interface OutFile {
  id: string;
  status: LetterStatus;
  reason: string | null;
  specialist: string | null;
  project: string | null;
  pass: number | null;
  passLimit: number | null;
  verdict: Verdict | null;
  review: string | null;
  loopStatus: LoopStatus | null;
}

export interface MailPaths {
  dir: string;
  inbox: string;
  out: string;
  work: string;
  config: string;
  letters: string;
}

export const defaultMailDir = (home: string): string => join(home, '.llm-workspace/mail');

export function mailPaths(dir: string): MailPaths {
  return {
    dir,
    inbox: join(dir, 'inbox'),
    out: join(dir, 'out'),
    work: join(dir, 'work'),
    config: join(dir, 'config.json'),
    letters: join(dir, 'letters'),
  };
}

/** Largest `from.meta` a letter may carry, as JSON. */
export const MAX_META_CHARS = 4096;

export const newLetterId = (): string => randomBytes(16).toString('hex');
export const isLetterId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

/** Temp file plus rename, so no reader ever sees half a file. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}
