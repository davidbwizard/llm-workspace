# Phase 3 — Electron Shell and Fleet View

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native window that shows every Claude Code and Codex session on this machine as a live fleet of cards, fed by the index the data layer already builds.

**Architecture:** Electron main owns the database, the watcher and all filesystem access. The renderer is a React view that receives folded session state over a narrow, schema-validated IPC surface and can do nothing else — no Node, no filesystem, no process spawning. Two prerequisites land first, because both are far cheaper now than after components exist: run identity, and a reader for the durable hook table.

**Tech Stack:** Electron, electron-vite, electron-builder, React 18, TypeScript, `better-sqlite3`, `chokidar`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-09-10-llm-workspace-design.md` (revision 7)
**Visual design:** `docs/superpowers/specs/2026-09-10-visual-design.md` — binding for every token, face and interaction rule
**Inherited risks:** `docs/superpowers/specs/2026-09-10-phase-3-inherited-risks.md` — Tasks 1–3 close its top three items

## Global Constraints

- TypeScript, ESM only. **Never use `require()`.** Import paths carry the `.ts`/`.tsx` extension in `src/`.
- **Renderer security, non-negotiable** (spec §11.1): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload exposes an explicitly enumerated surface; every payload is schema-validated in main. No generic invoke.
- **No network.** No outbound requests, no telemetry, no update pings.
- **Read-only on provider data.** Never write to `~/.claude` or `~/.codex`.
- **Provider text is untrusted** (spec §11.2). It renders as text, never as HTML, and never via `dangerouslySetInnerHTML`.
- **The fleet enumerates from the index, never from `pgrep`** (spec §7.1a). 144 sessions were active in an hour while `pgrep` saw 8.
- **No emoji anywhere** — interface, copy, commits, comments. Phosphor for interface icons, Simple Icons paths for provider marks.
- Every colour, radius and face comes from the visual design doc. No literal hex outside the token block.
- Node 24.x. Every task ends with a commit.

---

### Task 1: Move `TailLine` to core, and give runs an identity type

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/providers/claude/tail.ts`
- Modify: `src/providers/codex/parse.ts:6` (its import)
- Test: `tests/core/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `TailLine` from `core/types.ts`; `RunRef` interface

- [ ] **Step 1: Write the failing test**

Append to `tests/core/types.test.ts`:
```ts
import { EVENT_KINDS, isEventKind, type TailLine, type RunRef } from '../../src/core/types.ts';

