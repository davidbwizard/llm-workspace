import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCodexThreads, readSpawnEdges, lastStateDbError, readCodexThreadNames,
} from '../../../src/providers/codex/stateDb.ts';

let dir: string, dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codexdb-'));
  dbPath = join(dir, 'state_5.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
      source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT,
      git_branch TEXT, git_sha TEXT, model TEXT, agent_nickname TEXT,
      agent_role TEXT, thread_source TEXT, tokens_used INTEGER, archived INTEGER,
      name TEXT
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT, child_thread_id TEXT, status TEXT
    );`);
  db.prepare(`INSERT INTO threads
    (id, rollout_path, cwd, source, cli_version, git_branch, model, archived, tokens_used)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('t1', '/r/t1.jsonl', '/repo', 'vscode', '0.152.1', 'main', 'gpt-5.6-sol', 0, 400);
  db.prepare(`INSERT INTO threads
    (id, rollout_path, cwd, source, archived) VALUES (?,?,?,?,?)`)
    .run('t2', '/r/t2.jsonl', '/other', 'cli', 1);
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run('t1', 't2', 'done');
  db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readCodexThreads', () => {
  it('returns threads with the discovery fields the spec names', () => {
    const rows = readCodexThreads(dbPath)!;
    const t1 = rows.find(r => r.id === 't1')!;
    expect(t1).toMatchObject({
      rolloutPath: '/r/t1.jsonl', cwd: '/repo', source: 'vscode',
      cliVersion: '0.152.1', gitBranch: 'main', archived: false,
    });
  });

  it('marks archived threads', () => {
    const rows = readCodexThreads(dbPath)!;
    expect(rows.find(r => r.id === 't2')!.archived).toBe(true);
  });

  it('returns null rather than throwing when the file does not exist', () => {
    expect(readCodexThreads(join(dir, 'nope.sqlite'))).toBeNull();
  });

  it('returns null when the schema is unrecognized — accelerator, not dependency', () => {
    const p = join(dir, 'wrong.sqlite');
    const d = new Database(p);
    d.exec('CREATE TABLE unrelated (x INTEGER)');
    d.close();
    expect(readCodexThreads(p)).toBeNull();
  });
});

describe('readSpawnEdges', () => {
  it('returns parent/child pairs', () => {
    expect(readSpawnEdges(dbPath)).toEqual([
      { parentThreadId: 't1', childThreadId: 't2', status: 'done' },
    ]);
  });

  it('returns empty when the table is missing', () => {
    const p = join(dir, 'bare.sqlite');
    const d = new Database(p);
    d.exec('CREATE TABLE threads (id TEXT)');
    d.close();
    expect(readSpawnEdges(p)).toEqual([]);
  });
});

// A missing file, a locked/corrupt database, an unrecognized schema, and a
// bug in our own row mapping all collapse to the same null/[] from outside.
// lastStateDbError is how a caller (namely `probe`) tells them apart without
// either function's return contract changing.
describe('lastStateDbError', () => {
  it('is null after a successful read', () => {
    readCodexThreads(dbPath);
    expect(lastStateDbError()).toBeNull();
  });

  it('names the missing file when readCodexThreads fails that way', () => {
    const p = join(dir, 'nope.sqlite');
    readCodexThreads(p);
    expect(lastStateDbError()).toContain(p);
  });

  it('reports a reason when the schema is unrecognized', () => {
    const p = join(dir, 'wrong.sqlite');
    const d = new Database(p);
    d.exec('CREATE TABLE unrelated (x INTEGER)');
    d.close();
    readCodexThreads(p);
    expect(lastStateDbError()).toBeTruthy();
  });

  it('is cleared by a subsequent successful call', () => {
    readCodexThreads(join(dir, 'nope.sqlite'));
    expect(lastStateDbError()).not.toBeNull();
    readCodexThreads(dbPath);
    expect(lastStateDbError()).toBeNull();
  });

  it('tracks readSpawnEdges independently — a threads success does not mask an edges failure', () => {
    readCodexThreads(dbPath);
    expect(lastStateDbError()).toBeNull();
    const p = join(dir, 'nope.sqlite');
    readSpawnEdges(p);
    expect(lastStateDbError()).toContain(p);
  });
});

// Codex writes no live-session file, so its state database is the only place
// a Codex card can learn the name someone gave a session.
describe('readCodexThreadNames', () => {
  const seed = (rows: [string, string | null, string | null][]) => {
    const db = new Database(dbPath);
    for (const [id, name, title] of rows) {
      db.prepare('INSERT OR REPLACE INTO threads (id, name, title) VALUES (?, ?, ?)').run(id, name, title);
    }
    db.close();
  };

  it('returns the name a person chose', () => {
    seed([['t1', 'Add game flow review', 'Review the plan before implementation']]);
    expect(readCodexThreadNames(dbPath, ['t1']).get('t1')).toBe('Add game flow review');
  });

  it('never returns the derived title', () => {
    // `title` is Codex's own summary of the opening message. OpenSession.name
    // is the name "when a PERSON chose it" -- showing a machine-written
    // sentence there would read worse than the folder, which is the same
    // judgement chosenName already makes for Claude.
    seed([['t2', null, 'Renderer preferences storage security review']]);
    expect(readCodexThreadNames(dbPath, ['t2']).has('t2')).toBe(false);
  });

  it('treats an empty or whitespace name as no name', () => {
    seed([['t3', '', null], ['t4', '   ', null]]);
    const names = readCodexThreadNames(dbPath, ['t3', 't4']);
    expect(names.size).toBe(0);
  });

  it('asks only for the ids given, and answers nothing for none', () => {
    seed([['t5', 'Kept', null], ['t6', 'Other', null]]);
    expect([...readCodexThreadNames(dbPath, ['t5']).keys()]).toEqual(['t5']);
    expect(readCodexThreadNames(dbPath, []).size).toBe(0);
  });

  it('is empty rather than throwing when the database is absent or unreadable', () => {
    // Codex owns this file: it can be mid-write, locked, or a schema this
    // version has never seen, and none of that may cost the fleet its cards.
    expect(readCodexThreadNames(join(dir, 'nope.sqlite'), ['t1']).size).toBe(0);
    const broken = join(dir, 'broken.sqlite');
    const db = new Database(broken);
    db.exec('CREATE TABLE unrelated (x TEXT);');
    db.close();
    expect(readCodexThreadNames(broken, ['t1']).size).toBe(0);
  });
});
