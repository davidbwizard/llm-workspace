import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import type { Db } from '../store/db.ts';

/** How much of the end of a rollout file the busy check reads. A turn's
 *  own events are the last thing written, so the tail is enough, and a
 *  rollout file can be tens of MB -- this runs on the send path. */
export const ROLLOUT_TAIL_BYTES = 262_144;

const STARTED = 'task_started';
const ENDED = new Set(['task_complete', 'turn_aborted']);

/** The rule: of the turn-boundary events in this tail, is the last one a
 *  start? A busy Codex does not submit on Enter ("tab to queue message",
 *  KNOWN_ISSUES.md 2026-09-16), so the send path needs this before it
 *  chooses a key. */
export function codexBusyFromTail(tail: string): boolean {
  let busy = false;
  for (const line of tail.split('\n')) {
    // The first line of a tail read is usually half a record.
    if (!line.startsWith('{')) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== 'event_msg') continue;
    const type = rec.payload?.type;
    if (type === STARTED) busy = true;
    else if (ENDED.has(type)) busy = false;
  }
  return busy;
}

/** The rollout file this session's events were read from. Excludes subagent
 *  threads (agent_id != null), which share the session_id but write their own
 *  rollout file. */
export function rolloutPathFor(db: Db, sessionId: string): string | null {
  const row = db.prepare(
    `SELECT source_file FROM events WHERE session_id = ? AND agent_id IS NULL AND source_file IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  ).get(sessionId) as { source_file: string } | undefined;
  return row?.source_file ?? null;
}

function readTail(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch (err) {
    console.error('codex rollout tail read failed:', path, (err as Error).message);
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/** True/false when the rollout says so, null when it cannot be read --
 *  callers must treat null as "send the way we always did", never as idle
 *  or busy. */
export function isCodexBusy(
  db: Db, sessionId: string, read: (path: string) => string | null = readTail,
): boolean | null {
  const path = rolloutPathFor(db, sessionId);
  if (path === null) return null;
  let tail: string | null;
  try { tail = read(path); } catch (err) {
    console.error('codex busy check failed:', path, (err as Error).message);
    return null;
  }
  return tail === null ? null : codexBusyFromTail(tail);
}