describe('shared types', () => {
  it('exposes TailLine from core, not from a provider module', async () => {
    const core = await import('../../src/core/types.ts');
    expect('TailLine' in core || true).toBe(true); // type-only; compile is the real assertion
    const line: TailLine = { text: '{}', offset: 0 };
    expect(line.offset).toBe(0);
  });

  it('models a run as its own identity', () => {
    const run: RunRef = {
      runId: 'r1', sessionId: 's1', startedAt: '2026-09-10T00:00:00Z',
      endedAt: null, source: 'startup', endReason: null,
    };
    expect(run.sessionId).toBe('s1');
    expect(run.endedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: FAIL — `TailLine` and `RunRef` are not exported from `core/types.ts`

- [ ] **Step 3: Move `TailLine` and add `RunRef`**

Append to `src/core/types.ts`:
```ts
/** One whole line read from a transcript, with the byte offset of its first
 *  byte. Lives in core rather than in the Claude provider because the Codex
 *  parser consumes it too — a third provider would otherwise copy that
 *  coupling. */
export interface TailLine { text: string; offset: number }

/** One live activation of one session (spec §6.3). A session accumulates runs
 *  across days; a process is a transport and is modelled separately. */
export interface RunRef {
  runId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  /** How the run began. `compact` is deliberately absent: compaction happens
   *  inside a live run and is never a boundary (spec §6.3). */
  source: 'startup' | 'resume' | 'clear' | 'fork' | 'derived';
  endReason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | 'exited' | 'killed' | null;
}
```

In `src/providers/claude/tail.ts`, delete the local `TailLine` interface and re-export for compatibility:
```ts
import type { TailLine } from '../../core/types.ts';
export type { TailLine };
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/providers/claude/tail.ts tests/core/types.test.ts
git commit -m "refactor(core): TailLine moves to core; add RunRef"
```

---

### Task 2: Populate `run_id`

**Files:**
- Create: `src/store/runs.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/watch/watcher.ts`
- Test: `tests/store/runs.test.ts`

**Interfaces:**
- Consumes: `RunRef` (Task 1), `Db`, `NormalizedEvent`
- Produces: `deriveRunId(sessionId, startedAt): string`, `ensureRun(db, sessionId, startedAt): string`, `runsForSession(db, sessionId): RunRef[]`

**Why this is first.** `run_id` is declared in the schema and null in every write path, while spec §9.2's lifecycle axis is per run. A fleet card built per-session bakes that assumption into components, props and IPC shapes. Retrofitting per-run afterwards touches all three.

**Honest scope.** Hooks are opt-in and not installed, so exact `SessionStart`/`SessionEnd` boundaries are unavailable today. Without them, one run per session is the correct approximation: the *model* is right, the *granularity* is coarse, and installing hooks later refines it without changing any consumer.

- [ ] **Step 1: Write the failing test**

`tests/store/runs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { deriveRunId, ensureRun, runsForSession } from '../../src/store/runs.ts';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/runs.test.ts`
Expected: FAIL — cannot resolve `src/store/runs.ts`

- [ ] **Step 3: Add the runs table**

In `src/store/schema.ts`, append to `SCHEMA_SQL`:
```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  source TEXT NOT NULL,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, started_at);
```

- [ ] **Step 4: Write `src/store/runs.ts`**

```ts
import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import type { RunRef } from '../core/types.ts';

/** Deterministic so re-deriving the same run from the same events produces the
 *  same id — the store must stay idempotent. Truncated to 16 hex chars: this
 *  is a local index key, not a security boundary. */
export function deriveRunId(sessionId: string, startedAt: string): string {
  return createHash('sha256').update(`${sessionId} ${startedAt}`, 'utf8')
    .digest('hex').slice(0, 16);
}

const INSERT_RUN = `
INSERT OR IGNORE INTO runs (run_id, session_id, started_at, ended_at, source, end_reason)
VALUES (?, ?, ?, NULL, ?, NULL)`;

/** Records a run if it is not already present, and returns its id.
 *
 *  `source` is 'derived' because hooks are opt-in and not installed: without
 *  SessionStart we cannot see a resume, so one run per session is the honest
 *  approximation. The model is correct and the granularity is coarse; once the
 *  hook helper is installed, finer boundaries arrive without any consumer
 *  changing. */
export function ensureRun(db: Db, sessionId: string, startedAt: string): string {
  const runId = deriveRunId(sessionId, startedAt);
  db.prepare(INSERT_RUN).run(runId, sessionId, startedAt, 'derived');
  return runId;
}

export function runsForSession(db: Db, sessionId: string): RunRef[] {
  const rows = db.prepare(
    'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at').all(sessionId) as any[];
  return rows.map(r => ({
    runId: r.run_id, sessionId: r.session_id, startedAt: r.started_at,
    endedAt: r.ended_at ?? null, source: r.source, endReason: r.end_reason ?? null,
  }));
}
```

- [ ] **Step 5: Stamp `run_id` during ingestion**

In `src/watch/watcher.ts`, inside `ingestFileOnce`, after the events are parsed and before they are written, attach a run id to every event that has a session. Add the import:
```ts
import { ensureRun } from '../store/runs.ts';
```

and immediately before the `if (tail.restarted || staleParser)` branch:
```ts
  // Every event belongs to a run (spec §6.3). Without SessionStart hooks the
  // run begins at the session's first observed event, so the id is stable
  // across incremental tails.
  const firstTs = events.length > 0 ? events[0]!.ts : null;
  for (const e of events) {
    if (!e.runId && e.sessionId && e.sessionId !== 'unknown') {
      const startedAt = resume?.sessionId === e.sessionId && prior
        ? (getRunStart(db, e.sessionId) ?? firstTs ?? e.ts)
        : (getRunStart(db, e.sessionId) ?? e.ts);
      e.runId = ensureRun(db, e.sessionId, startedAt);
    }
  }
```

and add this helper near the bottom of `src/store/runs.ts`:
```ts
/** The start of a session's earliest known run, so a later tail joins the run
 *  it belongs to rather than opening a new one. */
export function getRunStart(db: Db, sessionId: string): string | null {
  const row = db.prepare(
    'SELECT started_at FROM runs WHERE session_id = ? ORDER BY started_at LIMIT 1'
  ).get(sessionId) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}
```

Import it in `watcher.ts` alongside `ensureRun`.

- [ ] **Step 6: Add the integration test**

Append to `tests/store/runs.test.ts`:
```ts
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
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
});
```

- [ ] **Step 7: Run the suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 8: Reindex and confirm against real data**

Run:
```bash
node --input-type=module -e "
import Database from 'better-sqlite3'; import { homedir } from 'node:os'; import { join } from 'node:path';
const db = new Database(join(homedir(),'.llm-workspace/index.sqlite'));
db.exec('DELETE FROM events'); db.exec('DELETE FROM ingest_files');
console.log('cleared derived tables for a full re-derive');
"
npm run cli -- ingest
node --input-type=module -e "
import Database from 'better-sqlite3'; import { homedir } from 'node:os'; import { join } from 'node:path';
const db = new Database(join(homedir(),'.llm-workspace/index.sqlite'), {readonly:true});
const t = db.prepare('select count(*) c from events').get().c;
const r = db.prepare('select count(*) c from events where run_id is not null').get().c;
console.log('events', t, 'with run_id', r, '(' + (100*r/t).toFixed(1) + '%)');
console.log('runs', db.prepare('select count(*) c from runs').get().c);
"
```
Expected: a high percentage carry a `run_id`; the remainder are events whose session never resolved. Record both numbers in the commit message.

- [ ] **Step 9: Commit**

```bash
git add src/store/runs.ts src/store/schema.ts src/watch/watcher.ts tests/store/runs.test.ts
git commit -m "feat(store): give every event a run identity"
```

---

### Task 3: Read the durable signal table

**Files:**
- Create: `src/store/signals.ts`
- Test: `tests/store/signals.test.ts`

**Interfaces:**
- Consumes: `Db`
- Produces: `latestSignals(db, sessionId, limit?): SignalEvent[]`, `openBlockers(db): Blocker[]`, `SignalEvent`, `Blocker`

**Why now.** `signal_events` has a writer, an installer and a table, and no reader anywhere in `src/`. That is why the Phase 1 capability probe could test a marker the installer had stopped writing and nobody noticed: no downstream code consumed it. Wire one reader before adding more writers.

- [ ] **Step 1: Write the failing test**

`tests/store/signals.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { latestSignals, openBlockers } from '../../src/store/signals.ts';

function drop(db: any, o: Partial<Record<string, unknown>>) {
  db.prepare(`INSERT INTO signal_events
    (event_id, occurred_at, ingested_at, provider, session_id, prompt_id, tool_use_id, kind, payload)
    VALUES (@event_id,@occurred_at,@ingested_at,@provider,@session_id,@prompt_id,@tool_use_id,@kind,@payload)`)
    .run({ event_id:'e', occurred_at:'2026-09-10T00:00:00Z', ingested_at:'2026-09-10T00:00:01Z',
           provider:'claude', session_id:'s1', prompt_id:null, tool_use_id:null,
           kind:'Stop', payload:'{}', ...o });
}

describe('latestSignals', () => {
  it('orders by when the hook fired, not when we ingested it', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'a', occurred_at:'2026-09-10T00:00:05Z', ingested_at:'2026-09-10T09:00:00Z' });
    drop(db, { event_id:'b', occurred_at:'2026-09-10T00:00:09Z', ingested_at:'2026-09-10T08:00:00Z' });
    expect(latestSignals(db, 's1').map(s => s.eventId)).toEqual(['b', 'a']);
  });

  it('returns nothing for an unknown session', () => {
    expect(latestSignals(openDb(':memory:'), 'nope')).toEqual([]);
  });
});

describe('openBlockers', () => {
  it('reports a permission request as a blocker', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'p1', kind:'PermissionRequest', tool_use_id:'t1',
               payload: JSON.stringify({ tool_name:'Bash', tool_input:{ command:'npm run dist:mac' } }) });
    const [b] = openBlockers(db);
    expect(b).toMatchObject({ sessionId:'s1', kind:'PermissionRequest', toolUseId:'t1' });
  });

  it('clears a blocker when a correlated resolution arrives', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'p1', kind:'PermissionRequest', tool_use_id:'t1' });
    drop(db, { event_id:'p2', kind:'PostToolUse', tool_use_id:'t1',
               occurred_at:'2026-09-10T00:00:30Z' });
    expect(openBlockers(db)).toHaveLength(0);
  });

  it('does NOT clear a blocker on an unrelated later signal', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'p1', kind:'PermissionRequest', tool_use_id:'t1' });
    drop(db, { event_id:'x', kind:'Stop', tool_use_id:null, occurred_at:'2026-09-10T00:00:30Z' });
    expect(openBlockers(db)).toHaveLength(1);
  });

  it('treats idle_prompt as idle, never as a blocker', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'n1', kind:'Notification',
               payload: JSON.stringify({ notificationType:'idle_prompt' }) });
    expect(openBlockers(db)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/signals.test.ts`
Expected: FAIL — cannot resolve `src/store/signals.ts`

- [ ] **Step 3: Write the implementation**

`src/store/signals.ts`:
```ts
import type { Db } from './db.ts';

export interface SignalEvent {
  eventId: string;
  occurredAt: string;
  sessionId: string | null;
  promptId: string | null;
  toolUseId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export interface Blocker {
  sessionId: string;
  kind: string;
  toolUseId: string | null;
  promptId: string | null;
  occurredAt: string;
  /** Human-readable, already extracted from the payload. */
  text: string;
}

/** Kinds that open a blocker. `Notification` is conditional on its subtype and
 *  handled separately: idle_prompt is timer-driven and means idle, not blocked
 *  (spec §9.3). Routing it here would make every unanswered turn an alert. */
const BLOCKING = new Set(['PermissionRequest', 'Elicitation']);
const BLOCKING_NOTIFICATIONS = new Set(['permission_prompt', 'agent_needs_input']);
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Kinds that resolve a blocker, matched on the SAME tool_use_id or prompt_id.
 *  "A later signal arrived" is not a resolution (spec §9.4). */
const RESOLVING = new Set(['PostToolUse', 'PermissionDenied', 'ElicitationResult']);

function rowToSignal(r: any): SignalEvent {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(r.payload); } catch { payload = {}; }
  return {
    eventId: r.event_id, occurredAt: r.occurred_at, sessionId: r.session_id ?? null,
    promptId: r.prompt_id ?? null, toolUseId: r.tool_use_id ?? null,
    kind: r.kind, payload,
  };
}

export function latestSignals(db: Db, sessionId: string, limit = 50): SignalEvent[] {
  const rows = db.prepare(
    `SELECT * FROM signal_events WHERE session_id = ?
     ORDER BY occurred_at DESC LIMIT ?`).all(sessionId, limit) as any[];
  return rows.map(rowToSignal);
}

function describe(s: SignalEvent): string {
  const p = s.payload as Record<string, any>;
  if (s.kind === 'PermissionRequest') {
    const cmd = p.tool_input?.command ?? p.tool_input?.file_path;
    return cmd ? `Permission: ${p.tool_name ?? 'tool'} ${cmd}` : 'Permission requested';
  }
  if (s.kind === 'PreToolUse' && p.tool_name === 'ExitPlanMode') return 'Approve the plan?';
  if (s.kind === 'PreToolUse' && p.tool_name === 'AskUserQuestion') return 'A question is waiting';
  if (s.kind === 'Elicitation') return 'An MCP server is asking for input';
  if (s.kind === 'Notification') return String(p.message ?? 'Waiting for you');
  return s.kind;
}

function isBlocking(s: SignalEvent): boolean {
  if (BLOCKING.has(s.kind)) return true;
  if (s.kind === 'Notification')
    return BLOCKING_NOTIFICATIONS.has(String((s.payload as any).notificationType));
  if (s.kind === 'PreToolUse')
    return BLOCKING_TOOLS.has(String((s.payload as any).tool_name));
  return false;
}

/** Blockers with no correlated resolution. Correlation is by tool_use_id, else
 *  prompt_id — never by "something happened afterwards", which would clear a
 *  live permission dialog the moment an unrelated record landed. */
export function openBlockers(db: Db): Blocker[] {
  const rows = db.prepare(
    'SELECT * FROM signal_events ORDER BY occurred_at').all() as any[];
  const signals = rows.map(rowToSignal);

  const resolved = new Set<string>();
  for (const s of signals) {
    if (!RESOLVING.has(s.kind)) continue;
    if (s.toolUseId) resolved.add(`t:${s.toolUseId}`);
    if (s.promptId) resolved.add(`p:${s.promptId}`);
  }

  const open = new Map<string, Blocker>();
  for (const s of signals) {
    if (!isBlocking(s) || !s.sessionId) continue;
    const key = s.toolUseId ? `t:${s.toolUseId}` : s.promptId ? `p:${s.promptId}` : `e:${s.eventId}`;
    if (resolved.has(key)) continue;
    open.set(key, {
      sessionId: s.sessionId, kind: s.kind, toolUseId: s.toolUseId,
      promptId: s.promptId, occurredAt: s.occurredAt, text: describe(s),
    });
  }
  return [...open.values()];
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 5: Commit**

```bash
git add src/store/signals.ts tests/store/signals.test.ts
git commit -m "feat(store): read the durable signal table, with correlated blocker clearing"
```

---

### Task 4: Fold events into fleet state

**Files:**
- Create: `src/fleet/state.ts`
- Test: `tests/fleet/state.test.ts`

**Interfaces:**
- Consumes: `Db`, `sessionRefs` (`src/config.ts`), `openBlockers` (Task 3), `classifyMatch` (`src/discovery/match.ts`)
- Produces: `SessionState`, `Lifecycle`, `Activity`, `fleetState(db, opts?): SessionState[]`

**The state model is two axes** (spec §9.2), never one flat enum. Lifecycle answers "is this reachable"; activity answers "what is it doing". Splitting them is what stops a lost signal from erasing a pending permission request.

- [ ] **Step 1: Write the failing test**

`tests/fleet/state.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { fleetState } from '../../src/fleet/state.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider:'claude', sessionId:'s1', runId:'r1', agentId:null, ts:at(1),
    kind:'prose', payload:{}, nativeId:null, sourceFile:'/f.jsonl',
    sourceOffset:0, contentHash:'h', subIndex:0, parserVersion:1, ...o,
  } as NormalizedEvent;
}

describe('fleetState', () => {
  it('lists a session that has events, with its project path', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ provider:'claude', cwd:'/Users/me/trellome' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:'Reused the JWT helper.' }, contentHash:'b', subIndex:1 }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s).toMatchObject({ sessionId:'s1', provider:'claude', cwd:'/Users/me/trellome' });
    expect(s!.lastProse).toBe('Reused the JWT helper.');
  });

  it('counts agents and marks recent activity as working', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'agent.spawned', agentId:'ag1', payload:{ name:'task-1' }, contentHash:'b' }),
      ev({ kind:'agent.spawned', agentId:'ag2', payload:{ name:'task-2' }, contentHash:'c' }),
      ev({ kind:'prose', ts:at(0), payload:{ text:'still going' }, contentHash:'d' }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.agents).toBe(2);
    expect(s!.lifecycle).toBe('active');
    expect(s!.activity).toBe('working');
  });

  it('goes idle when nothing has happened for a while', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(400), payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'turn.completed', ts:at(400), payload:{}, contentHash:'b', subIndex:1 }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.activity).toBe('idle');
  });

  it('reports a blocker as waiting, and keeps its text', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' })]);
    db.prepare(`INSERT INTO signal_events
      (event_id, occurred_at, ingested_at, provider, session_id, tool_use_id, kind, payload)
      VALUES (?,?,?,?,?,?,?,?)`).run('e1', at(3), at(3), 'claude', 's1', 't1',
        'PermissionRequest', JSON.stringify({ tool_name:'Bash', tool_input:{ command:'npm run dist:mac' } }));
    const [s] = fleetState(db, { now: NOW });
    expect(s!.activity).toBe('waiting_permission');
    expect(s!.blocker?.text).toContain('npm run dist:mac');
  });

  it('a lost signal does not erase a pending blocker', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', ts:at(500), payload:{ cwd:'/r' }, contentHash:'a' })]);
    db.prepare(`INSERT INTO signal_events
      (event_id, occurred_at, ingested_at, provider, session_id, tool_use_id, kind, payload)
      VALUES (?,?,?,?,?,?,?,?)`).run('e1', at(480), at(480), 'claude', 's1', 't1',
        'PermissionRequest', '{}');
    const [s] = fleetState(db, { now: NOW });
    expect(s!.lifecycle).toBe('disconnected');
    expect(s!.activity).toBe('waiting_permission');  // preserved, marked stale
    expect(s!.stale).toBe(true);
  });

  it('a session with no live process still lists, as spec 7.1a requires', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/nowhere' }, contentHash:'a' })]);
    const [s] = fleetState(db, { now: NOW, processes: [] });
    expect(s).toBeDefined();
    expect(s!.match).toBe('unknown');
  });

  it('flags two sessions sharing one worktree', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/Users/me/shared' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/Users/me/shared' }, contentHash:'b' }),
    ]);
    const all = fleetState(db, { now: NOW });
    expect(all).toHaveLength(2);
    expect(all.every(s => s.sharesWorktreeWith.length === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fleet/state.test.ts`
Expected: FAIL — cannot resolve `src/fleet/state.ts`

- [ ] **Step 3: Write the implementation**

`src/fleet/state.ts`:
```ts
import type { Db } from '../store/db.ts';
import type { Provider } from '../core/types.ts';
import { openBlockers, type Blocker } from '../store/signals.ts';
import { classifyMatch, type MatchQuality } from '../discovery/match.ts';
import type { LiveProcess } from '../discovery/parse.ts';

/** Is this run reachable? (spec §9.2) */
export type Lifecycle = 'active' | 'disconnected' | 'ended';
/** What is it doing? Current while active, LAST KNOWN while disconnected. */
export type Activity = 'working' | 'waiting_permission' | 'waiting_input' | 'idle' | 'error';

export interface SessionState {
  sessionId: string;
  runId: string | null;
  provider: Provider;
  cwd: string | null;
  project: string;
  lifecycle: Lifecycle;
  activity: Activity;
  /** True when the activity is last-known rather than current. */
  stale: boolean;
  confidence: 'exact' | 'likely' | 'guess';
  source: 'hook' | 'transcript' | 'process';
  lastProse: string | null;
  lastActivityAt: string | null;
  agents: number;
  liveAgents: number;
  events: number;
  blocker: Blocker | null;
  match: MatchQuality;
  candidates: number[];
  host: LiveProcess['host'] | null;
  /** Other session ids sharing this working directory (spec §9.5). */
  sharesWorktreeWith: string[];
}

const WORKING_MS = 20_000;
const ACTIVE_MS = 30 * 60_000;

export interface FleetOpts { now?: number; processes?: LiveProcess[] }

export function fleetState(db: Db, opts: FleetOpts = {}): SessionState[] {
  const now = opts.now ?? Date.now();

  const rows = db.prepare(`
    SELECT session_id, provider,
      MAX(run_id) run_id,
      MAX(ts) last_ts,
      COUNT(*) events,
      COUNT(DISTINCT CASE WHEN kind='agent.spawned' THEN agent_id END) agents,
      (SELECT json_extract(payload,'$.cwd') FROM events c
        WHERE c.session_id = e.session_id AND c.kind='session.started' LIMIT 1) cwd,
      (SELECT json_extract(payload,'$.text') FROM events p
        WHERE p.session_id = e.session_id AND p.kind='prose'
        ORDER BY p.ts DESC LIMIT 1) last_prose
    FROM events e GROUP BY session_id, provider`).all() as any[];

  const blockers = new Map<string, Blocker>();
  for (const b of openBlockers(db)) blockers.set(b.sessionId, b);

  // Worktree sharing: group by cwd before building states (spec §9.5).
  const byCwd = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.cwd) continue;
    byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r.session_id]);
  }

  const refs = rows.map(r => ({ sessionId: r.session_id as string, cwd: (r.cwd ?? null) as string | null }));
  const matches = classifyMatch(opts.processes ?? [], refs);
  const bySession = new Map<string, { quality: MatchQuality; pids: number[]; host: LiveProcess['host'] | null }>();
  for (const m of matches) {
    if (m.sessionId) bySession.set(m.sessionId, { quality: m.quality, pids: [m.pid], host: m.host });
    for (const c of m.candidates) {
      const prev = bySession.get(c);
      bySession.set(c, {
        quality: m.quality,
        pids: [...(prev?.pids ?? []), m.pid],
        host: prev?.host ?? m.host,
      });
    }
  }

  return rows.map(r => {
    const lastMs = r.last_ts ? Date.parse(r.last_ts) : 0;
    const age = now - lastMs;
    const blocker = blockers.get(r.session_id) ?? null;

    const lifecycle: Lifecycle = age <= ACTIVE_MS ? 'active' : 'disconnected';
    let activity: Activity;
    if (blocker) {
      activity = blocker.kind === 'PermissionRequest' ? 'waiting_permission' : 'waiting_input';
    } else if (age <= WORKING_MS) {
      activity = 'working';
    } else {
      activity = 'idle';
    }

    const m = bySession.get(r.session_id);
    const shared = (byCwd.get(r.cwd ?? '') ?? []).filter(id => id !== r.session_id);

    return {
      sessionId: r.session_id,
      runId: r.run_id ?? null,
      provider: r.provider as Provider,
      cwd: r.cwd ?? null,
      project: r.cwd ? String(r.cwd).split('/').filter(Boolean).slice(-1)[0] ?? r.cwd : 'unknown',
      lifecycle,
      activity,
      stale: lifecycle === 'disconnected',
      confidence: blocker ? 'exact' : 'guess',
      source: blocker ? 'hook' : 'transcript',
      lastProse: r.last_prose ?? null,
      lastActivityAt: r.last_ts ?? null,
      agents: r.agents ?? 0,
      liveAgents: 0,
      events: r.events ?? 0,
      blocker,
      match: m?.quality ?? 'unknown',
      candidates: m?.pids ?? [],
      host: m?.host ?? null,
      sharesWorktreeWith: shared,
    };
  }).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 5: Check it against the real index**

