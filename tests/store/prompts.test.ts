import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { ingestSpool } from '../../src/hooks/spool.ts';
import { openPromptEvent, currentBlockers } from '../../src/store/signals.ts';

const FIXTURES = 'tests/fixtures/quick-answers/events';

// The session every fixture below shares (measured 2026-09-17, quick-answers
// design §3): an AskUserQuestion prompt, PreToolUse -> PermissionRequest ->
// (unanswered for 6s) Notification -> answered -> PostToolUse -> Stop.
const SESSION = '319735a2-7eb7-445e-a620-bf9ab4fb12a1';

const ASK_PRE_TOOL_USE = '1789706218.819-PreToolUse-89924.json';
const ASK_PERMISSION_REQUEST = '1789706218.842-PermissionRequest-89928.json';
const ASK_NOTIFICATION = '1789706224.858-Notification-91370.json';
const ASK_POST_TOOL_USE = '1789706285.494-PostToolUse-9936.json';
const ASK_STOP = '1789706289.187-Stop-11382.json';

// The PermissionRequest's occurred_at once truncated to whole seconds, the
// same way the real helper (src/hooks/helper.sh) stamps it: filename
// "1789706218.842" -> the whole second 1789706218.
const ASK_OCCURRED_AT_MS = 1789706218_000;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'quick-answers-spool-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Wraps a raw fixture (a hook's own stdin JSON, committed under
 *  tests/fixtures/quick-answers/events/) as the spool record shape
 *  ingestSpool reads -- {event_id, occurred_at, ppid, payload} -- with
 *  occurred_at taken from the filename's epoch seconds, then ingests it
 *  immediately so insertion order (and so each row's `id`) matches the
 *  order this is called, not directory iteration order. */
function ingestFixture(db: ReturnType<typeof openDb>, filename: string): void {
  const payload = JSON.parse(readFileSync(join(FIXTURES, filename), 'utf8'));
  const m = filename.match(/^(\d+)\.\d+-[A-Za-z]+-(\d+)\.json$/);
  if (!m) throw new Error(`unexpected fixture filename: ${filename}`);
  const rec = {
    event_id: randomUUID(),
    occurred_at: new Date(Number(m[1]) * 1000).toISOString(),
    ppid: Number(m[2]),
    payload,
  };
  writeFileSync(join(dir, `${rec.event_id}.json`), JSON.stringify(rec));
  ingestSpool(db, dir);
}

/** A synthetic event for another session, never read from a fixture --
 *  proves session_id scoping alone, not payload shape. */
function ingestOther(db: ReturnType<typeof openDb>, sessionId: string, occurredAtMs: number, kind: string): void {
  const rec = {
    event_id: randomUUID(),
    occurred_at: new Date(occurredAtMs).toISOString(),
    ppid: 1,
    payload: { session_id: sessionId, hook_event_name: kind },
  };
  writeFileSync(join(dir, `${rec.event_id}.json`), JSON.stringify(rec));
  ingestSpool(db, dir);
}

describe('openPromptEvent', () => {
  it('returns the Ask PermissionRequest when nothing newer has happened', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    const found = openPromptEvent(db, SESSION, ASK_OCCURRED_AT_MS + 800);
    expect(found?.kind).toBe('PermissionRequest');
    expect(found?.occurredAt).toBe(new Date(ASK_OCCURRED_AT_MS).toISOString());
  });

  it('returns null once a later PostToolUse and Stop have landed', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    ingestFixture(db, ASK_POST_TOOL_USE);
    ingestFixture(db, ASK_STOP);
    expect(openPromptEvent(db, SESSION, ASK_OCCURRED_AT_MS + 800)).toBeNull();
  });

  it('is not hidden by a newer Notification', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    ingestFixture(db, ASK_NOTIFICATION);
    expect(openPromptEvent(db, SESSION, ASK_OCCURRED_AT_MS + 800)?.kind).toBe('PermissionRequest');
  });

  it('returns null once waitingSinceMs is more than 2s after the event', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    expect(openPromptEvent(db, SESSION, ASK_OCCURRED_AT_MS + 3000)).toBeNull();
  });

  it('still matches a stamp up to 1s earlier than waitingSinceMs (whole-second rounding)', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    expect(openPromptEvent(db, SESSION, ASK_OCCURRED_AT_MS + 999)?.kind).toBe('PermissionRequest');
  });

  it('ignores another session entirely, even one with a newer event', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    ingestOther(db, 'some-other-session', ASK_OCCURRED_AT_MS + 60_000, 'Stop');
    expect(openPromptEvent(db, SESSION, ASK_OCCURRED_AT_MS + 800)?.kind).toBe('PermissionRequest');
  });

  it('is not hidden by its own PreToolUse, in either ingest order', () => {
    const db1 = openDb(':memory:');
    ingestFixture(db1, ASK_PRE_TOOL_USE);
    ingestFixture(db1, ASK_PERMISSION_REQUEST);
    expect(openPromptEvent(db1, SESSION, ASK_OCCURRED_AT_MS + 800)?.kind).toBe('PermissionRequest');

    const db2 = openDb(':memory:');
    ingestFixture(db2, ASK_PERMISSION_REQUEST);
    ingestFixture(db2, ASK_PRE_TOOL_USE);
    expect(openPromptEvent(db2, SESSION, ASK_OCCURRED_AT_MS + 800)?.kind).toBe('PermissionRequest');
  });
});

describe('currentBlockers', () => {
  it('excludes a PermissionRequest once a Stop in the same session lands', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    ingestFixture(db, ASK_STOP);
    expect(currentBlockers(db, ASK_OCCURRED_AT_MS + 60_000)).toHaveLength(0);
  });

  it('includes a PermissionRequest with nothing after it', () => {
    const db = openDb(':memory:');
    ingestFixture(db, ASK_PERMISSION_REQUEST);
    const [b] = currentBlockers(db, ASK_OCCURRED_AT_MS + 5000);
    expect(b).toMatchObject({ sessionId: SESSION, kind: 'PermissionRequest' });
  });
});
