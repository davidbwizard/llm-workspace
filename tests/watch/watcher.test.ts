import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { countEvents, getIngestState } from '../../src/store/ingest.ts';
import { ingestFileOnce, ingestAll } from '../../src/watch/watcher.ts';
import { CLAUDE_PARSER_VERSION } from '../../src/providers/claude/parse.ts';
import { CODEX_PARSER_VERSION } from '../../src/providers/codex/parse.ts';

let dir: string, file: string;
const REC = (u: string, text: string) => JSON.stringify({
  type: 'assistant', uuid: u, sessionId: 's1', timestamp: '2026-09-10T00:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }], usage: {} },
}) + '\n';
// Real Claude records ALL carry cwd; REC above omits it for brevity in the
// tests that don't care. B3's fix needs it present on every record, the way
// a real transcript actually is.
const RECC = (u: string, text: string) => JSON.stringify({
  type: 'assistant', uuid: u, sessionId: 's1', cwd: '/repo', timestamp: '2026-09-10T00:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }], usage: {} },
}) + '\n';

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'watch-')); file = join(dir, 's1.jsonl'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ingestFileOnce', () => {
  it('ingests a whole file on first sight', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one') + REC('u2', 'two'));
    const r = ingestFileOnce(db, file, 'claude');
    expect(r.written).toBeGreaterThan(0);
    expect(countEvents(db, file)).toBe(r.written);
  });

  it('reads only the tail on the second call', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one'));
    const first = ingestFileOnce(db, file, 'claude');
    appendFileSync(file, REC('u2', 'two'));
    const second = ingestFileOnce(db, file, 'claude');
    expect(second.written).toBe(first.written);
    expect(second.restarted).toBe(false);
  });

  it('writes nothing when the file has not changed', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one'));
    ingestFileOnce(db, file, 'claude');
    expect(ingestFileOnce(db, file, 'claude').written).toBe(0);
  });

  it('re-reads from zero after truncation and does not duplicate', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one') + REC('u2', 'two'));
    ingestFileOnce(db, file, 'claude');
    writeFileSync(file, REC('u3', 'three'));
    const r = ingestFileOnce(db, file, 'claude');
    expect(r.restarted).toBe(true);
    const texts = db.prepare("SELECT payload FROM events WHERE kind='prose'").all()
      .map((x: any) => JSON.parse(x.payload).text);
    expect(texts).toEqual(['three']);
  });

  it('reports unparsed records so drift is visible', () => {
    const db = openDb(':memory:');
    writeFileSync(file, '{"type":"brand-new","sessionId":"s1","timestamp":"t"}\n');
    const r = ingestFileOnce(db, file, 'claude');
    expect(r.unparsed).toBe(1);
  });

  it('routes codex rollouts to the codex parser', () => {
    const db = openDb(':memory:');
    const rollout = join(dir, 'rollout-x.jsonl');
    writeFileSync(rollout, JSON.stringify({
      timestamp: '2026-09-10T00:00:00Z', type: 'event_msg',
      payload: { type: 'agent_message', message: 'hello from codex' },
    }) + '\n');
    ingestFileOnce(db, rollout, 'codex');
    const row = db.prepare("SELECT provider, payload FROM events WHERE kind='prose'").get() as any;
    expect(row.provider).toBe('codex');
    expect(JSON.parse(row.payload).text).toBe('hello from codex');
  });
});