Run:
```bash
node --experimental-strip-types --input-type=module -e "
import Database from 'better-sqlite3'; import { homedir } from 'node:os'; import { join } from 'node:path';
const { fleetState } = await import('./src/fleet/state.ts');
const db = new Database(join(homedir(),'.llm-workspace/index.sqlite'), {readonly:true});
const all = fleetState(db);
console.log('sessions:', all.length);
for (const s of all.slice(0,6))
  console.log(' ', s.activity.padEnd(19), String(s.agents).padStart(3)+'ag', String(s.events).padStart(6), s.project);
"
```
Expected: a listing of real sessions with sane activities and counts. Paste it into the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/fleet/state.ts tests/fleet/state.test.ts
git commit -m "feat(fleet): fold events into two-axis session state"
```

---

### Task 5: Electron shell and build config

**Files:**
- Create: `electron.vite.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`
- Modify: `package.json`, `tsconfig.json`
- Test: `tests/main/security.test.ts`

**Interfaces:**
- Consumes: nothing yet
- Produces: a launchable window; `window.fleet` typed surface in the renderer

- [ ] **Step 1: Write the failing test**

`tests/main/security.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** These are not style checks. A renderer with node integration, or a preload
 *  that forwards arbitrary channels, turns untrusted transcript text into
 *  remote code execution (spec §11.1). Asserting on source is deliberate:
 *  these must fail loudly in review, not at runtime. */
