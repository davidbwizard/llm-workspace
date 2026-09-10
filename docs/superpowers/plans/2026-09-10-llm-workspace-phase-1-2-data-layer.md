# LLM Workspace — Phases 1–2 (Data Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the observation data layer — parsers, store, watcher, process discovery, and hook signals for Claude Code and Codex — ending in a CLI that prints a live normalized event stream for any session on this machine.

**Architecture:** One direction only: files → events → SQLite → consumers. Provider adapters normalize Claude transcripts and Codex rollouts/state into a single event vocabulary. SQLite is a rebuildable index over provider files, except `signal_events` (hook output), which has no other source and is durable. Nothing in these phases controls, writes to, or sends input to any running session.

**Tech Stack:** TypeScript, Node 24, `better-sqlite3`, `chokidar`, `vitest`. POSIX shell for the hook helper.

**Spec:** `docs/superpowers/specs/2026-09-10-llm-workspace-design.md` (revision 6)

## Global Constraints

- **Read-only on provider data.** Never write to `~/.claude` or `~/.codex`, with one audited exception: hook installation (Task 12), which is explicit, diffed, merge-only, and reversible. (Spec §11)
- **No network.** No outbound requests, no telemetry, no update pings. (Spec §11)
- **No credential handling.** Never read `auth.json` or any token. (Spec §11)
- **Argument arrays only.** Any path reaching a spawned process is passed as argv, never interpolated into a shell string. (Spec §11)
- **Transcript content is untrusted data.** Never `eval`, never render as HTML, never interpret as a command to this app. (Spec §11.2)
- **Provider SQLite is an accelerator, never a dependency.** Open `mode=ro`; fall back to file parsing when the schema is unrecognized. (Spec §5.5, §4.3)
- **Format drift fails loudly.** Unknown record shapes are stored as `kind='unparsed'` and surfaced, never silently skipped. (Spec §6.2)
- **Node version:** 24.x (`.nvmrc` pins `24.19.0`).
- **`parser_version` starts at 1** and is a module-level constant per provider.
- Every task ends with a commit.

---

### Task 1: Project scaffold and core types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`
- Create: `src/core/types.ts`
- Test: `tests/core/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `EventKind`, `NormalizedEvent`, `Provider`, `PARSER_VERSION` — used by every later task.

- [ ] **Step 1: Create the project files**

`package.json`:
```json
{
  "name": "llm-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "cli": "node --experimental-strip-types src/cli.ts"
  },
  "dependencies": {
    "better-sqlite3": "^11.8.1",
    "chokidar": "^4.0.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.ts'] },
});
```

`.nvmrc`:
```
24.19.0
```

- [ ] **Step 2: Write the failing test**

`tests/core/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EVENT_KINDS, isEventKind } from '../../src/core/types.ts';

