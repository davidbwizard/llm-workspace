import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { deriveRunId, ensureRun, getRunStart, runsForSession } from '../../src/store/runs.ts';

describe('deriveRunId', () => {
  it('is deterministic for the same session and start', () => {
    expect(deriveRunId('s1', '2026-09-10T00:00:00Z'))
      .toBe(deriveRunId('s1', '2026-09-10T00:00:00Z'));
  });

  it('differs when the session differs', () => {
    expect(deriveRunId('s1', '2026-09-10T00:00:00Z'))
      .not.toBe(deriveRunId('s2', '2026-09-10T00:00:00Z'));
  });

  it('differs when the start differs, so a resume is a new run', () => {
    expect(deriveRunId('s1', '2026-09-10T00:00:00Z'))
      .not.toBe(deriveRunId('s1', '2026-09-11T00:00:00Z'));
  });
});

describe('ensureRun', () => {
  it('creates a run and returns its id', () => {
    const db = openDb(':memory:');
    const id = ensureRun(db, 's1', '2026-09-10T00:00:00Z');
    expect(id).toBe(deriveRunId('s1', '2026-09-10T00:00:00Z'));
    expect(runsForSession(db, 's1')).toHaveLength(1);
  });

  it('is idempotent — calling twice yields one run', () => {
    const db = openDb(':memory:');
    ensureRun(db, 's1', '2026-09-10T00:00:00Z');
    ensureRun(db, 's1', '2026-09-10T00:00:00Z');
    expect(runsForSession(db, 's1')).toHaveLength(1);
  });

  it('records the run with a source and a null end', () => {
    const db = openDb(':memory:');
    ensureRun(db, 's1', '2026-09-10T00:00:00Z');
    const [run] = runsForSession(db, 's1');
    expect(run!.source).toBe('derived');
    expect(run!.endedAt).toBeNull();
    expect(run!.endReason).toBeNull();
  });

  it('keeps runs separate per session', () => {
    const db = openDb(':memory:');
    ensureRun(db, 's1', '2026-09-10T00:00:00Z');
    ensureRun(db, 's2', '2026-09-10T00:00:00Z');
    expect(runsForSession(db, 's1')).toHaveLength(1);
    expect(runsForSession(db, 's2')).toHaveLength(1);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFileOnce } from '../../src/watch/watcher.ts';

const REC = (u: string, text: string) => JSON.stringify({
  type: 'assistant', uuid: u, sessionId: 'sess-1', cwd: '/repo',
  timestamp: '2026-09-10T00:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }], usage: {} },
}) + '\n';

describe('run_id through ingestion', () => {
  it('stamps every event with a run, and a tail joins the same run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const file = join(dir, 'sess-1.jsonl');
    const db = openDb(':memory:');
    try {
      writeFileSync(file, REC('u1', 'one'));
      ingestFileOnce(db, file, 'claude');
      appendFileSync(file, REC('u2', 'two'));
      ingestFileOnce(db, file, 'claude');

      const ids = db.prepare(
        "SELECT DISTINCT run_id FROM events WHERE session_id = 'sess-1'").all() as any[];
      expect(ids).toHaveLength(1);
      expect(ids[0]!.run_id).not.toBeNull();
      expect(runsForSession(db, 'sess-1')).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves run_id null for events with no resolvable session', () => {
    const db = openDb(':memory:');
    expect(runsForSession(db, 'unknown')).toHaveLength(0);
  });

  it('stamps an agent.spawned event with the same run as its parent session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-'));
    const file = join(dir, 'sess-agent.jsonl');
    const subDir = join(dir, 'sess-agent', 'subagents');
    const db = openDb(':memory:');
    try {
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'agent-reviewer.jsonl'), '');
      writeFileSync(join(subDir, 'agent-reviewer.meta.json'), JSON.stringify({
        name: 'reviewer', agentType: 'reviewer', spawnDepth: 0,
      }));
      writeFileSync(file, JSON.stringify({
        type: 'assistant', uuid: 'u1', sessionId: 'sess-agent', cwd: '/repo',
        timestamp: '2026-09-10T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one' }], usage: {} },
      }) + '\n');

      ingestFileOnce(db, file, 'claude');

      const [run] = runsForSession(db, 'sess-agent');
      const spawned = db.prepare(
        "SELECT run_id FROM events WHERE kind = 'agent.spawned' AND session_id = 'sess-agent'"
      ).get() as { run_id: string | null } | undefined;

      expect(run).toBeDefined();
      expect(spawned).toBeDefined();
      expect(spawned!.run_id).toBe(run!.runId);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('statement caching (ensureRun/getRunStart/runsForSession)', () => {
  // ensureRun/getRunStart/runsForSession used to call db.prepare() fresh on
  // every invocation. ensureRun runs once per event lacking a run_id inside
  // ingestFileOnce's loop, so a real ingest piles up uncached native
  // Statement handles fast enough to abort the whole process during GC
  // (SIGABRT, "Assertion failed: (env) != nullptr" in Statement::~Statement
  // -- not a JS exception, try/catch cannot stop it).
  //
  // This is NOT tested here by actually triggering that crash under a real
  // high-volume ingest, deliberately. Investigating this task's original
  // finding turned up an independent, confirmed upstream regression:
  // Node.js 24.19.0 added cleanup hooks to node::ObjectWrap
  // (nodejs/node#63642), which breaks NAN/ObjectWrap-style native addons --
  // better-sqlite3 among them -- under exactly this native code path
  // (RemoveEnvironmentCleanupHook / hooks.cc:142; matches this project's
  // crash stack trace character-for-character against public reports, e.g.
  // https://github.com/nexu-io/open-design/issues/6462). Confirmed against
  // this machine's real corpus (194,000 events) BOTH before and after this
  // caching fix: both still crash under plain Node 24.19.0 here, because
  // caching statements reduces native-object churn but does not eliminate
  // an upstream Node bug. So no ingestion volume, however small, can
  // reliably demonstrate "does not crash" as a deterministic test on this
  // machine -- and a test that occasionally aborts the whole worker process
  // would take other tests in this file down with it, which is worse than
  // no test. See the task-11 report for the full evidence and citations.
  //
  // What IS reliably testable, and what this fix actually changes, is
  // whether db.prepare() is called once per Db instance rather than once
  // per call -- so that's what these tests check directly.
  it('prepares the insert statement once per Db, not once per ensureRun call', () => {
    const db = openDb(':memory:');
    const prepareSpy = vi.spyOn(db, 'prepare');
    ensureRun(db, 's1', '2026-09-10T00:00:00Z');
    ensureRun(db, 's1', '2026-09-10T00:00:00Z');
    ensureRun(db, 's2', '2026-09-10T00:00:00Z');
    const insertCalls = prepareSpy.mock.calls.filter(([sql]) => String(sql).includes('INSERT OR IGNORE INTO runs'));
    expect(insertCalls).toHaveLength(1);
  });

  it('prepares the getRunStart statement once per Db, not once per call', () => {
    const db = openDb(':memory:');
    const prepareSpy = vi.spyOn(db, 'prepare');
    getRunStart(db, 's1');
    getRunStart(db, 's2');
    getRunStart(db, 's1');
    const selectCalls = prepareSpy.mock.calls.filter(([sql]) => String(sql).includes('SELECT started_at FROM runs'));
    expect(selectCalls).toHaveLength(1);
  });

  it('prepares the runsForSession statement once per Db, not once per call', () => {
    const db = openDb(':memory:');
    const prepareSpy = vi.spyOn(db, 'prepare');
    runsForSession(db, 's1');
    runsForSession(db, 's2');
    const selectCalls = prepareSpy.mock.calls.filter(([sql]) => String(sql).includes('SELECT * FROM runs'));
    expect(selectCalls).toHaveLength(1);
  });

  it('keeps separate Db instances on separate caches', () => {
    const dbA = openDb(':memory:');
    const dbB = openDb(':memory:');
    ensureRun(dbA, 's1', '2026-09-10T00:00:00Z');
    ensureRun(dbB, 's1', '2026-09-10T00:00:00Z');
    expect(runsForSession(dbA, 's1')).toHaveLength(1);
    expect(runsForSession(dbB, 's1')).toHaveLength(1);
  });
});