// Task 8 built findSubagents/parseAgentMeta and nothing called them.
// agent.spawned is the sole source of the agent graph, so ingesting a
// session transcript must also discover and emit its subagents' events —
// see subagentEvents/subagentSessionDir in watcher.ts.
describe('ingestFileOnce — subagent discovery', () => {
  function writeSubagent(sessionDir: string, agentId: string, meta: Record<string, unknown>) {
    const subDir = join(sessionDir, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `${agentId}.jsonl`), '');
    writeFileSync(join(subDir, `${agentId}.meta.json`), JSON.stringify(meta));
  }

  it('emits agent.spawned when ingesting the parent session transcript', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one'));
    writeSubagent(join(dir, 's1'), 'agent-reviewer-abc', {
      name: 'reviewer', agentType: 'reviewer', spawnDepth: 0, model: 'opus', color: 'blue',
    });

    ingestFileOnce(db, file, 'claude');
    const rows = db.prepare("SELECT agent_id, payload FROM events WHERE kind='agent.spawned'").all() as any[];
    expect(rows).toHaveLength(1);
    // Bare id (agent- filename prefix stripped): matches what that
    // subagent's own transcript records carry in their agentId field, so
    // agent.spawned joins to that agent's own activity events.
    expect(rows[0].agent_id).toBe('reviewer-abc');
    expect(JSON.parse(rows[0].payload)).toMatchObject({ name: 'reviewer', type: 'reviewer', model: 'opus' });
  });

  it('is idempotent — re-ingesting the parent writes zero new agent.spawned rows', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one'));
    writeSubagent(join(dir, 's1'), 'agent-reviewer-abc', { name: 'reviewer', spawnDepth: 0 });

    ingestFileOnce(db, file, 'claude');
    const before = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='agent.spawned'").get() as any;

    // No change to the parent file's bytes, so the ordinary tail path
    // contributes zero, but subagentEvents still re-runs — dedup must hold.
    const r = ingestFileOnce(db, file, 'claude');
    const after = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='agent.spawned'").get() as any;

    expect(r.written).toBe(0);
    expect(after.c).toBe(before.c);
  });

  it('ingests cleanly when there is no subagents directory', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one'));
    expect(() => ingestFileOnce(db, file, 'claude')).not.toThrow();
    const rows = db.prepare("SELECT * FROM events WHERE kind='agent.spawned'").all();
    expect(rows).toHaveLength(0);
  });

  it('discovers a subagent from its own transcript changing, without a parent-file write', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one'));
    ingestFileOnce(db, file, 'claude'); // parent ingested once, before the subagent exists

    const sessionDir = join(dir, 's1');
    writeSubagent(sessionDir, 'agent-late-joiner', { name: 'late-joiner', spawnDepth: 0 });
    const subPath = join(sessionDir, 'subagents', 'agent-late-joiner.jsonl');

    // Only the subagent's own file is ingested here — the parent is untouched.
    ingestFileOnce(db, subPath, 'claude');

    const rows = db.prepare("SELECT agent_id FROM events WHERE kind='agent.spawned'").all() as any[];
    expect(rows.map(r => r.agent_id)).toContain('late-joiner'); // bare id, agent- prefix stripped
  });
});

// B2/B3: parser state (session id, sessionStartEmitted, threadAgentId) does
// not survive across separate ingestFileOnce calls on their own -- only
// ingestFileOnce, via resumeContextFor, carries it across the incremental
// tail boundary that chokidar/the real watcher actually exercises. These
// tests drive the bug through that real path (a temp file, appended to,
// re-ingested), not through the parsers directly.
describe('ingestFileOnce — resume across a tail (B2/B3)', () => {
  it('B3: appending to and re-ingesting a Claude transcript yields exactly one session.started, never a duplicate', () => {
    const db = openDb(':memory:');
    writeFileSync(file, RECC('u1', 'one'));
    ingestFileOnce(db, file, 'claude');
    appendFileSync(file, RECC('u2', 'two'));
    ingestFileOnce(db, file, 'claude');

    const started = db.prepare(
      "SELECT COUNT(*) c FROM events WHERE kind='session.started' AND source_file=?",
    ).get(file) as any;
    expect(started.c).toBe(1);
  });

  it('B2: appending to and re-ingesting a Codex rollout never leaves session_id "unknown"', () => {
    const db = openDb(':memory:');
    const rollout = join(dir, 'rollout-y.jsonl');
    const metaLine = JSON.stringify({
      timestamp: '2026-09-10T00:00:00Z', type: 'session_meta',
      payload: { session_id: 'sess-abc', id: 'sess-abc', cwd: '/repo' },
    }) + '\n';
    const msgLine = (text: string) => JSON.stringify({
      timestamp: '2026-09-10T00:00:01Z', type: 'event_msg',
      payload: { type: 'agent_message', message: text },
    }) + '\n';

    writeFileSync(rollout, metaLine + msgLine('first'));
    ingestFileOnce(db, rollout, 'codex');
    appendFileSync(rollout, msgLine('second'));
    ingestFileOnce(db, rollout, 'codex');

    const rows = db.prepare('SELECT DISTINCT session_id FROM events WHERE source_file=?')
      .all(rollout) as any[];
    expect(rows.map(r => r.session_id)).toEqual(['sess-abc']);

    const prose = db.prepare(
      "SELECT payload FROM events WHERE kind='prose' AND source_file=? ORDER BY id",
    ).all(rollout) as any[];
    expect(prose.map(r => JSON.parse(r.payload).text)).toEqual(['first', 'second']);
  });
});