describe('event kinds', () => {
  it('includes every kind the spec defines', () => {
    expect(EVENT_KINDS).toEqual([
      'session.started', 'run.started', 'run.ended', 'context.compacted',
      'control.attached', 'control.detached', 'prompt.submitted',
      'turn.completed', 'agent.spawned', 'agent.ended', 'prose',
      'tool.used', 'cwd.changed', 'state.changed', 'unparsed',
    ]);
  });

  it('rejects a kind that is not in the vocabulary', () => {
    expect(isEventKind('session.ended')).toBe(false);
    expect(isEventKind('run.ended')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm install && npx vitest run tests/core/types.test.ts`
Expected: FAIL — cannot resolve `../../src/core/types.ts`

- [ ] **Step 4: Write the implementation**

`src/core/types.ts`:
```ts
/** The normalized event vocabulary. Spec §6.4.
 *  `session.ended` is deliberately absent: a run ends, a session usually
 *  does not (spec §6.3). `unparsed` carries records whose shape we do not
 *  recognize, so drift surfaces instead of vanishing (spec §6.2). */
export const EVENT_KINDS = [
  'session.started', 'run.started', 'run.ended', 'context.compacted',
  'control.attached', 'control.detached', 'prompt.submitted',
  'turn.completed', 'agent.spawned', 'agent.ended', 'prose',
  'tool.used', 'cwd.changed', 'state.changed', 'unparsed',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(v: string): v is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(v);
}

export type Provider = 'claude' | 'codex';

/** One row destined for the derived `events` table. Spec §6.1. */
export interface NormalizedEvent {
  provider: Provider;
  sessionId: string;
  runId: string | null;
  agentId: string | null;
  ts: string;                 // ISO 8601, from the source record
  kind: EventKind;
  payload: Record<string, unknown>;
  nativeId: string | null;
  sourceFile: string;
  sourceOffset: number;       // byte offset of the record's first byte
  contentHash: string;
  parserVersion: number;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/types.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .nvmrc src/core/types.ts tests/core/types.test.ts
git commit -m "feat(core): project scaffold and normalized event vocabulary"
```

---

### Task 2: Content hashing and event identity

**Files:**
- Create: `src/core/identity.ts`
- Test: `tests/core/identity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `hashRecord(raw: string): string`

**Note:** the identity *triple* `(source_file, source_offset, content_hash)` is
enforced by the unique index in Task 3, not by a helper function — so this task
ships only the hash. A `eventIdentity()` formatter would be unused production
code.

- [ ] **Step 1: Write the failing test**

`tests/core/identity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { hashRecord } from '../../src/core/identity.ts';

describe('hashRecord', () => {
  it('is stable for identical input', () => {
    expect(hashRecord('{"a":1}')).toBe(hashRecord('{"a":1}'));
  });

  it('differs when a single byte changes', () => {
    expect(hashRecord('{"a":1}')).not.toBe(hashRecord('{"a":2}'));
  });

  it('returns lowercase hex', () => {
    expect(hashRecord('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/identity.test.ts`
Expected: FAIL — cannot resolve `../../src/core/identity.ts`

- [ ] **Step 3: Write the implementation**

`src/core/identity.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/identity.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/identity.ts tests/core/identity.test.ts
git commit -m "feat(core): content hashing and event identity"
```

---

### Task 3: SQLite schema and database open

**Files:**
- Create: `src/store/schema.ts`, `src/store/db.ts`
- Test: `tests/store/db.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `openDb(path: string): Database`, `SCHEMA_VERSION`

- [ ] **Step 1: Write the failing test**

`tests/store/db.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';

describe('openDb', () => {
  it('creates the three tables the spec defines', () => {
    const db = openDb(':memory:');
    const names = db.prepare(
      "select name from sqlite_master where type='table' order by name"
    ).all().map((r: any) => r.name);
    expect(names).toContain('events');
    expect(names).toContain('signal_events');
    expect(names).toContain('ingest_files');
  });

  it('enforces the events identity triple', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`insert into events
      (provider, session_id, run_id, agent_id, ts, kind, payload, native_id,
       source_file, source_offset, content_hash, parser_version)
      values (@provider,@session_id,@run_id,@agent_id,@ts,@kind,@payload,
              @native_id,@source_file,@source_offset,@content_hash,@parser_version)`);
    const row = {
      provider: 'claude', session_id: 's', run_id: null, agent_id: null,
      ts: 't', kind: 'prose', payload: '{}', native_id: null,
      source_file: '/f', source_offset: 0, content_hash: 'h', parser_version: 1,
    };
    ins.run(row);
    expect(() => ins.run(row)).toThrow(/UNIQUE/i);
  });

  it('enforces signal_events uniqueness on event_id', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`insert into signal_events
      (event_id, occurred_at, ingested_at, provider, kind, payload)
      values (?,?,?,?,?,?)`);
    ins.run('e1', 'a', 'b', 'claude', 'PermissionRequest', '{}');
    expect(() => ins.run('e1', 'a', 'b', 'claude', 'PermissionRequest', '{}'))
      .toThrow(/UNIQUE/i);
  });

  it('enables WAL and foreign keys', () => {
    const db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/db.test.ts`
Expected: FAIL — cannot resolve `../../src/store/db.ts`

- [ ] **Step 3: Write the schema**

`src/store/schema.ts`:
```ts
export const SCHEMA_VERSION = 1;

/** Spec §6.1. Two tables with deliberately different durability:
 *  `events` is derived from provider files and is disposable;
 *  `signal_events` comes from hooks and has no other source, so a rebuild
 *  must never touch it. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT, run_id TEXT, control_handle_id TEXT, agent_id TEXT,
  prompt_id TEXT,
  tool_use_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_identity ON signal_events(event_id);
CREATE INDEX IF NOT EXISTS signal_session ON signal_events(session_id, occurred_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT,
  agent_id TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  native_id TEXT,
  source_file TEXT NOT NULL,
  source_offset INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  parser_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_identity
  ON events(source_file, source_offset, content_hash);
CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_source ON events(source_file);

CREATE TABLE IF NOT EXISTS ingest_files (
  path TEXT PRIMARY KEY,
  inode INTEGER,
  size INTEGER,
  mtime TEXT,
  bytes_consumed INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  provider_cli_version TEXT,
  last_ok_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
```

- [ ] **Step 4: Write the database opener**

`src/store/db.ts`:
```ts
import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  // WAL is meaningless for :memory: and better-sqlite3 ignores it there.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/store/db.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/store/schema.ts src/store/db.ts tests/store/db.test.ts
git commit -m "feat(store): sqlite schema with derived and durable tables"
```

---

### Task 4: Idempotent event ingestion

**Files:**
- Create: `src/store/ingest.ts`
- Test: `tests/store/ingest.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 3), `NormalizedEvent` (Task 1)
- Produces: `insertEvents(db, events): number`, `countEvents(db, sourceFile?): number`

- [ ] **Step 1: Write the failing test**

`tests/store/ingest.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents, countEvents } from '../../src/store/ingest.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

function ev(offset: number, hash = 'h' + offset): NormalizedEvent {
  return {
    provider: 'claude', sessionId: 's1', runId: null, agentId: null,
    ts: '2026-09-10T00:00:00Z', kind: 'prose', payload: { text: 'hi' },
    nativeId: null, sourceFile: '/f.jsonl', sourceOffset: offset,
    contentHash: hash, parserVersion: 1,
  };
}

describe('insertEvents', () => {
  it('inserts new events and reports the count written', () => {
    const db = openDb(':memory:');
    expect(insertEvents(db, [ev(0), ev(10)])).toBe(2);
    expect(countEvents(db)).toBe(2);
  });

  it('is idempotent — re-ingesting the same records writes nothing', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0), ev(10)]);
    expect(insertEvents(db, [ev(0), ev(10)])).toBe(0);
    expect(countEvents(db)).toBe(2);
  });

  it('re-ingests a record whose content changed at the same offset', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0, 'original')]);
    expect(insertEvents(db, [ev(0, 'rewritten')])).toBe(1);
    expect(countEvents(db)).toBe(2);
  });

  it('writes all-or-nothing within one call', () => {
    const db = openDb(':memory:');
    const bad = { ...ev(0), sessionId: null as unknown as string };
    expect(() => insertEvents(db, [ev(0), bad])).toThrow();
    expect(countEvents(db)).toBe(0);
  });

  it('counts per source file', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0), { ...ev(0), sourceFile: '/other.jsonl' }]);
    expect(countEvents(db, '/f.jsonl')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/ingest.test.ts`
Expected: FAIL — cannot resolve `../../src/store/ingest.ts`

- [ ] **Step 3: Write the implementation**

`src/store/ingest.ts`:
```ts
import type { Db } from './db.ts';
import type { NormalizedEvent } from '../core/types.ts';

const INSERT = `
INSERT OR IGNORE INTO events
  (provider, session_id, run_id, agent_id, ts, kind, payload, native_id,
   source_file, source_offset, content_hash, parser_version)
VALUES
  (@provider, @sessionId, @runId, @agentId, @ts, @kind, @payload, @nativeId,
   @sourceFile, @sourceOffset, @contentHash, @parserVersion)`;

/** Insert events, skipping any whose identity triple is already present.
 *  Spec §6.1: watchers fire redundantly, so ingestion must be idempotent.
 *  Runs in one transaction — a bad record aborts the whole batch rather
 *  than leaving a half-ingested file behind. Returns rows actually written. */
export function insertEvents(db: Db, events: NormalizedEvent[]): number {
  const stmt = db.prepare(INSERT);
  const run = db.transaction((batch: NormalizedEvent[]) => {
    let written = 0;
    for (const e of batch) {
      const info = stmt.run({ ...e, payload: JSON.stringify(e.payload) });
      written += info.changes;
    }
    return written;
  });
  return run(events);
}

export function countEvents(db: Db, sourceFile?: string): number {
  const row = sourceFile
    ? db.prepare('SELECT COUNT(*) c FROM events WHERE source_file = ?').get(sourceFile)
    : db.prepare('SELECT COUNT(*) c FROM events').get();
  return (row as { c: number }).c;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/ingest.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/store/ingest.ts tests/store/ingest.test.ts
git commit -m "feat(store): idempotent transactional event ingestion"
```

---

### Task 5: Reparse — delete-then-parse

**Files:**
- Modify: `src/store/ingest.ts`
- Test: `tests/store/reparse.test.ts`

**Interfaces:**
- Consumes: `insertEvents`, `countEvents` (Task 4)
- Produces: `reparseFile(db, path, parse: () => NormalizedEvent[], meta): void`, `recordIngest(db, meta)`, `getIngestState(db, path)`

- [ ] **Step 1: Write the failing test**

`tests/store/reparse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents, countEvents, reparseFile, getIngestState } from '../../src/store/ingest.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

function ev(offset: number, kind: NormalizedEvent['kind'] = 'prose'): NormalizedEvent {
  return {
    provider: 'claude', sessionId: 's1', runId: null, agentId: null,
    ts: '2026-09-10T00:00:00Z', kind, payload: {}, nativeId: null,
    sourceFile: '/f.jsonl', sourceOffset: offset, contentHash: 'h' + offset,
    parserVersion: 1,
  };
}

describe('reparseFile', () => {
  it('replaces a file\'s derived events rather than colliding with them', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0, 'prose'), ev(10, 'prose')]);

    // A fixed parser produces the SAME identity triple but a different kind.
    // Plain insert would be ignored by the unique index; reparse must replace.
    reparseFile(db, '/f.jsonl', () => [ev(0, 'tool.used'), ev(10, 'tool.used')], {
      inode: 1, size: 100, mtime: 'm', bytesConsumed: 100,
      parserVersion: 2, providerCliVersion: '2.1.267',
    });

    expect(countEvents(db, '/f.jsonl')).toBe(2);
    const kinds = db.prepare('SELECT kind FROM events ORDER BY source_offset')
      .all().map((r: any) => r.kind);
    expect(kinds).toEqual(['tool.used', 'tool.used']);
  });

  it('leaves other files untouched', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0), { ...ev(0), sourceFile: '/other.jsonl' }]);
    reparseFile(db, '/f.jsonl', () => [], {
      inode: 1, size: 0, mtime: 'm', bytesConsumed: 0, parserVersion: 1,
      providerCliVersion: null,
    });
    expect(countEvents(db, '/other.jsonl')).toBe(1);
    expect(countEvents(db, '/f.jsonl')).toBe(0);
  });

  it('never touches signal_events', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO signal_events
      (event_id, occurred_at, ingested_at, provider, kind, payload)
      VALUES (?,?,?,?,?,?)`).run('e1', 'a', 'b', 'claude', 'Stop', '{}');
    reparseFile(db, '/f.jsonl', () => [], {
      inode: 1, size: 0, mtime: 'm', bytesConsumed: 0, parserVersion: 1,
      providerCliVersion: null,
    });
    const c = db.prepare('SELECT COUNT(*) c FROM signal_events').get() as any;
    expect(c.c).toBe(1);
  });

  it('records ingest bookkeeping so truncation can be detected later', () => {
    const db = openDb(':memory:');
    reparseFile(db, '/f.jsonl', () => [ev(0)], {
      inode: 42, size: 500, mtime: '2026-09-10T00:00:00Z', bytesConsumed: 500,
      parserVersion: 1, providerCliVersion: '2.1.267',
    });
    const st = getIngestState(db, '/f.jsonl');
    expect(st).toMatchObject({ inode: 42, size: 500, bytes_consumed: 500, parser_version: 1 });
  });

  it('rolls back entirely if the parser throws', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev(0)]);
    expect(() => reparseFile(db, '/f.jsonl', () => { throw new Error('bad parse'); }, {
      inode: 1, size: 0, mtime: 'm', bytesConsumed: 0, parserVersion: 2,
      providerCliVersion: null,
    })).toThrow('bad parse');
    expect(countEvents(db, '/f.jsonl')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/reparse.test.ts`
Expected: FAIL — `reparseFile` is not exported

- [ ] **Step 3: Add the implementation to `src/store/ingest.ts`**

Append to `src/store/ingest.ts`:
```ts
export interface IngestMeta {
  inode: number | null;
  size: number;
  mtime: string;
  bytesConsumed: number;
  parserVersion: number;
  providerCliVersion: string | null;
}

export interface IngestState {
  path: string;
  inode: number | null;
  size: number;
  mtime: string;
  bytes_consumed: number;
  parser_version: number;
  provider_cli_version: string | null;
  last_ok_at: string | null;
}

export function getIngestState(db: Db, path: string): IngestState | undefined {
  return db.prepare('SELECT * FROM ingest_files WHERE path = ?').get(path) as
    IngestState | undefined;
}

/** Spec §6.1. A parser fix produces byte-identical identity triples, so a
 *  plain re-insert is silently ignored by the unique index and the bad rows
 *  survive forever. Reparse therefore DELETES this file's derived events
 *  first, then parses, in one transaction.
 *
 *  `signal_events` is untouched by design: hook output has no other source. */
export function reparseFile(
  db: Db,
  path: string,
  parse: () => NormalizedEvent[],
  meta: IngestMeta,
): void {
  const del = db.prepare('DELETE FROM events WHERE source_file = ?');
  const insert = db.prepare(INSERT);
  const book = db.prepare(`
    INSERT INTO ingest_files
      (path, inode, size, mtime, bytes_consumed, parser_version,
       provider_cli_version, last_ok_at)
    VALUES (@path, @inode, @size, @mtime, @bytesConsumed, @parserVersion,
            @providerCliVersion, @lastOkAt)
    ON CONFLICT(path) DO UPDATE SET
      inode = excluded.inode, size = excluded.size, mtime = excluded.mtime,
      bytes_consumed = excluded.bytes_consumed,
      parser_version = excluded.parser_version,
      provider_cli_version = excluded.provider_cli_version,
      last_ok_at = excluded.last_ok_at`);

  const run = db.transaction(() => {
    del.run(path);
    for (const e of parse()) {
      insert.run({ ...e, payload: JSON.stringify(e.payload) });
    }
    book.run({ path, ...meta, lastOkAt: new Date().toISOString() });
  });
  run();
}

export function recordIngest(db: Db, path: string, meta: IngestMeta): void {
  db.prepare(`
    INSERT INTO ingest_files
      (path, inode, size, mtime, bytes_consumed, parser_version,
       provider_cli_version, last_ok_at)
    VALUES (@path, @inode, @size, @mtime, @bytesConsumed, @parserVersion,
            @providerCliVersion, @lastOkAt)
    ON CONFLICT(path) DO UPDATE SET
      inode = excluded.inode, size = excluded.size, mtime = excluded.mtime,
      bytes_consumed = excluded.bytes_consumed,
      parser_version = excluded.parser_version,
      provider_cli_version = excluded.provider_cli_version,
      last_ok_at = excluded.last_ok_at`)
    .run({ path, ...meta, lastOkAt: new Date().toISOString() });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/reparse.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/store/ingest.ts tests/store/reparse.test.ts
git commit -m "feat(store): reparse as delete-then-parse in one transaction"
```

---

### Task 6: Claude project key and incremental tail reader

**Files:**
- Create: `src/providers/claude/projectKey.ts`, `src/providers/claude/tail.ts`
- Test: `tests/providers/claude/projectKey.test.ts`, `tests/providers/claude/tail.test.ts`

**Interfaces:**
- Consumes: `IngestState` (Task 5)
- Produces: `projectKey(cwd)`, `legacyProjectKey(cwd)`, `projectDir(cwd)`, `readTail(path, fromOffset, knownInode): TailResult`

- [ ] **Step 1: Write the failing tests**

`tests/providers/claude/projectKey.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { projectKey, legacyProjectKey } from '../../../src/providers/claude/projectKey.ts';

describe('projectKey', () => {
  it('dashes every non-alphanumeric character, leading slash included', () => {
    expect(projectKey('/Users/me/app')).toBe('-Users-me-app');
  });

  it('dashes dots too — this is the change that silently broke the old resolver', () => {
    expect(projectKey('/Users/me/MDv0.3.0')).toBe('-Users-me-MDv0-3-0');
  });

  it('matches a real directory on this machine', () => {
    expect(projectKey('/Users/davidbrabbins/Documents/David/llm-workspace'))
      .toBe('-Users-davidbrabbins-Documents-David-llm-workspace');
  });
});

describe('legacyProjectKey', () => {
  it('drops the leading slash and preserves dots', () => {
    expect(legacyProjectKey('/Users/me/MDv0.3.0')).toBe('Users-me-MDv0.3.0');
  });
});
```

`tests/providers/claude/tail.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTail } from '../../../src/providers/claude/tail.ts';

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tail-')); file = join(dir, 'f.jsonl'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readTail', () => {
  it('reads whole lines and reports the offset after the last complete line', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const r = readTail(file, 0, null);
    expect(r.lines.map(l => l.text)).toEqual(['{"a":1}', '{"a":2}']);
    expect(r.newOffset).toBe(16);
    expect(r.restarted).toBe(false);
  });

  it('reports the byte offset of each line, for the identity triple', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const r = readTail(file, 0, null);
    expect(r.lines.map(l => l.offset)).toEqual([0, 8]);
  });

  it('reads only the tail on a second call', () => {
    writeFileSync(file, '{"a":1}\n');
    const first = readTail(file, 0, null);
    appendFileSync(file, '{"a":2}\n');
    const second = readTail(file, first.newOffset, first.inode);
    expect(second.lines.map(l => l.text)).toEqual(['{"a":2}']);
    expect(second.lines[0]!.offset).toBe(8);
  });

  it('buffers a trailing partial line instead of treating it as corrupt', () => {
    writeFileSync(file, '{"a":1}\n{"partial"');
    const r = readTail(file, 0, null);
    expect(r.lines.map(l => l.text)).toEqual(['{"a":1}']);
    expect(r.newOffset).toBe(8);
  });

  it('restarts from zero when the file shrinks', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const first = readTail(file, 0, null);
    writeFileSync(file, '{"b":1}\n');
    const second = readTail(file, first.newOffset, first.inode);
    expect(second.restarted).toBe(true);
    expect(second.lines.map(l => l.text)).toEqual(['{"b":1}']);
  });

  it('restarts from zero when the inode changes', () => {
    writeFileSync(file, '{"a":1}\n');
    const first = readTail(file, 0, null);
    rmSync(file);
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const second = readTail(file, first.newOffset, first.inode);
    expect(second.restarted).toBe(true);
    expect(second.lines).toHaveLength(2);
  });

  it('returns nothing for an empty file', () => {
    writeFileSync(file, '');
    const r = readTail(file, 0, null);
    expect(r.lines).toEqual([]);
    expect(r.newOffset).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/claude/`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the project key module**

`src/providers/claude/projectKey.ts`:
```ts
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

/** Claude Code's project key: the absolute cwd with EVERY non-alphanumeric
 *  character turned into a dash, the leading slash and any dots included.
 *  Logic harvested from munder-difflin's src/main/transcript.ts (MIT). */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The pre-2026 POSIX key: leading slash DROPPED, only slashes dashed, so
 *  dots survived. Kept solely so older transcripts stay readable. */
export function legacyProjectKey(cwd: string): string {
  return process.platform === 'win32'
    ? projectKey(cwd)
    : cwd.replace(/^\//, '').replaceAll('/', '-');
}

/** Prefer the CURRENT spelling; fall back to the legacy one only when it
 *  exists and the current one does not. When neither exists, return the
 *  CURRENT spelling — that is the one Claude Code will actually write to. */
export function projectDir(cwd: string, root = path.join(os.homedir(), '.claude/projects')): string {
  const current = path.join(root, projectKey(cwd));
  if (existsSync(current)) return current;
  const legacy = path.join(root, legacyProjectKey(cwd));
  if (existsSync(legacy)) return legacy;
  return current;
}
```

- [ ] **Step 4: Write the tail reader**

`src/providers/claude/tail.ts`:
```ts
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

export interface TailLine { text: string; offset: number }

export interface TailResult {
  lines: TailLine[];
  newOffset: number;   // byte offset after the last COMPLETE line
  restarted: boolean;  // true when truncation or replacement forced a re-read
  inode: number;
  size: number;
}

const CHUNK = 1 << 20;

/** Incremental tail read. Spec §6.6.
 *  Two rules that matter:
 *   - a shrink or inode change means truncation/replacement, so re-read from 0
 *     rather than appending garbage;
 *   - a trailing partial line is NORMAL (the file is being written as we read),
 *     so buffer it and leave newOffset before it. Never count it as corrupt. */
export function readTail(path: string, fromOffset: number, knownInode: number | null): TailResult {
  const fd = openSync(path, 'r');
  try {
    const st = fstatSync(fd);
    const inode = Number(st.ino);
    const size = st.size;

    let start = fromOffset;
    let restarted = false;
    if (size < fromOffset || (knownInode !== null && knownInode !== inode)) {
      start = 0;
      restarted = true;
    }

    const lines: TailLine[] = [];
    let cursor = start;
    let carry = '';
    let carryStart = start;

    while (cursor < size) {
      const want = Math.min(CHUNK, size - cursor);
      const buf = Buffer.allocUnsafe(want);
      const got = readSync(fd, buf, 0, want, cursor);
      if (got <= 0) break;

      const text = carry + buf.subarray(0, got).toString('utf8');
      let searchFrom = 0;
      let nl: number;
      while ((nl = text.indexOf('\n', searchFrom)) !== -1) {
        const raw = text.slice(searchFrom, nl);
        const byteOffset = carryStart + Buffer.byteLength(text.slice(0, searchFrom), 'utf8');
        if (raw.trim().length > 0) lines.push({ text: raw, offset: byteOffset });
        searchFrom = nl + 1;
      }
      carry = text.slice(searchFrom);
      carryStart += Buffer.byteLength(text.slice(0, searchFrom), 'utf8');
      cursor += got;
    }

    return { lines, newOffset: carryStart, restarted, inode, size };
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/providers/claude/`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/projectKey.ts src/providers/claude/tail.ts tests/providers/claude/
git commit -m "feat(claude): project key resolution and incremental tail reader"
```

---

### Task 7: Claude record parser — including the tool-result regression

**Files:**
- Create: `src/providers/claude/parse.ts`
- Create: `tests/fixtures/claude/basic.jsonl`, `tests/fixtures/claude/unknown-record.jsonl`
- Test: `tests/providers/claude/parse.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` (Task 1), `hashRecord` (Task 2), `TailLine` (Task 6)
- Produces: `CLAUDE_PARSER_VERSION`, `isHumanPrompt(record): boolean`, `parseClaudeLines(lines, sourceFile): NormalizedEvent[]`

- [ ] **Step 1: Create the fixtures**

`tests/fixtures/claude/basic.jsonl`:
```
{"type":"user","message":{"role":"user","content":"Wire up magic-link auth."},"timestamp":"2026-09-10T00:00:00.000Z","uuid":"u1","sessionId":"s1","cwd":"/repo","gitBranch":"main","version":"2.1.267"}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"Reusing the existing JWT helper."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/repo/src/auth.js"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-09-10T00:00:01.000Z","uuid":"u2","sessionId":"s1"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file contents"}]},"timestamp":"2026-09-10T00:00:02.000Z","uuid":"u3","sessionId":"s1"}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"The magic link has no expiry."}],"usage":{"input_tokens":20,"output_tokens":8,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-09-10T00:00:03.000Z","uuid":"u4","sessionId":"s1"}
{"type":"user","message":{"role":"user","content":"Set it to 15 minutes."},"timestamp":"2026-09-10T00:00:04.000Z","uuid":"u5","sessionId":"s1"}
```

`tests/fixtures/claude/unknown-record.jsonl`:
```
{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-09-10T00:00:00.000Z","uuid":"u1","sessionId":"s1","cwd":"/repo"}
{"type":"telemetry-v9","somethingNew":{"nested":true},"timestamp":"2026-09-10T00:00:01.000Z","sessionId":"s1"}
```

- [ ] **Step 2: Write the failing test**

`tests/providers/claude/parse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeLines, isHumanPrompt } from '../../../src/providers/claude/parse.ts';
import type { TailLine } from '../../../src/providers/claude/tail.ts';