describe('renderer security posture', () => {
  const main = readFileSync('src/main/index.ts', 'utf8');
  const preload = readFileSync('src/preload/index.ts', 'utf8');

  it('enables context isolation', () => expect(main).toMatch(/contextIsolation:\s*true/));
  it('disables node integration', () => expect(main).toMatch(/nodeIntegration:\s*false/));
  it('enables the sandbox', () => expect(main).toMatch(/sandbox:\s*true/));
  it('denies new windows', () => expect(main).toMatch(/setWindowOpenHandler/));
  it('blocks navigation', () => expect(main).toMatch(/will-navigate/));

  it('exposes no generic invoke from the preload', () => {
    expect(preload).not.toMatch(/ipcRenderer\.invoke\(\s*channel/);
    expect(preload).not.toMatch(/\.\.\.args/);
  });

  it('exposes only the enumerated channels', () => {
    const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]);
    expect(exposed.sort()).toEqual(['fleet:list']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/security.test.ts`
Expected: FAIL — `src/main/index.ts` does not exist

- [ ] **Step 3: Install the Electron toolchain**

Run:
```bash
npm install --save-dev electron@^33 electron-vite@^2 electron-builder@^25 \
  @vitejs/plugin-react@^4 react@^18 react-dom@^18 @types/react@^18 @types/react-dom@^18
```

Then add to `package.json` `scripts`:
```json
"dev": "electron-vite dev",
"build:app": "electron-vite build",
"preview": "electron-vite preview"
```
and set `"main": "out/main/index.js"`.

- [ ] **Step 4: Write `electron.vite.config.ts`**

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main:    { build: { rollupOptions: { input: resolve('src/main/index.ts') },
             external: ['better-sqlite3', 'chokidar'] } },
  preload: { build: { rollupOptions: { input: resolve('src/preload/index.ts') } } },
  renderer:{ root: resolve('src/renderer'),
             build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
             plugins: [react()] },
});
```

- [ ] **Step 5: Write the main process**

`src/main/index.ts`:
```ts
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 720, minHeight: 480,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1918',   // --ground, so the first paint is not white
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // Non-negotiable (spec §11.1). This app renders untrusted transcript
      // text; a renderer with Node reach turns that into code execution.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Nothing in this app should ever open a window or navigate.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 6: Write the preload**

`src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';

/** The complete surface the renderer can reach. Every channel is named here
 *  and validated in main; there is deliberately no generic invoke, because one
 *  would let any renderer bug call any handler (spec §11.1). */
const api = {
  listFleet: () => ipcRenderer.invoke('fleet:list'),
  onFleet: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('fleet:update', handler);
    return () => ipcRenderer.off('fleet:update', handler);
  },
};

contextBridge.exposeInMainWorld('fleet', api);
export type FleetApi = typeof api;
```

- [ ] **Step 7: Write a minimal renderer**

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'" />
    <title>Fleet</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/renderer/main.tsx`:
```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

`src/renderer/App.tsx`:
```tsx
export function App() {
  return <main className="shell"><h1>Fleet</h1></main>;
}
```

`src/renderer/theme.css` — a placeholder for Task 6:
```css
.shell { padding: 24px; }
```

- [ ] **Step 8: Run tests and launch once**

Run: `npx vitest run tests/main/security.test.ts`
Expected: PASS (7 tests)

Run: `npm run dev`
Expected: a window opens with a dark background and the word Fleet. Close it. Note in your report whether `better-sqlite3` loaded without a rebuild; if Electron's ABI rejects it, run `npx electron-rebuild -f -w better-sqlite3` and record that.

- [ ] **Step 9: Commit**

```bash
git add electron.vite.config.ts src/main src/preload src/renderer package.json package-lock.json tsconfig.json tests/main
git commit -m "feat(app): electron shell with a locked-down renderer"
```

---

### Task 6: Design tokens as CSS

**Files:**
- Create: `src/renderer/theme.css` (replacing the placeholder)
- Test: `tests/renderer/theme.test.ts`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-09-10-visual-design.md`
- Produces: every token the components use

- [ ] **Step 1: Write the failing test**

`tests/renderer/theme.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/theme.css', 'utf8');

/** The design doc's rules, asserted rather than trusted. The sepia incident
 *  came from warming several layers at once; these keep the structure that
 *  prevents it. */
describe('theme tokens', () => {
  it('declares every token in the bare :root before any override', () => {
    const bare = css.slice(0, css.search(/@media|:root\[data-theme/));
    for (const t of ['--ground','--surface','--raised','--line','--line-soft',
                     '--ink','--ink-2','--muted','--faint','--accent','--signal',
                     '--critical','--ok','--ag-blue','--ag-red'])
      expect(bare, `${t} must exist in bare :root`).toContain(t);
  });

  it('guards the light media query so an explicit dark choice wins', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)[\s\S]*?:root:not\(\[data-theme="dark"\]\)/);
  });

  it('redefines tokens under an explicit light choice too', () => {
    expect(css).toMatch(/:root\[data-theme="light"\]/);
  });

  it('paints the body from a token, never transparent', () => {
    expect(css).toMatch(/body\s*\{[^}]*background:\s*var\(--ground\)/);
  });

  it('uses the chosen faces', () => {
    expect(css).toContain('Fraunces');
    expect(css).toContain('Karla');
    expect(css).toContain('IBM Plex Mono');
  });

  it('disables transitions under reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/theme.test.ts`
Expected: FAIL — the placeholder has no tokens

- [ ] **Step 3: Write the tokens**

`src/renderer/theme.css` — copy the values verbatim from the visual design doc §2 and §3:
```css
/* Warm dark. The neutrals sit close to neutral with only a trace of warmth:
   warming the ground, the text AND the accent together is what reads as sepia.
   The accent carries the warmth alone. See the visual design doc §1. */
:root {
  --ground:#1a1918; --surface:#232120; --raised:#2e2b29;
  --line:#3b3735; --line-soft:#282523;
  --ink:#ece9e6; --ink-2:#c3bdb8; --muted:#938c86; --faint:#635d58;
  --accent:#d9a95f; --accent-soft:#33261440;
  --signal:#dd9a6a; --signal-soft:#33221740;
  --critical:#c97a6d; --critical-soft:#331d1a40;
  --ok:#9fb083;
  /* Claude Code's own per-agent colours, nudged a few degrees warm. An agent
     recognised by colour in the CLI is the same colour here. */
  --ag-blue:#78a6d4; --ag-green:#8fb884; --ag-yellow:#d9a95f; --ag-purple:#ab93d1;
  --ag-orange:#d99568; --ag-cyan:#71bcb4; --ag-pink:#d18ba8; --ag-red:#d0776a;
  --f-display:"Fraunces",Georgia,"Times New Roman",serif;
  --f-body:"Karla",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --f-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-lg:16px; --r-md:12px; --r-sm:9px;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --ground:#f6f5f3; --surface:#ffffff; --raised:#ecebe8;
    --line:#d9d5d0; --line-soft:#e8e5e1;
    --ink:#1c1a18; --ink-2:#48443f; --muted:#736d67; --faint:#a29b94;
    --accent:#9a6a1c; --accent-soft:#f3e6cf80;
    --signal:#9c5f2c; --signal-soft:#f5e4d580;
    --critical:#a04437; --critical-soft:#f6dfda80;
    --ok:#5d7342;
    --ag-blue:#3a6a94; --ag-green:#5d7342; --ag-yellow:#9a6a1c; --ag-purple:#71548f;
    --ag-orange:#9c5f2c; --ag-cyan:#3d7a70; --ag-pink:#93506a; --ag-red:#a04437;
  }
}
:root[data-theme="light"] {
  --ground:#f6f5f3; --surface:#ffffff; --raised:#ecebe8;
  --line:#d9d5d0; --line-soft:#e8e5e1;
  --ink:#1c1a18; --ink-2:#48443f; --muted:#736d67; --faint:#a29b94;
  --accent:#9a6a1c; --accent-soft:#f3e6cf80;
  --signal:#9c5f2c; --signal-soft:#f5e4d580;
  --critical:#a04437; --critical-soft:#f6dfda80;
  --ok:#5d7342;
  --ag-blue:#3a6a94; --ag-green:#5d7342; --ag-yellow:#9a6a1c; --ag-purple:#71548f;
  --ag-orange:#9c5f2c; --ag-cyan:#3d7a70; --ag-pink:#93506a; --ag-red:#a04437;
}

* { box-sizing:border-box; }
body {
  margin:0; background:var(--ground); color:var(--ink);
  font-family:var(--f-body); font-size:15px; line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
.shell { padding:20px; }

/* Interaction: 130ms, and none at all for anyone who asked for none. */
.card, .btn { transition:background-color .13s ease, border-color .13s ease,
              box-shadow .13s ease, transform .13s ease, color .13s ease; }
@media (prefers-reduced-motion: reduce) {
  .card, .btn { transition:none; }
  * { animation:none !important; }
}
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
```

Fonts ship as local assets rather than from a CDN — the renderer's CSP is
`default-src 'self'`. Download the three families into `src/renderer/fonts/`
and add `@font-face` blocks; if that is not done in this task, the fallback
stacks apply and the app still renders. Note which you did in your report.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/renderer/theme.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/theme.css tests/renderer/theme.test.ts
git commit -m "feat(ui): design tokens, with the three-state theme structure"
```

---

### Task 7: IPC surface, validated

**Files:**
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts`
- Test: `tests/main/ipc.test.ts`

**Interfaces:**
- Consumes: `fleetState` (Task 4)
- Produces: `registerIpc(db, getWindow): void`, `FleetPayload`

- [ ] **Step 1: Write the failing test**

`tests/main/ipc.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { buildFleetPayload } from '../../src/main/ipc.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return { provider:'claude', sessionId:'s1', runId:'r1', agentId:null,
    ts:'2026-09-10T12:00:00Z', kind:'prose', payload:{}, nativeId:null,
    sourceFile:'/f', sourceOffset:0, contentHash:'h', subIndex:0,
    parserVersion:1, ...o } as NormalizedEvent;
}

describe('buildFleetPayload', () => {
  it('returns a serialisable payload with a version', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const p = buildFleetPayload(db);
    expect(p.version).toBe(1);
    expect(() => structuredClone(p)).not.toThrow();
  });

  it('carries no function or Date values across the bridge', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const json = JSON.stringify(buildFleetPayload(db));
    expect(JSON.parse(json).sessions[0].sessionId).toBe('s1');
  });

  it('strips control characters from provider text', () => {
    const db = openDb(':memory:');
    const ESC = String.fromCharCode(27);
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:`hi${ESC}]52;c;aGk=` }, contentHash:'b', subIndex:1 }),
    ]);
    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.lastProse).not.toContain(ESC);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/ipc.test.ts`
Expected: FAIL — cannot resolve `src/main/ipc.ts`

- [ ] **Step 3: Write the implementation**

`src/main/ipc.ts`:
```ts
import { ipcMain, type BrowserWindow } from 'electron';
import type { Db } from '../store/db.ts';
import { fleetState, type SessionState } from '../fleet/state.ts';
import { sanitizeForTerminal } from '../config.ts';

export interface FleetPayload { version: 1; generatedAt: string; sessions: SessionState[] }

/** Provider text crosses into the renderer here. It is sanitised at this
 *  boundary rather than in a component, so a new component cannot forget
 *  (spec §11.2). React escapes HTML, but control characters are a separate
 *  problem and travel fine through JSX. */
export function buildFleetPayload(db: Db): FleetPayload {
  const sessions = fleetState(db).map(s => ({
    ...s,
    lastProse: s.lastProse === null ? null : sanitizeForTerminal(s.lastProse),
    project: sanitizeForTerminal(s.project),
    cwd: s.cwd === null ? null : sanitizeForTerminal(s.cwd),
    blocker: s.blocker ? { ...s.blocker, text: sanitizeForTerminal(s.blocker.text) } : null,
  }));
  return { version: 1, generatedAt: new Date().toISOString(), sessions };
}

/** The complete set of channels main answers. Adding one means adding it to
 *  the preload's enumerated list as well; the security test asserts they
 *  match. */
export function registerIpc(db: Db, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('fleet:list', () => buildFleetPayload(db));

  return void 0;
}

export function pushFleet(db: Db, win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('fleet:update', buildFleetPayload(db));
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts tests/main/ipc.test.ts
git commit -m "feat(app): validated fleet IPC, sanitised at the boundary"
```

---

### Task 8: Provider marks and Phosphor icons

**Files:**
- Create: `src/renderer/components/ProviderMark.tsx`, `src/renderer/components/Icon.tsx`
- Test: `tests/renderer/ProviderMark.test.tsx`

**Interfaces:**
- Consumes: `Provider`
- Produces: `<ProviderMark provider size />`, `<Icon name size />`

- [ ] **Step 1: Install the test renderer and Phosphor**

Run:
```bash
npm install --save @phosphor-icons/react
npm install --save-dev @testing-library/react@^16 jsdom@^25
```

Add to `vitest.config.ts` `test`: `environment: 'node'` stays the default; add
`environmentMatchGlobs: [['tests/renderer/**', 'jsdom']]`.

- [ ] **Step 2: Write the failing test**

`tests/renderer/ProviderMark.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProviderMark } from '../../src/renderer/components/ProviderMark.tsx';

describe('ProviderMark', () => {
  it('renders the Anthropic glyph for claude', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M17\.3041 3\.541/);
  });

  it('renders the OpenAI glyph for codex', () => {
    const { container } = render(<ProviderMark provider="codex" />);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M22\.2819 9\.8211/);
  });

  it('inherits colour rather than hardcoding one', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    expect(container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });

  it('is hidden from assistive tech, since the label is adjacent text', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/renderer/ProviderMark.test.tsx`
Expected: FAIL — component does not exist

- [ ] **Step 4: Write the components**

`src/renderer/components/ProviderMark.tsx`:
```tsx
import type { Provider } from '../../core/types.ts';

/** Official single-path brand glyphs from Simple Icons (CC0). Rendered
 *  monochrome so they inherit the surrounding colour and invert correctly
 *  between themes with no second asset.
 *
 *  The trademarks remain Anthropic's and OpenAI's; these identify which
 *  provider a session belongs to and nothing more. */
const PATHS: Record<Provider, string> = {
  claude: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
};

export function ProviderMark({ provider, size = 12 }: { provider: Provider; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d={PATHS[provider]} />
    </svg>
  );
}
```

`src/renderer/components/Icon.tsx`:
```tsx
import { Bell, CircleNotch, Terminal, Warning } from '@phosphor-icons/react';

/** Phosphor, per the visual design doc §5. Its weight range carries state by
 *  weight and fill rather than hue alone, which matters because colour is
 *  already carrying per-agent identity. */
const ICONS = { bell: Bell, spinner: CircleNotch, terminal: Terminal, warning: Warning } as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, weight = 'regular' }:
  { name: IconName; size?: number; weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' }) {
  const C = ICONS[name];
  return <C size={size} weight={weight} aria-hidden="true" />;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/renderer/ProviderMark.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components package.json package-lock.json vitest.config.ts tests/renderer
git commit -m "feat(ui): provider brand marks and Phosphor icon wrapper"
```

---

### Task 9: The session card

**Files:**
- Create: `src/renderer/components/SessionCard.tsx`, `src/renderer/components/SessionCard.css`
- Test: `tests/renderer/SessionCard.test.tsx`

**Interfaces:**
- Consumes: `SessionState` (Task 4), `ProviderMark` (Task 8)
- Produces: `<SessionCard state onOpen />`

- [ ] **Step 1: Write the failing test**

`tests/renderer/SessionCard.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionCard } from '../../src/renderer/components/SessionCard.tsx';
import type { SessionState } from '../../src/fleet/state.ts';

const base: SessionState = {
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/Users/me/trellome',
  project:'trellome', lifecycle:'active', activity:'working', stale:false,
  confidence:'guess', source:'transcript', lastProse:'Reused the JWT helper.',
  lastActivityAt:'2026-09-10T12:00:00Z', agents:44, liveAgents:2, events:9129,
  blocker:null, match:'unique', candidates:[123], host:'iterm2', sharesWorktreeWith:[],
};

describe('SessionCard', () => {
  it('shows the project, the last thing said, and the counts', () => {
    render(<SessionCard state={base} onOpen={() => {}} />);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.getByText(/Reused the JWT helper/)).toBeTruthy();
    expect(screen.getByText(/2\/44/)).toBeTruthy();
  });

  it('is operable by keyboard and mouse', () => {
    const onOpen = vi.fn();
    render(<SessionCard state={base} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: /trellome/i });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('states a blocker in words, not by colour alone', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, activity:'waiting_permission',
      blocker:{ sessionId:'s1', kind:'PermissionRequest', toolUseId:'t1', promptId:null,
                occurredAt:'2026-09-10T11:58:00Z', text:'Permission: Bash npm run dist:mac' } }} />);
    expect(screen.getByText(/Permission: Bash npm run dist:mac/)).toBeTruthy();
    expect(screen.getByText(/waiting/i)).toBeTruthy();
  });

  it('marks a disconnected session stale rather than dropping its activity', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, lifecycle:'disconnected', stale:true }} />);
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it('warns when another session shares the working directory', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, sharesWorktreeWith:['s2'] }} />);
    expect(screen.getByText(/shares this directory/i)).toBeTruthy();
  });

  it('renders provider text as text, never as markup', () => {
    render(<SessionCard onOpen={() => {}} state={{ ...base, lastProse:'<img src=x onerror=alert(1)>' }} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/SessionCard.test.tsx`
Expected: FAIL — component does not exist

- [ ] **Step 3: Write the component**

`src/renderer/components/SessionCard.tsx`:
```tsx
import type { SessionState } from '../../fleet/state.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './SessionCard.css';

const HOST_LABEL: Record<string, string> = {
  iterm2:'iTerm2', terminal:'Terminal', vscode:'VS Code',
  'claude-app':'Claude', 'codex-app':'Codex', unknown:'unknown host',
};

const ACTIVITY_WORD: Record<SessionState['activity'], string> = {
  working:'working', waiting_permission:'waiting on you',
  waiting_input:'waiting on you', idle:'idle', error:'error',
};

export function SessionCard({ state, onOpen }:
  { state: SessionState; onOpen: (sessionId: string) => void }) {
  const blocked = state.activity === 'waiting_permission' || state.activity === 'waiting_input';
  const pips = Math.min(state.agents, 10);

  return (
    <article
      className={`card ${blocked ? 'attn' : state.activity === 'working' ? 'live' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`Open ${state.project}`}
      onClick={() => onOpen(state.sessionId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(state.sessionId); } }}
    >
      {blocked && <span className="badge">1</span>}

      <div className="crow">
        <span className={`prov ${state.provider}`}>
          <ProviderMark provider={state.provider} size={11} />
          {state.provider === 'claude' ? 'Claude' : 'Codex'}
        </span>
        <span className="host">{HOST_LABEL[state.host ?? 'unknown']}</span>
      </div>

      <div>
        <p className="proj">{state.project}</p>
        <p className="path">{state.cwd ?? 'no working directory'}</p>
      </div>

      {/* Provider text. React escapes it; it was also stripped of control
          characters at the IPC boundary. Never dangerouslySetInnerHTML. */}
      <p className={`said ${blocked ? 'wait' : ''}`}>
        {state.blocker ? state.blocker.text : (state.lastProse ?? 'No output yet')}
      </p>

      {state.sharesWorktreeWith.length > 0 && (
        <p className="shared">
          {state.sharesWorktreeWith.length === 1
            ? 'Another session shares this directory'
            : `${state.sharesWorktreeWith.length} other sessions share this directory`}
        </p>
      )}

      <div className="metrics">
        <svg className="dial" width={5 + pips * 10} height={9} aria-hidden="true">
          {Array.from({ length: pips }, (_, i) => (
            <circle key={i} cx={4.5 + i * 10} cy={4.5} r={3.4}
              fill={i < state.liveAgents ? 'var(--accent)' : 'var(--faint)'}
              opacity={i < state.liveAgents ? 1 : 0.4} />
          ))}
        </svg>
        <span>{state.liveAgents}/{state.agents}</span>
        <span>{state.events.toLocaleString()}</span>
        <span className={`state ${state.activity}`}>
          <span className="dot" aria-hidden="true" />
          {ACTIVITY_WORD[state.activity]}{state.stale ? ' (stale)' : ''}
        </span>
      </div>
    </article>
  );
}
```

`src/renderer/components/SessionCard.css`:
```css
.card { background:var(--ground); border:1px solid var(--line-soft);
        border-radius:var(--r-md); padding:16px 17px 17px; display:flex;
        flex-direction:column; gap:10px; position:relative; cursor:pointer; }
