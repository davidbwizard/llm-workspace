import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { countEvents } from '../../src/store/ingest.ts';
import { ingestFileOnce } from '../../src/watch/watcher.ts';

let dir: string, file: string;
const REC = (u: string, text: string) => JSON.stringify({
  type: 'assistant', uuid: u, sessionId: 's1', timestamp: '2026-09-10T00:00:00.000Z',
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
    expect(rows[0].agent_id).toBe('agent-reviewer-abc');
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
    expect(rows.map(r => r.agent_id)).toContain('agent-late-joiner');
  });
});