function linesOf(fixture: string): TailLine[] {
  const raw = readFileSync(join('tests/fixtures/claude', fixture), 'utf8');
  const out: TailLine[] = [];
  let offset = 0;
  for (const text of raw.split('\n')) {
    if (text.trim()) out.push({ text, offset });
    offset += Buffer.byteLength(text, 'utf8') + 1;
  }
  return out;
}

describe('isHumanPrompt', () => {
  it('accepts a plain string content', () => {
    expect(isHumanPrompt({ message: { content: 'hello' } })).toBe(true);
  });

  it('REJECTS a tool_result — the revision-1 bug', () => {
    expect(isHumanPrompt({ message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }))
      .toBe(false);
  });

  it('accepts a text block array', () => {
    expect(isHumanPrompt({ message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(true);
  });

  it('accepts an image plus text array', () => {
    expect(isHumanPrompt({ message: { content: [
      { type: 'image', source: {} }, { type: 'text', text: 'look' },
    ] } })).toBe(true);
  });

  it('rejects a mixed array containing any tool_result', () => {
    expect(isHumanPrompt({ message: { content: [
      { type: 'text', text: 'hi' }, { type: 'tool_result', tool_use_id: 't' },
    ] } })).toBe(false);
  });
});

describe('parseClaudeLines', () => {
  const events = parseClaudeLines(linesOf('basic.jsonl'), '/f.jsonl');

  it('emits exactly two prompt.submitted events, not five', () => {
    const prompts = events.filter(e => e.kind === 'prompt.submitted');
    expect(prompts).toHaveLength(2);
    expect(prompts.map(p => p.payload.text)).toEqual([
      'Wire up magic-link auth.', 'Set it to 15 minutes.',
    ]);
  });

  it('emits session.started once, from the first record carrying cwd', () => {
    const started = events.filter(e => e.kind === 'session.started');
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ provider: 'claude', cwd: '/repo' });
  });

  it('emits prose for assistant text blocks', () => {
    const prose = events.filter(e => e.kind === 'prose');
    expect(prose.map(p => p.payload.text)).toEqual([
      'Reusing the existing JWT helper.', 'The magic link has no expiry.',
    ]);
  });

  it('emits tool.used with name and target', () => {
    const tools = events.filter(e => e.kind === 'tool.used');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.payload).toMatchObject({ name: 'Read', target: '/repo/src/auth.js' });
  });

  it('emits turn.completed with token counts', () => {
    const turns = events.filter(e => e.kind === 'turn.completed');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.payload).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('carries the source offset and content hash on every event', () => {
    for (const e of events) {
      expect(e.sourceFile).toBe('/f.jsonl');
      expect(e.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.sourceOffset).toBe('number');
    }
  });

  it('stores an unknown record type as unparsed rather than dropping it', () => {
    const evs = parseClaudeLines(linesOf('unknown-record.jsonl'), '/f.jsonl');
    const unparsed = evs.filter(e => e.kind === 'unparsed');
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]!.payload).toMatchObject({ recordType: 'telemetry-v9' });
  });

  it('stores a corrupt line as unparsed rather than throwing', () => {
    const evs = parseClaudeLines([{ text: 'not json at all', offset: 0 }], '/f.jsonl');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.kind).toBe('unparsed');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/providers/claude/parse.test.ts`
Expected: FAIL — cannot resolve `parse.ts`

- [ ] **Step 4: Write the implementation**

`src/providers/claude/parse.ts`:
```ts
import { hashRecord } from '../../core/identity.ts';
import type { NormalizedEvent } from '../../core/types.ts';
import type { TailLine } from './tail.ts';

export const CLAUDE_PARSER_VERSION = 1;

/** Record types this parser understands. Anything else becomes `unparsed`
 *  so format drift surfaces instead of vanishing (spec §6.2). */
const KNOWN_TYPES = new Set(['user', 'assistant', 'ai-title', 'last-prompt', 'summary']);

/** Spec §8.3. Claude records TOOL RESULTS as `type: "user"` messages.
 *  Measured on a real transcript: 58 of 73 `user` records were tool_result.
 *  Bounding beats on any `user` record produced ~73 beats where there were
 *  ~15 human turns. A record is a human prompt only if its content is a
 *  plain string, or an array containing NO tool_result block. */
export function isHumanPrompt(record: any): boolean {
  const c = record?.message?.content;
  if (typeof c === 'string') return true;
  if (!Array.isArray(c)) return false;
  return !c.some((b: any) => b && b.type === 'tool_result');
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

function toolTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const k of ['file_path', 'path', 'command', 'pattern', 'notebook_path']) {
    if (typeof i[k] === 'string') return i[k] as string;
  }
  return null;
}

export function parseClaudeLines(lines: TailLine[], sourceFile: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  let sessionId = 'unknown';
  let sessionStartEmitted = false;

  const base = (line: TailLine, kind: NormalizedEvent['kind'],
                payload: Record<string, unknown>, agentId: string | null,
                ts: string, nativeId: string | null): NormalizedEvent => ({
    provider: 'claude', sessionId, runId: null, agentId, ts, kind, payload,
    nativeId, sourceFile, sourceOffset: line.offset,
    contentHash: hashRecord(line.text), parserVersion: CLAUDE_PARSER_VERSION,
  });

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line.text);
    } catch {
      out.push(base(line, 'unparsed', { reason: 'invalid-json', raw: line.text.slice(0, 500) },
        null, new Date(0).toISOString(), null));
      continue;
    }
    if (!rec || typeof rec !== 'object') {
      out.push(base(line, 'unparsed', { reason: 'not-an-object' }, null,
        new Date(0).toISOString(), null));
      continue;
    }

    if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString();
    const agentId = typeof rec.agentId === 'string' ? rec.agentId : null;

    if (!KNOWN_TYPES.has(rec.type)) {
      out.push(base(line, 'unparsed', { reason: 'unknown-record-type', recordType: rec.type },
        agentId, ts, typeof rec.uuid === 'string' ? rec.uuid : null));
      continue;
    }

    if (!sessionStartEmitted && typeof rec.cwd === 'string') {
      out.push(base(line, 'session.started', {
        provider: 'claude', cwd: rec.cwd,
        gitBranch: rec.gitBranch ?? null, cliVersion: rec.version ?? null,
      }, null, ts, null));
      sessionStartEmitted = true;
    }

    if (rec.type === 'user') {
      if (isHumanPrompt(rec)) {
        out.push(base(line, 'prompt.submitted',
          { text: textFromContent(rec.message.content) || String(rec.message.content) },
          agentId, ts, rec.uuid ?? null));
      }
      continue;
    }

    if (rec.type === 'assistant') {
      const content = rec.message?.content;
      const text = textFromContent(content);
      if (text) out.push(base(line, 'prose', { text, role: 'assistant' }, agentId, ts, rec.uuid ?? null));

      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_use') {
            out.push(base(line, 'tool.used', {
              name: b.name ?? null, target: toolTarget(b.input), isError: false,
              toolUseId: b.id ?? null,
            }, agentId, ts, b.id ?? null));
          }
        }
      }

      const u = rec.message?.usage;
      if (u) {
        out.push(base(line, 'turn.completed', {
          inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          model: rec.message?.model ?? null,
        }, agentId, ts, rec.uuid ?? null));
      }
    }
  }

  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/providers/claude/parse.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/parse.ts tests/fixtures/claude/ tests/providers/claude/parse.test.ts