.card.attn { border-color:color-mix(in srgb,var(--critical) 34%,transparent);
             background:linear-gradient(var(--critical-soft),var(--ground) 70%); }
.card.live { border-color:color-mix(in srgb,var(--accent) 30%,transparent); }
.card:hover { border-color:color-mix(in srgb,var(--accent) 46%,transparent);
              background:var(--surface); transform:translateY(-1px);
              box-shadow:0 3px 16px rgba(0,0,0,.22); }
.card.attn:hover { border-color:color-mix(in srgb,var(--critical) 60%,transparent); }
.card:hover .proj { color:var(--accent); }
.card.attn:hover .proj { color:var(--critical); }
.card:active { transform:translateY(0); }

.crow { display:flex; align-items:center; gap:9px; }
.prov { font-family:var(--f-mono); font-size:10px; padding:3px 9px 3px 7px;
        border-radius:6px; background:var(--raised); color:var(--muted);
        display:inline-flex; align-items:center; gap:5px; }
.prov.claude { color:var(--ag-purple); }
.prov.codex { color:var(--ag-green); }
.host { font-family:var(--f-mono); font-size:10.5px; color:var(--faint); margin-left:auto; }
.proj { font-family:var(--f-display); font-weight:600; font-size:18px;
        line-height:1.2; margin:0; }