// F1: both parsers already extract provider_cli_version onto the
// session.started event's payload; it was simply never plumbed into the
// ingest meta ingestFileOnce writes, so ingest_files.provider_cli_version
// was always NULL regardless.
describe('ingestFileOnce — provider_cli_version (F1)', () => {
  it('records the Claude CLI version from the session.started record', () => {
    const db = openDb(':memory:');
    writeFileSync(file, JSON.stringify({
      type: 'assistant', uuid: 'u1', sessionId: 's1', cwd: '/repo', version: '2.1.267',
      timestamp: '2026-09-10T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'one' }], usage: {} },
    }) + '\n');
    ingestFileOnce(db, file, 'claude');
    expect(getIngestState(db, file)?.provider_cli_version).toBe('2.1.267');
  });

  it('records the Codex CLI version from the session_meta record', () => {
    const db = openDb(':memory:');
    const rollout = join(dir, 'rollout-v.jsonl');
    writeFileSync(rollout, JSON.stringify({
      timestamp: '2026-09-10T00:00:00Z', type: 'session_meta',
      payload: { session_id: 's1', id: 's1', cwd: '/repo', cli_version: '0.152.1' },
    }) + '\n');
    ingestFileOnce(db, rollout, 'codex');
    expect(getIngestState(db, rollout)?.provider_cli_version).toBe('0.152.1');
  });

  it('preserves a previously recorded cli version across a tail chunk that carries none', () => {
    const db = openDb(':memory:');
    writeFileSync(file, JSON.stringify({
      type: 'assistant', uuid: 'u1', sessionId: 's1', cwd: '/repo', version: '2.1.267',
      timestamp: '2026-09-10T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'one' }], usage: {} },
    }) + '\n');
    ingestFileOnce(db, file, 'claude');
    appendFileSync(file, REC('u2', 'two')); // no cwd/version -- a plain tail record
    ingestFileOnce(db, file, 'claude');
    expect(getIngestState(db, file)?.provider_cli_version).toBe('2.1.267');
  });
});

// F2: agent.spawned rows carry source_file = <agent>.meta.json, not the
// transcript path reparseFile's plain WHERE source_file = ? deletes -- so a
// parser_version bump reparsed the transcript but left a previously-indexed
// agent.spawned row exactly as it was, its re-derivation silently skipped as
// a UNIQUE conflict on its byte-stable identity.
describe('ingestFileOnce — subagent-meta reparse (F2)', () => {
  function writeSubagent(sessionDir: string, agentId: string, meta: Record<string, unknown>) {
    const subDir = join(sessionDir, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `${agentId}.jsonl`), '');
    writeFileSync(join(subDir, `${agentId}.meta.json`), JSON.stringify(meta));
  }

  it('a parser_version bump rewrites a previously-indexed agent.spawned row instead of leaving it stale', () => {
    const db = openDb(':memory:');
    writeFileSync(file, REC('u1', 'one'));
    writeSubagent(join(dir, 's1'), 'agent-reviewer-abc', {
      name: 'reviewer', agentType: 'reviewer', spawnDepth: 0,
    });

    ingestFileOnce(db, file, 'claude');
    const before = db.prepare("SELECT parser_version FROM events WHERE kind='agent.spawned'").get() as any;
    expect(before.parser_version).toBe(CLAUDE_PARSER_VERSION);

    // Simulate a parser_version bump: both the previously-indexed
    // agent.spawned row and the transcript's own ingest bookkeeping predate
    // the (real, unchanged) current parser version.
    db.prepare("UPDATE events SET parser_version = 0 WHERE kind = 'agent.spawned'").run();
    db.prepare('UPDATE ingest_files SET parser_version = 0 WHERE path = ?').run(file);

    ingestFileOnce(db, file, 'claude');

    const after = db.prepare("SELECT parser_version FROM events WHERE kind='agent.spawned'").get() as any;
    expect(after.parser_version).toBe(CLAUDE_PARSER_VERSION);
    const count = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='agent.spawned'").get() as any;
    expect(count.c).toBe(1); // replaced in place, not duplicated
  });
});