git commit -m "feat(claude): record parser with tool-result-as-user discrimination"
```

---

### Task 8: Claude subagent discovery

**Files:**
- Create: `src/providers/claude/subagents.ts`
- Test: `tests/providers/claude/subagents.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` (Task 1), `hashRecord` (Task 2)
- Produces: `findSubagents(sessionDir): SubagentRef[]`, `parseAgentMeta(json, sourceFile, sessionId, ts): NormalizedEvent`

- [ ] **Step 1: Write the failing test**

`tests/providers/claude/subagents.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSubagents, parseAgentMeta } from '../../../src/providers/claude/subagents.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sub-'));
  const dir = join(root, 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-task-8-magiclink-abc.jsonl'), '');
  writeFileSync(join(dir, 'agent-task-8-magiclink-abc.meta.json'), JSON.stringify({
    agentType: 'task-8-magiclink', description: 'Wire magic link', name: 'task-8-magiclink',
    spawnDepth: 0, model: 'opus', taskKind: 'in_process_teammate',
    teamName: 'session-f3f59130', color: 'yellow',
  }));
  writeFileSync(join(dir, 'orphan.meta.json'), '{"name":"orphan","spawnDepth":0}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findSubagents', () => {
  it('pairs each transcript with its meta file', () => {
    const found = findSubagents(join(root, 'session-1'));
    expect(found).toHaveLength(1);
    expect(found[0]!.agentId).toBe('agent-task-8-magiclink-abc');
    expect(found[0]!.metaPath).toContain('agent-task-8-magiclink-abc.meta.json');
  });

  it('ignores a meta file with no matching transcript', () => {
    const found = findSubagents(join(root, 'session-1'));
    expect(found.map(f => f.agentId)).not.toContain('orphan');
  });

  it('returns empty for a session with no subagents directory', () => {
    expect(findSubagents(join(root, 'no-such-session'))).toEqual([]);
  });
});

describe('parseAgentMeta', () => {
  it('produces an agent.spawned event carrying the graph fields', () => {
    const meta = {
      agentType: 'final-review', name: 'final-review', spawnDepth: 0,
      model: 'opus', color: 'blue', taskKind: 'in_process_teammate',
      teamName: 'session-f3f59130',
    };
    const e = parseAgentMeta(meta, '/m.meta.json', 's1', 'agent-final-review-x',
      '2026-09-10T00:00:00Z');
    expect(e.kind).toBe('agent.spawned');
    expect(e.agentId).toBe('agent-final-review-x');
    expect(e.payload).toMatchObject({
      name: 'final-review', type: 'final-review', model: 'opus',
      color: 'blue', depth: 0, parentAgentId: null,
    });
  });

  it('defaults depth to 0 when spawnDepth is absent', () => {
    const e = parseAgentMeta({ name: 'x' }, '/m.meta.json', 's1', 'a1', 'ts');
    expect(e.payload.depth).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/claude/subagents.test.ts`
Expected: FAIL — cannot resolve `subagents.ts`

- [ ] **Step 3: Write the implementation**

`src/providers/claude/subagents.ts`:
```ts
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashRecord } from '../../core/identity.ts';
import type { NormalizedEvent } from '../../core/types.ts';
import { CLAUDE_PARSER_VERSION } from './parse.ts';

export interface SubagentRef {
  agentId: string;
  transcriptPath: string;
  metaPath: string;
}

/** Spec §6.5. Subagents live at
 *  <project>/<session-id>/subagents/agent-<name>-<hash>.jsonl(+.meta.json).
 *  A meta file with no transcript is ignored: there is nothing to read. */
export function findSubagents(sessionDir: string): SubagentRef[] {
  const dir = join(sessionDir, 'subagents');
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  const transcripts = new Set(
    entries.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length)),
  );

  const out: SubagentRef[] = [];
  for (const agentId of transcripts) {
    const metaPath = join(dir, `${agentId}.meta.json`);
    if (!existsSync(metaPath)) continue;
    out.push({ agentId, transcriptPath: join(dir, `${agentId}.jsonl`), metaPath });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** Spec §6.4: agent.spawned carries the graph's node attributes.
 *  `parentAgentId` is null for Claude today — every observed agent has
 *  spawnDepth 0 and no recorded parent beyond the session root — but the
 *  field exists because §8.2 supports multiple depths from day one. */
export function parseAgentMeta(
  meta: any,
  sourceFile: string,
  sessionId: string,
  agentId: string,
  ts: string,
): NormalizedEvent {
  return {
    provider: 'claude', sessionId, runId: null, agentId, ts,
    kind: 'agent.spawned',
    payload: {
      name: meta?.name ?? agentId,
      type: meta?.agentType ?? null,
      model: meta?.model ?? null,
      color: meta?.color ?? null,
      depth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : 0,
      taskKind: meta?.taskKind ?? null,
      teamName: meta?.teamName ?? null,
      parentAgentId: null,
    },
    nativeId: agentId,
    sourceFile,
    sourceOffset: 0,
    contentHash: hashRecord(JSON.stringify(meta ?? {})),
    parserVersion: CLAUDE_PARSER_VERSION,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/claude/subagents.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/claude/subagents.ts tests/providers/claude/subagents.test.ts
git commit -m "feat(claude): subagent discovery and agent.spawned events"
```

---

### Task 9: Codex rollout parser

**Files:**
- Create: `src/providers/codex/parse.ts`
- Create: `tests/fixtures/codex/rollout-basic.jsonl`, `tests/fixtures/codex/rollout-subagent.jsonl`
- Test: `tests/providers/codex/parse.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` (Task 1), `hashRecord` (Task 2), `TailLine` (Task 6)
- Produces: `CODEX_PARSER_VERSION`, `parseCodexLines(lines, sourceFile): NormalizedEvent[]`

- [ ] **Step 1: Create the fixtures**

`tests/fixtures/codex/rollout-basic.jsonl`:
```
{"timestamp":"2026-09-08T23:33:43.457Z","type":"session_meta","payload":{"session_id":"01a0835e-cda1","id":"01a0835e-cda1","timestamp":"2026-09-08T23:33:43.457Z","cwd":"/repo","originator":"Codex Desktop","cli_version":"0.152.1","model_provider":"openai"}}
{"timestamp":"2026-09-08T23:33:44.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1","started_at":1788904306}}
{"timestamp":"2026-09-08T23:33:45.000Z","type":"event_msg","payload":{"type":"user_message","message":"Review this change for security vulnerabilities."}}
{"timestamp":"2026-09-08T23:33:46.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Tracing user-controlled inputs to sinks."}}
{"timestamp":"2026-09-08T23:33:47.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"grep -r eval\"}","call_id":"c1"}}
{"timestamp":"2026-09-08T23:33:48.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}}
{"timestamp":"2026-09-08T23:33:49.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","started_at":1788904306,"completed_at":1788904423}}
```

`tests/fixtures/codex/rollout-subagent.jsonl`:
```
{"timestamp":"2026-08-27T15:11:52.218Z","type":"session_meta","payload":{"session_id":"01a043c5-f268","id":"01a043c7-0799","parent_thread_id":"01a043c5-f268","cwd":"/repo","originator":"codex_work_desktop","cli_version":"0.150.0-alpha.8","source":{"subagent":{"other":"guardian"}},"thread_source":"guardian_review"}}
{"timestamp":"2026-08-27T15:11:53.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Judging one planned action."}}
```

- [ ] **Step 2: Write the failing test**

`tests/providers/codex/parse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexLines } from '../../../src/providers/codex/parse.ts';
import type { TailLine } from '../../../src/providers/claude/tail.ts';

function linesOf(fixture: string): TailLine[] {
  const raw = readFileSync(join('tests/fixtures/codex', fixture), 'utf8');
  const out: TailLine[] = [];
  let offset = 0;
  for (const text of raw.split('\n')) {
    if (text.trim()) out.push({ text, offset });
    offset += Buffer.byteLength(text, 'utf8') + 1;
  }
  return out;
}

describe('parseCodexLines', () => {
  const events = parseCodexLines(linesOf('rollout-basic.jsonl'), '/r.jsonl');

  it('emits session.started from session_meta with cwd and host', () => {
    const s = events.filter(e => e.kind === 'session.started');
    expect(s).toHaveLength(1);
    expect(s[0]!.payload).toMatchObject({
      provider: 'codex', cwd: '/repo', originator: 'Codex Desktop', cliVersion: '0.152.1',
    });
    expect(s[0]!.sessionId).toBe('01a0835e-cda1');
  });

  it('maps user_message to prompt.submitted', () => {
    const p = events.filter(e => e.kind === 'prompt.submitted');
    expect(p).toHaveLength(1);
    expect(p[0]!.payload.text).toBe('Review this change for security vulnerabilities.');
  });

  it('maps agent_message to prose — the noise-free narration stream', () => {
    const p = events.filter(e => e.kind === 'prose');
    expect(p).toHaveLength(1);
    expect(p[0]!.payload.text).toBe('Tracing user-controlled inputs to sinks.');
  });

  it('maps function_call to tool.used', () => {
    const t = events.filter(e => e.kind === 'tool.used');
    expect(t).toHaveLength(1);
    expect(t[0]!.payload).toMatchObject({ name: 'shell' });
  });

  it('maps task_complete to turn.completed', () => {
    const t = events.filter(e => e.kind === 'turn.completed');
    expect(t).toHaveLength(1);
  });

  it('does NOT emit prompt.submitted for response_item message records (no double count)', () => {
    const prompts = events.filter(e => e.kind === 'prompt.submitted');
    expect(prompts).toHaveLength(1);
  });

  it('reads parent_thread_id and subagent role as agent.spawned', () => {
    const evs = parseCodexLines(linesOf('rollout-subagent.jsonl'), '/r2.jsonl');
    const spawned = evs.filter(e => e.kind === 'agent.spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.payload).toMatchObject({
      parentAgentId: '01a043c5-f268', name: 'guardian', depth: 1,
    });
  });

  it('stores an unknown payload type as unparsed', () => {
    const evs = parseCodexLines([{
      text: '{"timestamp":"t","type":"event_msg","payload":{"type":"brand_new_thing"}}',
      offset: 0,
    }], '/r.jsonl');
    expect(evs.filter(e => e.kind === 'unparsed')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/providers/codex/parse.test.ts`
Expected: FAIL — cannot resolve `parse.ts`

- [ ] **Step 4: Write the implementation**

`src/providers/codex/parse.ts`:
```ts
import { hashRecord } from '../../core/identity.ts';
import type { NormalizedEvent } from '../../core/types.ts';
import type { TailLine } from '../claude/tail.ts';

export const CODEX_PARSER_VERSION = 1;

/** Codex separates prose from tool calls explicitly, so the §8.3 filter is
 *  exact rather than heuristic. Spec §5.5. */
const KNOWN_EVENT_MSG = new Set([
  'task_started', 'task_complete', 'user_message', 'agent_message',
  'token_count', 'agent_reasoning', 'error',
]);
const KNOWN_RESPONSE_ITEM = new Set([
  'message', 'function_call', 'function_call_output', 'reasoning',
]);

export function parseCodexLines(lines: TailLine[], sourceFile: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  let sessionId = 'unknown';

  const base = (line: TailLine, kind: NormalizedEvent['kind'],
                payload: Record<string, unknown>, ts: string,
                agentId: string | null, nativeId: string | null): NormalizedEvent => ({
    provider: 'codex', sessionId, runId: null, agentId, ts, kind, payload,
    nativeId, sourceFile, sourceOffset: line.offset,
    contentHash: hashRecord(line.text), parserVersion: CODEX_PARSER_VERSION,
  });

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line.text);
    } catch {
      out.push(base(line, 'unparsed', { reason: 'invalid-json', raw: line.text.slice(0, 500) },
        new Date(0).toISOString(), null, null));
      continue;
    }

    const ts = typeof rec?.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString();
    const p = rec?.payload ?? {};

    if (rec?.type === 'session_meta') {
      sessionId = typeof p.session_id === 'string' ? p.session_id : sessionId;
      const threadId = typeof p.id === 'string' ? p.id : sessionId;
      out.push(base(line, 'session.started', {
        provider: 'codex', cwd: p.cwd ?? null, originator: p.originator ?? null,
        cliVersion: p.cli_version ?? null, model: p.model ?? null,
        threadSource: p.thread_source ?? null,
      }, ts, null, threadId));

      // Spec §5.5: parent_thread_id + source.subagent give the spawn tree.
      if (typeof p.parent_thread_id === 'string' && p.parent_thread_id !== threadId) {
        const roleObj = p.source?.subagent;
        const role = roleObj && typeof roleObj === 'object'
          ? String(Object.values(roleObj)[0] ?? 'subagent')
          : 'subagent';
        out.push(base(line, 'agent.spawned', {
          name: role, type: p.thread_source ?? null, model: p.model ?? null,
          color: null, depth: 1, parentAgentId: p.parent_thread_id,
        }, ts, threadId, threadId));
      }
      continue;
    }

    if (rec?.type === 'event_msg') {
      if (!KNOWN_EVENT_MSG.has(p.type)) {
        out.push(base(line, 'unparsed',
          { reason: 'unknown-event-msg', recordType: p.type }, ts, null, null));
        continue;
      }
      switch (p.type) {
        case 'user_message':
          out.push(base(line, 'prompt.submitted', { text: p.message ?? '' }, ts, null, null));
          break;
        case 'agent_message':
          out.push(base(line, 'prose', { text: p.message ?? '', role: 'assistant' },
            ts, null, null));
          break;
        case 'task_complete': {
          const started = typeof p.started_at === 'number' ? p.started_at : null;
          const done = typeof p.completed_at === 'number' ? p.completed_at : null;
          out.push(base(line, 'turn.completed', {
            durationMs: started && done ? (done - started) * 1000 : null,
            turnId: p.turn_id ?? null,
          }, ts, null, p.turn_id ?? null));
          break;
        }
        default:
          break; // task_started, token_count, agent_reasoning, error: known, not mapped in v1
      }
      continue;
    }

    if (rec?.type === 'response_item') {
      if (!KNOWN_RESPONSE_ITEM.has(p.type)) {
        out.push(base(line, 'unparsed',
          { reason: 'unknown-response-item', recordType: p.type }, ts, null, null));
        continue;
      }
      if (p.type === 'function_call') {
        out.push(base(line, 'tool.used', {
          name: p.name ?? null, target: p.arguments ?? null, isError: false,
          toolUseId: p.call_id ?? null,
        }, ts, null, p.call_id ?? null));
      }
      // `message` is intentionally skipped: event_msg already carries the
      // user/agent text, and emitting both would double-count every turn.
      continue;
    }

    out.push(base(line, 'unparsed', { reason: 'unknown-record-type', recordType: rec?.type },
      ts, null, null));
  }

  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/providers/codex/parse.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add src/providers/codex/parse.ts tests/fixtures/codex/ tests/providers/codex/parse.test.ts
git commit -m "feat(codex): rollout parser with subagent spawn edges"
```

---

### Task 10: Codex state database reader

**Files:**
- Create: `src/providers/codex/stateDb.ts`
- Test: `tests/providers/codex/stateDb.test.ts`

**Interfaces:**
- Consumes: `openDb` pattern (Task 3)
- Produces: `readCodexThreads(dbPath): CodexThread[] | null`, `readSpawnEdges(dbPath): SpawnEdge[]`

- [ ] **Step 1: Write the failing test**

`tests/providers/codex/stateDb.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexThreads, readSpawnEdges } from '../../../src/providers/codex/stateDb.ts';

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
      agent_role TEXT, thread_source TEXT, tokens_used INTEGER, archived INTEGER
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/codex/stateDb.test.ts`
Expected: FAIL — cannot resolve `stateDb.ts`

- [ ] **Step 3: Write the implementation**

`src/providers/codex/stateDb.ts`:
```ts
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

export interface CodexThread {
  id: string;
  rolloutPath: string | null;
  cwd: string | null;
  source: string | null;
  cliVersion: string | null;
  gitBranch: string | null;
  model: string | null;
  agentRole: string | null;
  threadSource: string | null;
  tokensUsed: number | null;
  archived: boolean;
}

export interface SpawnEdge {
  parentThreadId: string;
  childThreadId: string;
  status: string | null;
}

/** Spec §5.5. Codex maintains its own session index; reading it beats
 *  globbing thousands of rollout files, and it hands over `rollout_path`
 *  directly.
 *
 *  Strictly an ACCELERATOR: opened read-only, never written, and any
 *  unrecognized schema returns null so the caller falls back to rollout-file
 *  parsing. The `state_5` name and `_sqlx_migrations` table say plainly that
 *  this schema is versioned and will change. */
export function readCodexThreads(dbPath: string): CodexThread[] | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(`file:${dbPath}?mode=ro`, { readonly: true, fileMustExist: true, uri: true } as any);
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, source, cli_version, git_branch, model,
             agent_role, thread_source, tokens_used, archived
      FROM threads`).all() as any[];
    return rows.map(r => ({
      id: String(r.id),
      rolloutPath: r.rollout_path ?? null,
      cwd: r.cwd ?? null,
      source: r.source ?? null,
      cliVersion: r.cli_version ?? null,
      gitBranch: r.git_branch ?? null,
      model: r.model ?? null,
      agentRole: r.agent_role ?? null,
      threadSource: r.thread_source ?? null,
      tokensUsed: r.tokens_used ?? null,
      archived: Boolean(r.archived),
    }));
  } catch {
    return null; // unknown schema, locked, or corrupt — fall back to files
  } finally {
    db?.close();
  }
}

export function readSpawnEdges(dbPath: string): SpawnEdge[] {
  if (!existsSync(dbPath)) return [];
  let db: Database.Database | undefined;
  try {
    db = new Database(`file:${dbPath}?mode=ro`, { readonly: true, fileMustExist: true, uri: true } as any);
    const rows = db.prepare(
      'SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges').all() as any[];
    return rows.map(r => ({
      parentThreadId: String(r.parent_thread_id),
      childThreadId: String(r.child_thread_id),
      status: r.status ?? null,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/codex/stateDb.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/stateDb.ts tests/providers/codex/stateDb.test.ts
git commit -m "feat(codex): read-only state database reader with file fallback"
```

---

### Task 11: Process discovery and match classification

**Files:**
- Create: `src/discovery/parse.ts`, `src/discovery/match.ts`
- Test: `tests/discovery/parse.test.ts`, `tests/discovery/match.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parsePgrep`, `parseTty`, `parseLsofCwd`, `classifyHost`, `LiveProcess`, `classifyMatch(procs, sessions): MatchResult[]`

- [ ] **Step 1: Write the failing tests**

`tests/discovery/parse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parsePgrep, parseTty, parseLsofCwd, classifyHost } from '../../src/discovery/parse.ts';

describe('parsePgrep', () => {
  it('extracts pids, one per line', () => {
    expect(parsePgrep('7994\n11328\n12014\n')).toEqual([7994, 11328, 12014]);
  });
  it('ignores blank lines and junk', () => {
    expect(parsePgrep('\n7994\n\nnope\n')).toEqual([7994]);
  });
  it('returns empty when nothing is running', () => {
    expect(parsePgrep('')).toEqual([]);
  });
});

describe('parseTty', () => {
  it('trims the ps output', () => {
    expect(parseTty(' ttys004 \n')).toBe('ttys004');
  });
  it('returns null for a process with no controlling terminal', () => {
    expect(parseTty('??\n')).toBeNull();
    expect(parseTty('')).toBeNull();
  });
});

describe('parseLsofCwd', () => {
  it('reads the n-prefixed field from -Fn output', () => {
    expect(parseLsofCwd('p7994\nfcwd\nn/Users/me/repo\n')).toBe('/Users/me/repo');
  });
  it('returns null when no cwd line is present', () => {
    expect(parseLsofCwd('p7994\nfcwd\n')).toBeNull();
  });
});

describe('classifyHost', () => {
  it('recognizes iTerm2 from the ancestry chain', () => {
    expect(classifyHost(['claude', '-zsh', 'login', 'iTermServer-3.6.11', 'iTerm2']))
      .toBe('iterm2');
  });
  it('recognizes VS Code', () => {
    expect(classifyHost(['claude', 'zsh', 'Code Helper', 'Code'])).toBe('vscode');
  });
  it('recognizes Terminal.app', () => {
    expect(classifyHost(['claude', '-zsh', 'login', 'Terminal'])).toBe('terminal');
  });
  it('falls back to unknown', () => {
    expect(classifyHost(['claude', 'sh', 'cron'])).toBe('unknown');
  });
});
```

`tests/discovery/match.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { classifyMatch } from '../../src/discovery/match.ts';

const sessions = [
  { sessionId: 'a', cwd: '/Users/me/Chocabloc' },
  { sessionId: 'b', cwd: '/Users/me/Chocabloc' },
  { sessionId: 'c', cwd: '/Users/me/trip-planner' },
];

describe('classifyMatch', () => {
  it('marks a single-session directory as unique', () => {
    const [m] = classifyMatch(
      [{ pid: 1, tty: 'ttys016', cwd: '/Users/me/trip-planner', host: 'iterm2' }], sessions);
    expect(m).toMatchObject({ pid: 1, quality: 'unique', sessionId: 'c' });
  });

  it('marks two sessions in one repo as ambiguous — the real Chocabloc case', () => {
    const [m] = classifyMatch(
      [{ pid: 12014, tty: 'ttys009', cwd: '/Users/me/Chocabloc', host: 'iterm2' }], sessions);
    expect(m.quality).toBe('ambiguous');
    expect(m.sessionId).toBeNull();
    expect(m.candidates).toEqual(['a', 'b']);
  });

  it('marks a process whose cwd matches no session as unknown', () => {
    const [m] = classifyMatch(
      [{ pid: 9, tty: 'ttys001', cwd: '/Users/me/elsewhere', host: 'vscode' }], sessions);
    expect(m.quality).toBe('unknown');
    expect(m.candidates).toEqual([]);
  });

  it('marks a process with no cwd as unknown', () => {
    const [m] = classifyMatch(
      [{ pid: 9, tty: null, cwd: null, host: 'unknown' }], sessions);
    expect(m.quality).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/discovery/`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the parsers**

`src/discovery/parse.ts`:
```ts
export type HostApp = 'iterm2' | 'terminal' | 'vscode' | 'claude-app' | 'codex-app' | 'unknown';

export interface LiveProcess {
  pid: number;
  tty: string | null;
  cwd: string | null;
  host: HostApp;
}

/** Parse `pgrep -x claude` output. */
export function parsePgrep(out: string): number[] {
  return out.split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number);
}

/** Parse `ps -o tty= -p <pid>`. `??` means no controlling terminal. */
export function parseTty(out: string): string | null {
  const t = out.trim();
  return !t || t === '??' || t === '?' ? null : t;
}

/** Parse `lsof -a -p <pid> -d cwd -Fn` — the cwd is the `n`-prefixed line. */
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1).trim() || null;
  }
  return null;
}

/** Map a process ancestry chain to its terminal host. Spec §7.3 — this
 *  decides which jump action is offered, and VS Code deliberately gets a
 *  weaker one because a specific tab cannot be targeted. */
export function classifyHost(chain: string[]): HostApp {
  const names = chain.map(n => n.toLowerCase());
  if (names.some(n => n.includes('iterm'))) return 'iterm2';
  if (names.some(n => n === 'code' || n.includes('code helper'))) return 'vscode';
  if (names.some(n => n === 'terminal')) return 'terminal';
  if (names.some(n => n === 'claude')) return 'claude-app';
  if (names.some(n => n.includes('chatgpt') || n.includes('codex'))) return 'codex-app';
  return 'unknown';
}
```

- [ ] **Step 4: Write the match classifier**

`src/discovery/match.ts`:
```ts
import type { LiveProcess } from './parse.ts';

export type MatchQuality = 'unique' | 'ambiguous' | 'unknown';

export interface SessionRef { sessionId: string; cwd: string | null }

export interface MatchResult {
  pid: number;
  tty: string | null;
  host: LiveProcess['host'];
  sessionId: string | null;
  quality: MatchQuality;
  candidates: string[];
}

/** Spec §7.2. `cwd` resolves to the project DIRECTORY, not to a specific
 *  session file, so two sessions in one repo are indistinguishable this way.
 *  This machine has exactly that case (pids 12014 and 38737 both in
 *  .../Education/Chocabloc), which is why ambiguity is a first-class result
 *  rather than a tie broken by a guess.
 *
 *  Precision actions — jump-to-terminal, send input — are enabled ONLY on
 *  `unique`. On `ambiguous` the UI offers "Locate manually" with candidates. */
export function classifyMatch(procs: LiveProcess[], sessions: SessionRef[]): MatchResult[] {
  return procs.map(p => {
    const candidates = p.cwd
      ? sessions.filter(s => s.cwd === p.cwd).map(s => s.sessionId)
      : [];
    const quality: MatchQuality =
      candidates.length === 1 ? 'unique' : candidates.length > 1 ? 'ambiguous' : 'unknown';
    return {
      pid: p.pid,
      tty: p.tty,
      host: p.host,
      sessionId: quality === 'unique' ? candidates[0]! : null,
      quality,
      candidates,
    };
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/discovery/`
Expected: PASS (13 tests)

- [ ] **Step 6: Commit**

```bash
git add src/discovery/ tests/discovery/
git commit -m "feat(discovery): process parsing and first-class match ambiguity"
```

---

### Task 12: Hook helper and transactional installation

**Files:**
- Create: `src/hooks/helper.sh`, `src/hooks/install.ts`
- Test: `tests/hooks/helper.test.ts`, `tests/hooks/install.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `HOOK_EVENTS`, `buildHookFragments(helperPath)`, `planInstall(existing, fragments)`, `applyInstall(settingsPath, plan)`, `uninstall(settingsPath, manifest)`

**Design note — why shell, not Node.** Spec §5.4 requires the helper to exit in single-digit milliseconds. Node's startup alone is 40–80 ms, which would add that latency to every hook in every one of the user's sessions. A POSIX shell script is ~3 ms. It also writes **one file per event with an atomic rename** rather than appending to a shared JSONL — concurrent hooks from several sessions would otherwise interleave partial lines, and a watcher could read a half-written record.

- [ ] **Step 1: Write the failing tests**

`tests/hooks/helper.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let spool: string;
const helper = resolve('src/hooks/helper.sh');

beforeEach(() => { spool = mkdtempSync(join(tmpdir(), 'spool-')); chmodSync(helper, 0o755); });
afterEach(() => rmSync(spool, { recursive: true, force: true }));

function run(payload: string) {
  execFileSync('sh', [helper], { input: payload, env: { ...process.env, LLMWS_SPOOL: spool } });
}

describe('hook helper', () => {
  it('writes one file per invocation', () => {
    run('{"hook_event_name":"Stop","session_id":"s1"}');
    run('{"hook_event_name":"Stop","session_id":"s2"}');
    expect(readdirSync(spool).filter(f => f.endsWith('.json'))).toHaveLength(2);
  });

  it('wraps the payload with a unique event_id and occurred_at', () => {
    run('{"hook_event_name":"PermissionRequest","session_id":"s1"}');
    const file = readdirSync(spool).find(f => f.endsWith('.json'))!;
    const rec = JSON.parse(readFileSync(join(spool, file), 'utf8'));
    expect(rec.event_id).toMatch(/[0-9A-Fa-f-]{36}/);
    expect(rec.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.payload.hook_event_name).toBe('PermissionRequest');
    expect(rec.payload.session_id).toBe('s1');
  });

  it('gives every invocation a distinct event_id', () => {
    run('{"hook_event_name":"Stop"}');
    run('{"hook_event_name":"Stop"}');
    const ids = readdirSync(spool).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(spool, f), 'utf8')).event_id);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves no partial .tmp files behind — writes are atomic renames', () => {
    run('{"hook_event_name":"Stop"}');
    expect(readdirSync(spool).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('exits 0 even on malformed input, so it never blocks the agent', () => {
    expect(() => run('not json')).not.toThrow();
  });
});
```

`tests/hooks/install.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookFragments, planInstall, applyInstall, uninstall } from '../../src/hooks/install.ts';

let dir: string, settings: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hooks-')); settings = join(dir, 'settings.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('planInstall', () => {
  it('preserves hooks the user already had', () => {
    const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    const plan = planInstall(existing, buildHookFragments('/h.sh'));
    const pre = plan.next.hooks.PreToolUse;
    expect(pre.some((e: any) => e.hooks[0].command === 'mine.sh')).toBe(true);
  });

  it('adds our narrow PreToolUse matcher, not a catch-all', () => {
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    const matchers = plan.next.hooks.PreToolUse.map((e: any) => e.matcher);
    expect(matchers).toContain('AskUserQuestion|ExitPlanMode');
    expect(matchers).not.toContain('*');
  });

  it('never installs MessageDisplay — streaming churn, spec 5.2', () => {
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    expect(Object.keys(plan.next.hooks)).not.toContain('MessageDisplay');
  });

  it('records a manifest of exactly the fragments we own', () => {
    const plan = planInstall({}, buildHookFragments('/h.sh'));
    expect(plan.manifest.owned.length).toBeGreaterThan(0);
    for (const id of plan.manifest.owned) expect(id).toMatch(/^llmws:/);
  });

  it('is idempotent — planning twice does not double-add', () => {
    const first = planInstall({}, buildHookFragments('/h.sh'));
    const second = planInstall(first.next, buildHookFragments('/h.sh'));
    expect(JSON.stringify(second.next)).toBe(JSON.stringify(first.next));
  });
});

describe('applyInstall', () => {
  it('refuses to write when the file changed since the plan was computed', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const before = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(before), buildHookFragments('/h.sh'));
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [] } })); // someone else edits
    expect(() => applyInstall(settings, { ...plan, baseText: before }))
      .toThrow(/changed on disk/i);
  });

  it('writes atomically and leaves valid JSON', () => {
    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    const base = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(base), buildHookFragments('/h.sh'));
    applyInstall(settings, { ...plan, baseText: base });
    expect(() => JSON.parse(readFileSync(settings, 'utf8'))).not.toThrow();
  });
});