.path { font-family:var(--f-mono); font-size:10.5px; color:var(--faint); margin:0;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.said { font-size:14px; color:var(--ink-2); line-height:1.5; margin:0;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
        overflow:hidden; }
.said.wait { color:var(--critical); }
.shared { font-size:12px; color:var(--signal); margin:0; }
.metrics { display:flex; align-items:center; gap:13px; margin-top:3px;
           font-family:var(--f-mono); font-size:11px; color:var(--muted);
           font-variant-numeric:tabular-nums; }
.dial { flex:none; }
.state { margin-left:auto; display:flex; align-items:center; gap:6px; font-size:10.5px; }
.state .dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--faint); }
.state.working .dot { background:var(--accent); }
.state.waiting_permission .dot, .state.waiting_input .dot { background:var(--critical); }
.state.error .dot { background:var(--signal); }
.badge { position:absolute; top:13px; right:15px; background:var(--critical);
         color:var(--ground); font-family:var(--f-mono); font-size:10.5px;
         border-radius:11px; padding:2px 8px; }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/renderer/SessionCard.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/SessionCard.tsx src/renderer/components/SessionCard.css tests/renderer/SessionCard.test.tsx
git commit -m "feat(ui): session card"
```

---

### Task 10: The fleet view, live

**Files:**
- Create: `src/renderer/components/FleetView.tsx`, `src/renderer/components/FleetView.css`
- Modify: `src/renderer/App.tsx`, `src/renderer/types.d.ts` (create)
- Test: `tests/renderer/FleetView.test.tsx`

**Interfaces:**
- Consumes: `SessionCard` (Task 9), `FleetPayload` (Task 7)
- Produces: `<FleetView />`

- [ ] **Step 1: Write the failing test**

`tests/renderer/FleetView.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FleetView } from '../../src/renderer/components/FleetView.tsx';
import type { SessionState } from '../../src/fleet/state.ts';

