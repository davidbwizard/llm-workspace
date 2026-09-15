import { createHash } from 'node:crypto';

/** Hash of the raw source record. Spec §6.1: the identity key is
 *  (source_file, source_offset, content_hash, sub_index), enforced by the
 *  unique index in Task 3. The hash is the part that matters here — it
 *  means a REWRITTEN record at the same offset re-ingests instead of
 *  being silently skipped.
 *
 *  parser_version is deliberately NOT part of identity: a parser fix is
 *  handled by delete-then-parse (Task 5), not by minting new identities. */
export function hashRecord(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A session id safe to put on a command line. Anchored, and restricted to
 *  characters no shell gives special meaning to, because `claude --resume
 *  <id>` is handed to tmux as one shell string (src/main/launch.ts). Lives
 *  here rather than in launch.ts so the live session file reader
 *  (src/providers/claude/liveSession.ts) can reject an unsafe id at parse
 *  time without importing main-process code. */
export const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;