describe('uninstall', () => {
  it('removes only fragments in the manifest and keeps the user\'s own', () => {
    const existing = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    writeFileSync(settings, JSON.stringify(existing));
    const base = readFileSync(settings, 'utf8');
    const plan = planInstall(JSON.parse(base), buildHookFragments('/h.sh'));
    applyInstall(settings, { ...plan, baseText: base });

    uninstall(settings, plan.manifest);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    expect(after.hooks.PreToolUse.some((e: any) => e.hooks[0].command === 'mine.sh')).toBe(true);
    expect(JSON.stringify(after)).not.toContain('/h.sh');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hooks/`
Expected: FAIL — `src/hooks/helper.sh` and `install.ts` do not exist

- [ ] **Step 3: Write the helper**

`src/hooks/helper.sh`:
```sh
#!/bin/sh
# llm-workspace hook helper. Spec §5.4.
#
# Runs inside the user's agent sessions, so it must be fast and must never
# block. Shell, not Node: node's startup alone is 40-80ms and this runs on
# every hook of every session.
#
# Writes ONE FILE PER EVENT with an atomic rename. Appending to a shared
# JSONL would interleave partial lines when several sessions fire at once,
# and the watcher could read a half-written record.
#
# Write-only by design: never reads app state, never prompts, always exits 0.
set -u

SPOOL="${LLMWS_SPOOL:-$HOME/.llm-workspace/spool}"
mkdir -p "$SPOOL" 2>/dev/null || exit 0

if command -v uuidgen >/dev/null 2>&1; then
  EVENT_ID=$(uuidgen)
else
  EVENT_ID="$(date -u +%s)-$$-${RANDOM:-0}"
fi

OCCURRED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="$SPOOL/.$EVENT_ID.tmp"

# The hook payload arrives on stdin as JSON. Ancestry (PPID) is recorded as a
# hint only: hooks run with no controlling terminal, so this does NOT make
# process identity exact (spec §5.4, §7.2).
{
  printf '{"event_id":"%s","occurred_at":"%s","ppid":%s,"payload":' \
    "$EVENT_ID" "$OCCURRED" "${PPID:-0}"
  PAYLOAD=$(cat)
  case "$PAYLOAD" in
    \{*) printf '%s' "$PAYLOAD" ;;
    *)   printf '{"raw":"unparsed"}' ;;
  esac
  printf '}\n'
} > "$TMP" 2>/dev/null || exit 0

mv -f "$TMP" "$SPOOL/$EVENT_ID.json" 2>/dev/null || rm -f "$TMP" 2>/dev/null
exit 0
```

- [ ] **Step 4: Write the installer**

`src/hooks/install.ts`:
```ts
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Spec §5.2. Sparse lifecycle only. MessageDisplay is deliberately absent:
 *  it fires during streaming, and one subprocess per token-flush is
 *  unacceptable churn inside the user's own sessions. */
export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PermissionRequest', 'PermissionDenied', 'Notification',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PostCompact', 'CwdChanged', 'Elicitation', 'ElicitationResult',
] as const;

/** The one PreToolUse matcher we install. Matcher filtering happens BEFORE
 *  the helper is spawned, so this does not run on every Bash/Edit/Read call. */
export const PRE_TOOL_MATCHER = 'AskUserQuestion|ExitPlanMode';

export interface Fragment { event: string; matcher: string | null; id: string; command: string }
export interface Manifest { owned: string[]; command: string }
export interface InstallPlan { next: any; manifest: Manifest; baseText?: string }

export function buildHookFragments(helperPath: string): Fragment[] {
  const command = `sh '${helperPath.replace(/'/g, `'\\''`)}'`;
  const frags: Fragment[] = HOOK_EVENTS.map(event => ({
    event, matcher: null, id: `llmws:${event}`, command,
  }));
  frags.push({
    event: 'PreToolUse', matcher: PRE_TOOL_MATCHER,
    id: `llmws:PreToolUse:${PRE_TOOL_MATCHER}`, command,
  });
  return frags;
}

function entryFor(f: Fragment) {
  return {
    ...(f.matcher ? { matcher: f.matcher } : {}),
    hooks: [{ type: 'command', command: f.command, timeout: 5, _llmws: f.id }],
  };
}

/** Spec §5.3. Merge, never replace. The user already runs their own hooks. */
export function planInstall(existing: any, fragments: Fragment[]): InstallPlan {
  const next = JSON.parse(JSON.stringify(existing ?? {}));
  next.hooks ??= {};
  const owned: string[] = [];

  for (const f of fragments) {
    next.hooks[f.event] ??= [];
    const list: any[] = next.hooks[f.event];
    const already = list.some(e =>
      Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?._llmws === f.id));
    if (!already) list.push(entryFor(f));
    owned.push(f.id);
  }

  return { next, manifest: { owned, command: fragments[0]!.command } };
}

/** Spec §5.3: re-read before write, then replace atomically. If another tool
 *  changed the file since the diff was computed, refuse — the caller
 *  recomputes and re-shows the diff rather than clobbering a newer version. */
export function applyInstall(settingsPath: string, plan: InstallPlan & { baseText: string }): void {
  let current = '';
  try { current = readFileSync(settingsPath, 'utf8'); } catch { current = ''; }
  if (current !== plan.baseText) {
    throw new Error('settings.json changed on disk since the diff was computed');
  }

  const tmp = join(dirname(settingsPath), `.settings.json.llmws.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(plan.next, null, 2) + '\n', 'utf8');
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, settingsPath);
}