// CLAUDE_PARSER_VERSION bumped to 4: a thinking-only reply (no `text` block)
// now also produces a note-flagged `prose` event (parse.ts). A plain tail
// never revisits already-ingested bytes, so a session indexed before this
// bump would carry that note forever unless the bump forces the same
// delete-then-reparse (staleParser) path the two prior bumps relied on --
// this proves that path both fills the note in AND does not duplicate the
// rest of the file's events, the same shape as the F2 test above.
describe('ingestFileOnce — thinking-note reparse after a CLAUDE_PARSER_VERSION bump', () => {
  it('a stale parser version backfills the note event without duplicating anything else in the file', () => {
    const db = openDb(':memory:');
    const thinkingOnly = JSON.stringify({
      type: 'assistant', uuid: 'u-think', sessionId: 's1', cwd: '/repo',
      timestamp: '2026-09-10T00:00:00.500Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Summarising the plan.' }] },
    }) + '\n';
    writeFileSync(file, RECC('u1', 'one') + thinkingOnly + RECC('u2', 'two'));

    ingestFileOnce(db, file, 'claude');
    const firstTotal = countEvents(db, file);
    const noteCountBefore = db.prepare(
      "SELECT COUNT(*) c FROM events WHERE kind='prose' AND json_extract(payload,'$.note')=1",
    ).get() as any;
    expect(noteCountBefore.c).toBe(1);

    // Simulate a pre-fix index: this file's rows (and its own ingest
    // bookkeeping) all predate the real, current parser version — same
    // technique as the F2 test above.
    db.prepare('UPDATE events SET parser_version = 0 WHERE source_file = ?').run(file);
    db.prepare('UPDATE ingest_files SET parser_version = 0 WHERE path = ?').run(file);

    const r = ingestFileOnce(db, file, 'claude');
    expect(r.restarted).toBe(false); // a version bump, not a truncation

    expect(countEvents(db, file)).toBe(firstTotal); // replaced in place, not duplicated
    const noteCountAfter = db.prepare(
      "SELECT COUNT(*) c FROM events WHERE kind='prose' AND json_extract(payload,'$.note')=1",
    ).get() as any;
    expect(noteCountAfter.c).toBe(1);
    const noteRow = db.prepare(
      "SELECT parser_version FROM events WHERE kind='prose' AND json_extract(payload,'$.note')=1",
    ).get() as any;
    expect(noteRow.parser_version).toBe(CLAUDE_PARSER_VERSION);
  });
});

