import { createHash } from 'node:crypto';

/** Hash of the raw source record. Spec §6.1: the identity triple is
 *  (source_file, source_offset, content_hash), enforced by the unique index
 *  in Task 3. The hash is the part that matters here — it means a REWRITTEN
 *  record at the same offset re-ingests instead of being silently skipped.
 *
 *  parser_version is deliberately NOT part of identity: a parser fix is
 *  handled by delete-then-parse (Task 5), not by minting new identities. */
export function hashRecord(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