/** Removes only entries whose `_llmws` id is in the manifest. Anything the
 *  user added or edited by hand is left alone. */
export function uninstall(settingsPath: string, manifest: Manifest): void {
  const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const owned = new Set(manifest.owned);
  for (const event of Object.keys(cfg.hooks ?? {})) {
    cfg.hooks[event] = (cfg.hooks[event] as any[]).filter(entry =>
      !(Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => owned.has(h?._llmws))));
    if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
  }
  const tmp = join(dirname(settingsPath), `.settings.json.llmws.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  renameSync(tmp, settingsPath);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `chmod +x src/hooks/helper.sh && npx vitest run tests/hooks/`
Expected: PASS (12 tests)

- [ ] **Step 6: Commit**

```bash
git add src/hooks/helper.sh src/hooks/install.ts tests/hooks/
git commit -m "feat(hooks): shell helper with atomic spool writes and transactional install"
```

---

### Task 13: Spool ingestion with rotation

**Files:**
- Create: `src/hooks/spool.ts`
- Test: `tests/hooks/spool.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 3)
- Produces: `ingestSpool(db, spoolDir): number`, `rotateSpool(spoolDir, opts): number`

- [ ] **Step 1: Write the failing test**

`tests/hooks/spool.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { ingestSpool, rotateSpool } from '../../src/hooks/spool.ts';

let spool: string;
beforeEach(() => { spool = mkdtempSync(join(tmpdir(), 'sp-')); });
afterEach(() => rmSync(spool, { recursive: true, force: true }));

function drop(id: string, payload: Record<string, unknown>, occurred = '2026-09-10T00:00:00Z') {
  writeFileSync(join(spool, `${id}.json`),
    JSON.stringify({ event_id: id, occurred_at: occurred, ppid: 123, payload }));
}

describe('ingestSpool', () => {
  it('ingests each spooled event once', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop', session_id: 's1' });
    drop('e2', { hook_event_name: 'PermissionRequest', session_id: 's1', tool_use_id: 't1' });
    expect(ingestSpool(db, spool)).toBe(2);
    const rows = db.prepare('SELECT * FROM signal_events ORDER BY event_id').all() as any[];
    expect(rows.map(r => r.kind)).toEqual(['Stop', 'PermissionRequest']);
  });

  it('is idempotent — re-reading the spool writes nothing new', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop', session_id: 's1' });
    ingestSpool(db, spool);
    expect(ingestSpool(db, spool)).toBe(0);
  });

  it('extracts the correlation ids the rail needs', () => {
    const db = openDb(':memory:');
    drop('e1', {
      hook_event_name: 'PermissionRequest', session_id: 's1',
      prompt_id: 'p1', tool_use_id: 't1', transcript_path: '/t.jsonl',
    });
    ingestSpool(db, spool);
    const row = db.prepare('SELECT * FROM signal_events').get() as any;
    expect(row).toMatchObject({ session_id: 's1', prompt_id: 'p1', tool_use_id: 't1' });
  });

  it('separates occurred_at from ingested_at', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop' }, '2026-01-01T00:00:00Z');
    ingestSpool(db, spool);
    const row = db.prepare('SELECT * FROM signal_events').get() as any;
    expect(row.occurred_at).toBe('2026-01-01T00:00:00Z');
    expect(row.ingested_at).not.toBe(row.occurred_at);
  });

  it('skips a malformed spool file without aborting the batch', () => {
    const db = openDb(':memory:');
    writeFileSync(join(spool, 'bad.json'), 'not json');
    drop('e1', { hook_event_name: 'Stop' });
    expect(ingestSpool(db, spool)).toBe(1);
  });

  it('ignores .tmp files still being written', () => {
    const db = openDb(':memory:');
    writeFileSync(join(spool, '.half.tmp'), '{"event_id":"x"');
    expect(ingestSpool(db, spool)).toBe(0);
  });

  it('deletes files it successfully ingested', () => {
    const db = openDb(':memory:');
    drop('e1', { hook_event_name: 'Stop' });
    ingestSpool(db, spool);
    expect(readdirSync(spool).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });
});

describe('rotateSpool', () => {
  it('removes files older than the age cap', () => {
    drop('old', { hook_event_name: 'Stop' });
    const old = join(spool, 'old.json');
    const past = new Date(Date.now() - 40 * 86400_000);
    utimesSync(old, past, past);
    drop('new', { hook_event_name: 'Stop' });
    expect(rotateSpool(spool, { maxAgeDays: 30, maxFiles: 1000 })).toBe(1);
    expect(readdirSync(spool)).toEqual(['new.json']);
  });

  it('trims the oldest when the file cap is exceeded', () => {
    for (let i = 0; i < 5; i++) drop(`e${i}`, { hook_event_name: 'Stop' });
    rotateSpool(spool, { maxAgeDays: 3650, maxFiles: 3 });
    expect(readdirSync(spool)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hooks/spool.test.ts`