// B1 (whole-branch review, 2026-09-11): 3663f24 fixed subagentIdentity's
// thread_spawn handling (it was stringifying the nested thread_spawn object
// to the literal text "[object Object]" instead of reading agent_nickname)
// but changed event CONTENT only. The identity key
// (source_file, source_offset, content_hash, sub_index) is unaffected by a
// content-only fix, so a plain re-ingest's insertEvents call collides with
// the already-indexed corrupted row on the UNIQUE index and is silently
// skipped -- the bad row survives. Only a CODEX_PARSER_VERSION bump makes
// ingestFileOnce take the delete-then-reparse (staleParser) path that
// actually replaces it; see src/store/ingest.ts:166's reparseFile comment.
describe('ingestFileOnce — Codex thread_spawn identity reparse (B1)', () => {
  function threadSpawnRollout(): string {
    return [
      JSON.stringify({
        timestamp: '2026-09-11T16:41:45.181Z', type: 'session_meta',
        payload: {
          session_id: '01b1a2b3-9000', id: '01b1a2b3-9001',
          parent_thread_id: '01b1a2b3-9000', cwd: '/repo',
          source: { subagent: { thread_spawn: {
            parent_thread_id: '01b1a2b3-9000', depth: 1,
            agent_nickname: 'Nietzsche', agent_role: 'reviewer',
          } } },
          thread_source: 'subagent', agent_nickname: 'Nietzsche', agent_role: 'reviewer',
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-11T16:41:46.000Z', type: 'event_msg',
        payload: { type: 'agent_message', message: 'Reading the target folder for review.' },
      }),
    ].join('\n') + '\n';
  }

  it('a CODEX_PARSER_VERSION bump rewrites a previously-corrupted agent.spawned row instead of leaving it stale', () => {
    const db = openDb(':memory:');
    const rollout = join(dir, 'rollout-subagent.jsonl');
    writeFileSync(rollout, threadSpawnRollout());

    ingestFileOnce(db, rollout, 'codex');
    const before = db.prepare("SELECT parser_version, payload FROM events WHERE kind='agent.spawned'").get() as any;
    expect(JSON.parse(before.payload).name).toBe('Nietzsche'); // the fixed parser gets this right today
    expect(before.parser_version).toBe(CODEX_PARSER_VERSION);

    // Simulate the pre-fix state this regression describes: a row the OLD
    // buggy parser already wrote, at the OLD parser_version, and nothing
    // has re-parsed this file since. (The buggy content itself was already
    // fixed forward by 3663f24 -- this reproduces what was left BEHIND in
    // the index by that fix, not the bug in the parser itself.)
    db.prepare("UPDATE events SET payload = ?, parser_version = 1 WHERE kind = 'agent.spawned'").run(
      JSON.stringify({
        name: '[object Object]', type: 'reviewer', model: null, color: null,
        depth: 1, taskKind: null, teamName: null, parentAgentId: '01b1a2b3-9000',
      }),
    );
    db.prepare('UPDATE ingest_files SET parser_version = 1 WHERE path = ?').run(rollout);

    ingestFileOnce(db, rollout, 'codex');

    const after = db.prepare("SELECT parser_version, payload FROM events WHERE kind='agent.spawned'").get() as any;
    expect(JSON.parse(after.payload).name).toBe('Nietzsche'); // repaired, not stuck as "[object Object]"
    expect(after.parser_version).toBe(CODEX_PARSER_VERSION);
    const count = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='agent.spawned'").get() as any;
    expect(count.c).toBe(1); // replaced in place, not duplicated
  });
});

// Re-review finding: D1's new throw (readTail rejecting malformed-UTF-8
// offset drift) propagated out of ingestFileOnce with nothing to catch it in
// cli.ts's `ingest` command, so one bad transcript aborted the ENTIRE
// corpus -- the spool ingest, rotation, and summary never ran, and every
// later `ingest` died on that same file again, forever. startWatcher already
// gets this right (a per-file try/catch); ingestAll (extracted from cli.ts's
// inline loop so it is testable without importing the whole argv-dispatching
// script) now uses the same shape.
describe('ingestAll — one bad file does not abort the corpus', () => {
  it('skips a file that throws and still ingests the others, reporting the skip', () => {
    const root = mkdtempSync(join(tmpdir(), 'ingest-all-'));
    const good1 = join(root, 'good1.jsonl');
    const good2 = join(root, 'good2.jsonl');
    const bad = join(root, 'bad.jsonl');

    writeFileSync(good1, REC('u1', 'one'));
    writeFileSync(good2, REC('u2', 'two'));
    // {"a":<0xFF>}\n -- 0xFF is not valid UTF-8 anywhere; this is exactly
    // D1's offset-drift guard in readTail, which throws rather than
    // silently drifting the offset.
    writeFileSync(bad, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d, 0x0a]));

    const db = openDb(':memory:');
    const outcome = ingestAll(db, [{ dir: root, provider: 'claude', glob: /\.jsonl$/ }]);

    expect(outcome.files).toBe(3);
    expect(outcome.skipped).toBe(1);
    expect(outcome.written).toBeGreaterThan(0);

    // The bad file's throw did not prevent the good ones from being
    // ingested -- proof this is "skip and continue", not "abort the batch".
    expect(countEvents(db, good1)).toBeGreaterThan(0);
    expect(countEvents(db, good2)).toBeGreaterThan(0);
    expect(countEvents(db, bad)).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });

  it('reports zero skipped when every file ingests cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'ingest-all-'));
    writeFileSync(join(root, 'good.jsonl'), REC('u1', 'one'));

    const db = openDb(':memory:');
    const outcome = ingestAll(db, [{ dir: root, provider: 'claude', glob: /\.jsonl$/ }]);

    expect(outcome.files).toBe(1);
    expect(outcome.skipped).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });
});