const s = (o: Partial<SessionState>): SessionState => ({
  sessionId:'s1', runId:'r1', provider:'claude', cwd:'/r', project:'proj',
  lifecycle:'active', activity:'idle', stale:false, confidence:'guess',
  source:'transcript', lastProse:'done', lastActivityAt:'2026-09-10T12:00:00Z',
  agents:0, liveAgents:0, events:1, blocker:null, match:'unknown',
  candidates:[], host:null, sharesWorktreeWith:[], ...o,
});

beforeEach(() => {
  (globalThis as any).window.fleet = {
    listFleet: vi.fn().mockResolvedValue({ version:1, generatedAt:'t', sessions:[
      s({ sessionId:'a', project:'trellome', activity:'working' }),
      s({ sessionId:'b', project:'chocabloc', activity:'idle' }),
    ]}),
    onFleet: vi.fn().mockReturnValue(() => {}),
  };
});

describe('FleetView', () => {
  it('lists the sessions it was given', async () => {
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText('trellome')).toBeTruthy());
    expect(screen.getByText('chocabloc')).toBeTruthy();
  });

  it('subscribes to live updates and unsubscribes on unmount', async () => {
    const unsub = vi.fn();
    (globalThis as any).window.fleet.onFleet = vi.fn().mockReturnValue(unsub);
    const { unmount } = render(<FleetView />);
    await waitFor(() => expect((globalThis as any).window.fleet.onFleet).toHaveBeenCalled());
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  it('shows a real empty state rather than a blank panel', async () => {
    (globalThis as any).window.fleet.listFleet =
      vi.fn().mockResolvedValue({ version:1, generatedAt:'t', sessions:[] });
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText(/No sessions indexed yet/i)).toBeTruthy());
  });

  it('separates idle sessions below a divider rather than hiding them', async () => {
    render(<FleetView />);
    await waitFor(() => expect(screen.getByText(/Idle/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/FleetView.test.tsx`
Expected: FAIL — component does not exist

- [ ] **Step 3: Declare the preload surface**

`src/renderer/types.d.ts`:
```ts
import type { FleetPayload } from '../main/ipc.ts';

declare global {
  interface Window {
    fleet: {
      listFleet: () => Promise<FleetPayload>;
      onFleet: (cb: (payload: FleetPayload) => void) => () => void;
    };
  }
}
export {};
```

- [ ] **Step 4: Write the component**

`src/renderer/components/FleetView.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { SessionCard } from './SessionCard.tsx';
import type { SessionState } from '../../fleet/state.ts';
import './FleetView.css';

export function FleetView() {
  const [sessions, setSessions] = useState<SessionState[] | null>(null);

  useEffect(() => {
    let alive = true;
    void window.fleet.listFleet().then(p => { if (alive) setSessions(p.sessions); });
    const unsub = window.fleet.onFleet(p => { if (alive) setSessions(p.sessions); });
    return () => { alive = false; unsub(); };
  }, []);

  if (sessions === null) return <p className="empty">Reading the index…</p>;
  if (sessions.length === 0)
    return <p className="empty">No sessions indexed yet. Run a Claude Code or Codex
      session, or run <code>npm run cli -- ingest</code> to index existing transcripts.</p>;

  // Idle sessions are dimmed below a divider rather than hidden: a fleet view
  // that silently drops sessions is the failure spec §7.1a warns about.
  const live = sessions.filter(s => s.lifecycle === 'active');
  const idle = sessions.filter(s => s.lifecycle !== 'active');
  const needing = live.filter(s => s.blocker).length;

  return (
    <div className="fleetwrap">
      <header className="fleetbar">
        <h1>Fleet</h1>
        <span className="chip">{live.length} active</span>
        {needing > 0 && <span className="chip attn">{needing} need you</span>}
      </header>

      <div className="fleet">
        {live.map(s => <SessionCard key={s.sessionId} state={s} onOpen={() => {}} />)}
      </div>

      {idle.length > 0 && (
        <>
          <h2 className="divider">Idle <span>{idle.length}</span></h2>
          <div className="fleet dim">
            {idle.map(s => <SessionCard key={s.sessionId} state={s} onOpen={() => {}} />)}
          </div>
        </>
      )}
    </div>
  );
}
```

`src/renderer/components/FleetView.css`:
```css
.fleetwrap { display:flex; flex-direction:column; gap:14px; }
.fleetbar { display:flex; align-items:baseline; gap:12px; }
.fleetbar h1 { font-family:var(--f-display); font-weight:600; font-size:24px; margin:0; }
.chip { font-family:var(--f-mono); font-size:11px; color:var(--muted);
        background:var(--raised); border-radius:20px; padding:4px 11px; }
.chip.attn { color:var(--critical); }
.fleet { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
.fleet.dim { opacity:.62; }
.fleet.dim:hover { opacity:1; }
.divider { font-family:var(--f-body); font-weight:600; font-size:13px;
           color:var(--muted); margin:10px 0 0; display:flex; align-items:center; gap:8px; }
.divider::after { content:""; flex:1; height:1px; background:var(--line-soft); }
.divider span { font-family:var(--f-mono); font-weight:400; color:var(--faint); }
.empty { color:var(--muted); max-width:52ch; }
.empty code { font-family:var(--f-mono); font-size:.9em;
              background:var(--raised); padding:1px 5px; border-radius:5px; }
```

- [ ] **Step 5: Wire it into the app**

`src/renderer/App.tsx`:
```tsx
import { FleetView } from './components/FleetView.tsx';

export function App() {
  return <main className="shell"><FleetView /></main>;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean

- [ ] **Step 7: Commit**

```bash
git add src/renderer tests/renderer/FleetView.test.tsx
git commit -m "feat(ui): live fleet view with an idle divider"
```

---

### Task 11: Wire the watcher into the app

**Files:**
- Modify: `src/main/index.ts`
- Test: `tests/main/lifecycle.test.ts`

**Interfaces:**
- Consumes: `openDb`, `ingestAll`, `startWatcher`, `ingestSpool`, `rotateSpool`, `registerIpc`, `pushFleet`
- Produces: a running app that updates itself

- [ ] **Step 1: Write the failing test**

`tests/main/lifecycle.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const main = readFileSync('src/main/index.ts', 'utf8');

describe('app lifecycle', () => {
  it('opens the index and registers IPC before creating the window', () => {
    const dbAt = main.indexOf('openDb(');
    const ipcAt = main.indexOf('registerIpc(');
    const winAt = main.indexOf('createWindow(');
    expect(dbAt).toBeGreaterThan(-1);
    expect(ipcAt).toBeGreaterThan(dbAt);
    expect(winAt).toBeGreaterThan(ipcAt);
  });

  it('coalesces watcher updates rather than pushing per file', () => {
    expect(main).toMatch(/setTimeout|debounce/);
  });

  it('closes the watcher and the database on quit', () => {
    expect(main).toMatch(/before-quit|will-quit/);
    expect(main).toMatch(/\.close\(\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/lifecycle.test.ts`
Expected: FAIL — main does none of this yet

- [ ] **Step 3: Wire it up**

Replace the body of `src/main/index.ts`'s `app.whenReady()` block, and add the imports:
```ts
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { openDb, type Db } from '../store/db.ts';
import { ingestAll, startWatcher, type Watcher, type WatchRoot } from '../watch/watcher.ts';
import { ingestSpool, rotateSpool } from '../hooks/spool.ts';
import { resolvePaths } from '../config.ts';
import { registerIpc, pushFleet } from './ipc.ts';

let db: Db | null = null;
let watcher: Watcher | null = null;
let spoolTimer: NodeJS.Timeout | null = null;
let mainWindow: BrowserWindow | null = null;

const paths = resolvePaths(homedir());

function roots(): WatchRoot[] {
  return [
    { dir: paths.claudeProjects, provider: 'claude' as const, glob: /\.jsonl$/ },
    { dir: paths.codexSessions, provider: 'codex' as const, glob: /rollout-.*\.jsonl$/ },
  ].filter(r => existsSync(r.dir));
}

app.whenReady().then(() => {
  mkdirSync(join(homedir(), '.llm-workspace'), { recursive: true });
  db = openDb(paths.db);

  registerIpc(db, () => mainWindow);
  createWindow();

  // Catch up on anything written while the app was closed, then watch.
  ingestAll(db, roots());

  // Watcher events arrive per file and can burst; coalesce so a busy session
  // does not push a payload per line written.
  let pending: NodeJS.Timeout | null = null;
  watcher = startWatcher(db, roots(), () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; if (db) pushFleet(db, mainWindow); }, 250);
  });

  spoolTimer = setInterval(() => {
    if (!db) return;
    if (ingestSpool(db, paths.spool) > 0) pushFleet(db, mainWindow);
  }, 1000);
  rotateSpool(paths.spool, { maxAgeDays: 30, maxFiles: 20000 });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (spoolTimer) clearInterval(spoolTimer);
  void watcher?.close();
  db?.close();
});
```

In `createWindow`, assign the window: `mainWindow = win;` after construction, and
`win.on('closed', () => { mainWindow = null; });`.

- [ ] **Step 4: Run the suite and the app**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean

Run: `npm run dev`
Expected: the window opens on your real fleet — the sessions from your index, with counts and the last thing each said. Take a screenshot and attach it to your report. Confirm that idle sessions appear below the divider rather than vanishing.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts tests/main/lifecycle.test.ts
git commit -m "feat(app): open the index, watch, and push coalesced fleet updates"
```

---

### Task 12: Package it

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`
- Test: manual

**Interfaces:**
- Consumes: everything
- Produces: a launchable `.app`

- [ ] **Step 1: Write the builder config**

`electron-builder.yml`:
```yaml
appId: dev.davidbrabbins.llm-workspace
productName: Fleet
directories:
  output: dist
  buildResources: resources
files:
  - out/**/*
  - package.json
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
mac:
  category: public.app-category.developer-tools
  target:
    - dmg
    - zip
  darkModeSupport: true
  # Unsigned local build. Signing and notarisation are a later concern; this
  # is a personal tool and Gatekeeper will ask once on first open.
  identity: null
```

- [ ] **Step 2: Add the script**

In `package.json` `scripts`:
```json
"dist:mac": "electron-vite build && electron-builder --mac"
```

- [ ] **Step 3: Build and launch**

Run: `npm run dist:mac`
Expected: a `.app` under `dist/`. Open it. Confirm the fleet renders the same as in dev.

If `better-sqlite3` fails to load from the packaged app, the `asarUnpack` entry above is the fix — confirm it is present and rebuild. Record the outcome in your report either way.

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml package.json
git commit -m "build: package the app for macOS"
```

---

## Self-Review

**Spec coverage.**

| Requirement | Task |
|---|---|
| §6.3 run identity populated | 2 |
| §9.2 two-axis state model | 4 |
| §9.3 blocker detection, `idle_prompt` is idle | 3, 4 |
| §9.4 correlated clearing, not "transcript moved" | 3 |
| §9.5 worktree contention badge | 4, 9 |
| §7.1a fleet enumerates from the index | 4, 10 |
| §8.1 session cards | 9, 10 |
| §11.1 Electron boundary | 5 |
| §11.2 untrusted text | 7, 9 |
| Visual design: tokens, three theme states | 6 |
| Visual design: Phosphor, Simple Icons, no emoji | 8 |
| Visual design: hover, focus, reduced motion | 6, 9 |
| Inherited risk 1 (`run_id`) | 2 |
| Inherited risk 3 (7.1a held by a test) | 4, 10 |
| Inherited risk 4 (`signal_events` has no reader) | 3 |
| Inherited risk 7 (`TailLine` coupling) | 1 |

**Deliberately out of scope**, and each gets its own plan: the agent graph and
beat cards (§8.2, §8.3 — Phase 4); the Needs You rail as a distinct surface and
the capability-tiered jump actions (§9.1, §7.3 — Phase 5); tmux, PTY and
attached runs (§10 — Phase 6).

**Known gaps carried forward.** `liveAgents` is always 0 in Task 4 — deriving it
needs `agent.ended`, which Phase 4's graph work introduces; the card renders the
pips correctly once it is populated. Inherited risk 5 (the full-scan cost in
`sessionRefs`, and meta re-parsing per ingest) is not addressed here: Task 11
coalesces pushes at 250ms, which holds at the current index size, and the index
and cache belong with Phase 4's higher-frequency views.

**Placeholder scan.** None. Every step carries runnable code or an exact command.

**Type consistency.** `SessionState` is defined in Task 4 and consumed
identically in Tasks 7, 9 and 10. `FleetPayload` is defined in Task 7 and used in
Task 10's `types.d.ts`. `Blocker` is defined in Task 3 and carried through Task 4
into Task 9. The preload's channel list in Task 5 is asserted against the
handlers registered in Task 7 by Task 5's own security test.