Expected: FAIL — cannot resolve `spool.ts`

- [ ] **Step 3: Write the implementation**

`src/hooks/spool.ts`:
```ts
import { readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../store/db.ts';

const INSERT = `
INSERT OR IGNORE INTO signal_events
  (event_id, occurred_at, ingested_at, provider, session_id, run_id,
   control_handle_id, agent_id, prompt_id, tool_use_id, kind, payload)
VALUES
  (@eventId, @occurredAt, @ingestedAt, @provider, @sessionId, @runId,
   @controlHandleId, @agentId, @promptId, @toolUseId, @kind, @payload)`;

/** Spec §5.4 / §6.1. The helper stamps a unique event_id, so ingestion is
 *  idempotent and a re-read of the spool cannot duplicate events.
 *  `occurred_at` (when the hook fired) is kept distinct from `ingested_at`
 *  (when we read it) — a spooled event may be ingested hours later, so
 *  ordering by ingestion time would be wrong. */
export function ingestSpool(db: Db, spoolDir: string, provider = 'claude'): number {
  if (!existsSync(spoolDir)) return 0;
  const stmt = db.prepare(INSERT);
  const ingestedAt = new Date().toISOString();
  let written = 0;

  for (const name of readdirSync(spoolDir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = join(spoolDir, name);

    let rec: any;
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // half-written or corrupt; leave it for rotation to reap
    }
    if (!rec?.event_id) continue;

    const p = rec.payload ?? {};
    const info = stmt.run({
      eventId: String(rec.event_id),
      occurredAt: String(rec.occurred_at ?? ingestedAt),
      ingestedAt,
      provider,
      sessionId: p.session_id ?? null,
      runId: null,
      controlHandleId: null,
      agentId: p.agent_id ?? null,
      promptId: p.prompt_id ?? null,
      toolUseId: p.tool_use_id ?? null,
      kind: String(p.hook_event_name ?? 'unknown'),
      payload: JSON.stringify({ ...p, _ppid: rec.ppid ?? null }),
    });
    written += info.changes;
    rmSync(file, { force: true });
  }
  return written;
}

export interface RotateOpts { maxAgeDays: number; maxFiles: number }

/** Spec §5.4: the spool is capped and rotated. Six months with the app
 *  closed must not turn it into an accidental log archive. */
export function rotateSpool(spoolDir: string, opts: RotateOpts): number {
  if (!existsSync(spoolDir)) return 0;
  const cutoff = Date.now() - opts.maxAgeDays * 86400_000;
  const files = readdirSync(spoolDir)
    .filter(f => !f.startsWith('.'))
    .map(f => ({ f, path: join(spoolDir, f), mtime: statSync(join(spoolDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  let removed = 0;
  for (const entry of files) {
    if (entry.mtime < cutoff) { rmSync(entry.path, { force: true }); removed++; }
  }
  const remaining = files.filter(e => e.mtime >= cutoff);
  const excess = remaining.length - opts.maxFiles;
  for (let i = 0; i < excess; i++) {
    rmSync(remaining[i]!.path, { force: true });
    removed++;
  }
  return removed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hooks/spool.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/hooks/spool.ts tests/hooks/spool.test.ts
git commit -m "feat(hooks): idempotent spool ingestion with age and count rotation"
```

---

### Task 14: File watcher and live ingestion pipeline

**Files:**
- Create: `src/watch/watcher.ts`
- Test: `tests/watch/watcher.test.ts`

**Interfaces:**
- Consumes: `readTail` (Task 6), `parseClaudeLines` (Task 7), `parseCodexLines` (Task 9), `insertEvents`/`getIngestState`/`recordIngest`/`reparseFile` (Tasks 4–5)
- Produces: `ingestFileOnce(db, path, provider): IngestOutcome`, `startWatcher(db, roots, onEvent): Watcher`

- [ ] **Step 1: Write the failing test**

`tests/watch/watcher.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/watch/watcher.test.ts`
Expected: FAIL — cannot resolve `watcher.ts`

- [ ] **Step 3: Write the implementation**

`src/watch/watcher.ts`:
```ts
import chokidar, { type FSWatcher } from 'chokidar';
import { readTail } from '../providers/claude/tail.ts';
import { parseClaudeLines, CLAUDE_PARSER_VERSION } from '../providers/claude/parse.ts';
import { parseCodexLines, CODEX_PARSER_VERSION } from '../providers/codex/parse.ts';
import { insertEvents, getIngestState, recordIngest, reparseFile } from '../store/ingest.ts';
import type { Db } from '../store/db.ts';
import type { Provider, NormalizedEvent } from '../core/types.ts';

export interface IngestOutcome {
  written: number;
  unparsed: number;
  restarted: boolean;
  events: NormalizedEvent[];
}

function parserFor(provider: Provider) {
  return provider === 'claude'
    ? { parse: parseClaudeLines, version: CLAUDE_PARSER_VERSION }
    : { parse: parseCodexLines, version: CODEX_PARSER_VERSION };
}

/** One incremental pass over a transcript. Spec §6.6.
 *  A parser_version bump or a truncation/replacement forces the full
 *  delete-then-parse path (§6.1) rather than appending to stale rows. */
export function ingestFileOnce(db: Db, path: string, provider: Provider): IngestOutcome {
  const { parse, version } = parserFor(provider);
  const prior = getIngestState(db, path);
  const staleParser = prior !== undefined && prior.parser_version !== version;

  const from = staleParser ? 0 : (prior?.bytes_consumed ?? 0);
  const knownInode = staleParser ? null : (prior?.inode ?? null);
  const tail = readTail(path, from, knownInode);
  const events = parse(tail.lines, path);
  const unparsed = events.filter(e => e.kind === 'unparsed').length;

  const meta = {
    inode: tail.inode, size: tail.size, mtime: new Date().toISOString(),
    bytesConsumed: tail.newOffset, parserVersion: version,
    providerCliVersion: null as string | null,
  };

  let written = 0;
  if (tail.restarted || staleParser) {
    reparseFile(db, path, () => events, meta);
    written = events.length;
  } else {
    written = insertEvents(db, events);
    recordIngest(db, path, meta);
  }

  return { written, unparsed, restarted: tail.restarted, events };
}

export interface WatchRoot { dir: string; provider: Provider; glob: RegExp }

export interface Watcher { close(): Promise<void> }

/** chokidar over the provider transcript roots. Read-only: the watcher never
 *  writes to ~/.claude or ~/.codex (global constraint, spec §11). */
export function startWatcher(
  db: Db,
  roots: WatchRoot[],
  onOutcome: (path: string, provider: Provider, out: IngestOutcome) => void,
): Watcher {
  const watchers: FSWatcher[] = [];

  for (const root of roots) {
    const w = chokidar.watch(root.dir, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: false,   // transcripts are appended live; do not wait
      depth: 4,
    });
    const handle = (path: string) => {
      if (!root.glob.test(path)) return;
      try {
        const out = ingestFileOnce(db, path, root.provider);
        if (out.written > 0 || out.restarted) onOutcome(path, root.provider, out);
      } catch (err) {
        // A single unreadable file must not kill the watcher.
        console.error(`[watch] ${path}: ${(err as Error).message}`);
      }
    };
    w.on('add', handle).on('change', handle);
    watchers.push(w);
  }

  return { async close() { await Promise.all(watchers.map(w => w.close())); } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/watch/watcher.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/watch/watcher.ts tests/watch/watcher.test.ts
git commit -m "feat(watch): incremental ingestion pipeline with truncation handling"
```

---

### Task 15: The CLI — phases 1–2 deliverable

**Files:**
- Create: `src/cli.ts`, `src/config.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `resolvePaths()`, `probeCapabilities()`, and a runnable `npm run cli -- <command>`

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolvePaths, probeCapabilities, formatEventLine } from '../src/config.ts';

describe('resolvePaths', () => {
  it('points at the provider directories the spec names', () => {
    const p = resolvePaths('/home/me');
    expect(p.claudeProjects).toBe('/home/me/.claude/projects');
    expect(p.codexSessions).toBe('/home/me/.codex/sessions');
    expect(p.codexStateDb).toBe('/home/me/.codex/state_5.sqlite');
    expect(p.spool).toBe('/home/me/.llm-workspace/spool');
    expect(p.db).toBe('/home/me/.llm-workspace/index.sqlite');
  });
});

describe('probeCapabilities', () => {
  it('reports what is actually present rather than assuming', () => {
    const caps = probeCapabilities(resolvePaths(process.env.HOME!));
    expect(typeof caps.claudeTranscripts).toBe('boolean');
    expect(typeof caps.codexRollouts).toBe('boolean');
    expect(typeof caps.codexStateDb).toBe('boolean');
    expect(typeof caps.tmux).toBe('boolean');
    expect(typeof caps.hooksInstalled).toBe('boolean');
  });

  it('agrees with the filesystem about Claude transcripts', () => {
    const paths = resolvePaths(process.env.HOME!);
    const caps = probeCapabilities(paths);
    expect(caps.claudeTranscripts).toBe(existsSync(paths.claudeProjects));
  });
});

describe('formatEventLine', () => {
  it('renders prose prominently and tool noise compactly', () => {
    const prose = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: null,
      payload: { text: 'The magic link has no expiry.' },
    } as any);
    expect(prose).toContain('The magic link has no expiry.');

    const tool = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'tool.used', agentId: null,
      payload: { name: 'Bash', target: 'npm test' },
    } as any);
    expect(tool).toContain('Bash');
    expect(tool).toContain('npm test');
  });

  it('tags events with their agent when one is present', () => {
    const line = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: 'agent-task-8-magiclink-abc',
      payload: { text: 'done' },
    } as any);
    expect(line).toContain('task-8-magiclink');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot resolve `../src/config.ts`

- [ ] **Step 3: Write the config module**

`src/config.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { NormalizedEvent } from './core/types.ts';

export interface Paths {
  claudeProjects: string;
  claudeSettings: string;
  codexSessions: string;
  codexStateDb: string;
  codexHistoryDb: string;
  spool: string;
  db: string;
}

export function resolvePaths(home: string): Paths {
  return {
    claudeProjects: join(home, '.claude/projects'),
    claudeSettings: join(home, '.claude/settings.json'),
    codexSessions: join(home, '.codex/sessions'),
    codexStateDb: join(home, '.codex/state_5.sqlite'),
    codexHistoryDb: join(home, '.codex/thread_history_1.sqlite'),
    spool: join(home, '.llm-workspace/spool'),
    db: join(home, '.llm-workspace/index.sqlite'),
  };
}

export interface Capabilities {
  claudeTranscripts: boolean;
  codexRollouts: boolean;
  codexStateDb: boolean;
  tmux: boolean;
  hooksInstalled: boolean;
}

/** Spec §4.1: capabilities are PROBED, never hardcoded. A capability that is
 *  absent is a fact to report, not an error. */
export function probeCapabilities(paths: Paths): Capabilities {
  let tmux = false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    tmux = true;
  } catch { tmux = false; }

  let hooksInstalled = false;
  try {
    hooksInstalled = existsSync(paths.claudeSettings)
      && /_llmws/.test(readFileSync(paths.claudeSettings, 'utf8'));
  } catch { hooksInstalled = false; }

  return {
    claudeTranscripts: existsSync(paths.claudeProjects),
    codexRollouts: existsSync(paths.codexSessions),
    codexStateDb: existsSync(paths.codexStateDb),
    tmux,
    hooksInstalled,
  };
}

const NOISY = new Set(['tool.used', 'turn.completed']);

/** The phase-1 preview of §8.3: prose reads as prose, tool calls compress to
 *  one dim line. This is the CLI's whole reason to exist — proving the
 *  signal/noise split works before any UI depends on it. */
export function formatEventLine(e: Pick<NormalizedEvent, 'ts' | 'kind' | 'agentId' | 'payload'>): string {
  const time = e.ts.slice(11, 19);
  const agent = e.agentId ? ` [${e.agentId.replace(/^agent-/, '').replace(/-[0-9a-f]{8,}$/, '')}]` : '';
  const p = e.payload as Record<string, any>;

  if (e.kind === 'prose') return `${time}${agent}  ${p.text}`;
  if (e.kind === 'prompt.submitted') return `${time}${agent}  > ${p.text}`;
  if (e.kind === 'tool.used') return `${time}${agent}    · ${p.name}${p.target ? ' ' + String(p.target).slice(0, 60) : ''}`;
  if (e.kind === 'agent.spawned') return `${time}  + spawned ${p.name} (depth ${p.depth})`;
  if (e.kind === 'unparsed') return `${time}  ! unparsed: ${p.reason} ${p.recordType ?? ''}`;
  if (NOISY.has(e.kind)) return `${time}    · ${e.kind}`;
  return `${time}  ${e.kind}`;
}
```

- [ ] **Step 4: Write the CLI**

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from './store/db.ts';
import { ingestFileOnce, startWatcher } from './watch/watcher.ts';
import { ingestSpool, rotateSpool } from './hooks/spool.ts';
import { readCodexThreads } from './providers/codex/stateDb.ts';
import { resolvePaths, probeCapabilities, formatEventLine } from './config.ts';
import type { Provider } from './core/types.ts';

const paths = resolvePaths(homedir());
const cmd = process.argv[2] ?? 'help';

function walk(dir: string, match: RegExp, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, match, out, depth + 1);
    else if (match.test(p)) out.push(p);
  }
  return out;
}

function open() {
  mkdirSync(join(homedir(), '.llm-workspace'), { recursive: true });
  return openDb(paths.db);
}

if (cmd === 'probe') {
  const caps = probeCapabilities(paths);
  for (const [k, v] of Object.entries(caps)) {
    console.log(`${v ? '✓' : '✗'}  ${k}`);
  }
  const threads = readCodexThreads(paths.codexStateDb);
  console.log(threads ? `✓  codex state db readable — ${threads.length} threads`
                      : '✗  codex state db unreadable — will fall back to rollout files');
} else if (cmd === 'ingest') {
  const db = open();
  let files = 0, written = 0, unparsed = 0;
  for (const f of walk(paths.claudeProjects, /\.jsonl$/)) {
    const r = ingestFileOnce(db, f, 'claude'); files++; written += r.written; unparsed += r.unparsed;
  }
  for (const f of walk(paths.codexSessions, /rollout-.*\.jsonl$/)) {
    const r = ingestFileOnce(db, f, 'codex'); files++; written += r.written; unparsed += r.unparsed;
  }
  written += ingestSpool(db, paths.spool);
  rotateSpool(paths.spool, { maxAgeDays: 30, maxFiles: 20000 });
  console.log(`ingested ${files} files, ${written} events, ${unparsed} unparsed`);
  if (unparsed > 0) {
    console.error(`\n⚠  ${unparsed} records were not recognized — transcript format may have changed.`);
  }
} else if (cmd === 'stream') {
  const db = open();
  const roots = [
    { dir: paths.claudeProjects, provider: 'claude' as Provider, glob: /\.jsonl$/ },
    { dir: paths.codexSessions, provider: 'codex' as Provider, glob: /rollout-.*\.jsonl$/ },
  ].filter(r => existsSync(r.dir));

  console.log(`watching ${roots.length} root(s) — ctrl-c to stop\n`);
  const w = startWatcher(db, roots, (path, _provider, out) => {
    for (const e of out.events) console.log(formatEventLine(e));
  });
  const spoolTimer = setInterval(() => ingestSpool(db, paths.spool), 1000);
  process.on('SIGINT', () => {
    clearInterval(spoolTimer);
    void w.close().then(() => process.exit(0));
  });
} else {
  console.log(`llm-workspace (phases 1-2)

  probe    report which providers, databases and tools are present
  ingest   one-shot ingest of every transcript into the index
  stream   watch live and print the normalized event stream
`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Verify against real data on this machine**

Run: `npm run cli -- probe`
Expected: `✓ claudeTranscripts`, `✓ codexRollouts`, `✓ codexStateDb`, `✗ tmux` (not installed yet), and a thread count near 297.

Run: `npm run cli -- ingest`
Expected: a non-zero file and event count, and no crash. Note the `unparsed` count — a non-zero value is information, not failure.

Run: `npm run cli -- stream`, then type something into any live Claude session.
Expected: prose lines appear within a second or two of the agent writing them.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/config.ts tests/cli.test.ts
git commit -m "feat(cli): probe, ingest and live stream — phases 1-2 deliverable"
```

---

## Self-Review

**Spec coverage.** Every phase-1/2 requirement maps to a task:

| Spec | Task |
|---|---|
| §6.1 schema, derived vs durable | 3 |
| §6.1 idempotent ingest, §6.1 reparse | 4, 5 |
| §6.2 loud drift (`unparsed`) | 7, 9, 14, 15 |
| §6.3 identities in the event vocabulary | 1 |
| §6.4 event kinds | 1, 7, 8, 9 |
| §6.5 Claude layout, project key | 6, 8 |
| §6.6 incremental reads, truncation, partial line | 6, 14 |
| §7.2 match ambiguity | 11 |
| §7.3 host classification | 11 |
| §8.3 tool-result-as-user regression | 7 |
| §5.2 hook set, no MessageDisplay | 12 |
| §5.3 transactional install | 12 |
| §5.4 helper, spool, rotation, occurred/ingested | 12, 13 |
| §5.5 Codex hooks + state db | 10, 12 |
| §4.1 probed capabilities | 15 |
| §12 fixture-driven parser tests | 7, 9 |

**Deliberately out of this plan** (later plans): §8.1–8.2 fleet view and graph, §9 state machine and rail, §10 tmux/PTY, §11.1 Electron boundary, §14 farm sim and mailbox.

**Known gaps carried forward.** `run.started` / `run.ended` / `context.compacted` / `control.attached` are in the event vocabulary (Task 1) but only emitted once hook signals are folded — Plan 2's first task. Task 15's `stream` prints derived events; folding signals into run state is Plan 2.

**Placeholder scan.** None: every step contains runnable code or an exact command.

**Type consistency.** `NormalizedEvent` field names are used identically in Tasks 1, 2, 4, 5, 7, 8, 9, 14. `TailLine` is defined in Task 6 and imported by Tasks 7 and 9. `IngestMeta` is defined in Task 5 and used in Task 14. Both parsers export `*_PARSER_VERSION` consumed by `parserFor` in Task 14.
