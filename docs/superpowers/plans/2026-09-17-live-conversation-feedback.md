# Live Conversation Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the person what is happening in the conversation pane: their message the instant they send it, the agent working, and Claude waiting on them — and stop a message sent to a busy Codex from vanishing.

**Architecture:** Three layers, each testable on its own. Main gains a single-session live-state push (`session:live`) driven by the file watcher, a watch on Claude's status file, and the existing 5-second sweep. Main also learns whether Codex is mid-turn by reading the tail of its own rollout file, and queues with Tab instead of Enter when it is. The renderer keeps pending messages in a module-level store (like drafts), matches them against real turns as they arrive, and renders a working strip and a waiting card above the message box.

**Tech Stack:** TypeScript, Electron (main/preload/renderer split), React 18, vitest + @testing-library/react, better-sqlite3, tmux via `src/main/tmux.ts`.

**Spec:** `docs/superpowers/specs/2026-09-17-live-conversation-feedback-design.md`

## Global Constraints

- **No emojis anywhere** — in code, UI copy, commit messages or test names. Plain text markers (PASS/FAIL/WARN).
- **Renderer never imports from `src/main/**`.** Shared values are duplicated with a drift test (see `MAX_REPLY_CHARS` in `tests/renderer/ConversationView.test.tsx`), or moved to `src/core/`.
- **Every IPC input from the renderer is revalidated in main.** A pid is a positive integer that must already be in the discovery cache.
- **No silent failures.** Log the cause (`console.error` with context), surface anything that affects the person, never swallow with a bare catch-all.
- **Styles come from the artifacts, not screenshots.** Conversation Pane Mockup: https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz (waiting card `.prompt`, composer). Live Feedback Options: https://claude.ai/artifact/FBES9xFVShPSVmpyZwosay (`.strip`, `.state` labels). Both use the app's own tokens from `src/renderer/theme.css`; `--r-md` and `--r-sm` are the only radii the designs define.
- **Existing test commands:** `npx vitest run <path>` for one file, `npm test` for the suite, `npm run typecheck` for types. Both must be clean before any commit.
- **Commit style:** `type(scope): what changed`, lower case, no trailing period. One commit per task unless a task says otherwise.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/main/codexBusy.ts` | Is a Codex session mid-turn? Rollout path lookup, bounded tail read, the pure rule over `task_started` / `task_complete` / `turn_aborted`. |
| `src/main/sessionLive.ts` | Builds one session's `{ activity, since, events }` payload, and owns the per-window watch (status-file watcher, coalescing, cleanup). |
| `src/renderer/state/pending.ts` | The pending-message store (per pid) and the pure matching and countdown rules. |
| `src/renderer/components/WorkingStrip.tsx` / `.css` | The strip above the message box (option C). |
| `src/renderer/components/WaitingCard.tsx` / `.css` | The card shown while the agent waits on you. |
| `tests/main/codexBusy.test.ts`, `tests/main/sessionLive.test.ts`, `tests/renderer/pending.test.ts`, `tests/renderer/WorkingStrip.test.tsx`, `tests/renderer/WaitingCard.test.tsx` | Their tests. |

**Modified**

| File | Change |
|---|---|
| `src/providers/codex/parse.ts` | `turn_aborted` becomes a turn end; parser version 3. |
| `src/fleet/state.ts` | Export `deriveActivity` so one rule serves both the cards and the pane. |
| `src/main/ipc.ts` | `sendKeysFor`: `queued` in the result, Tab for a busy Codex; `session:watch` handler. |
| `src/main/index.ts` | Feed watcher outcomes and sweeps into the session watch. |
| `src/preload/index.ts`, `src/renderer/types.d.ts` | `watchSession`, `onSessionLive`, the widened `KeysResult`. |
| `src/renderer/components/ConversationView.tsx` / `.css` | Pending entries, their labels, the strip and card, the disabled composer. |
| `src/renderer/components/MainPane.tsx` | Pass the provider and pid through for the watch. |
| `KNOWN_ISSUES.md` | Codex interrupt fixed; the busy-Codex send recorded. |

---

### Task 1: An interrupted Codex turn ends the turn

**Files:**
- Modify: `src/providers/codex/parse.ts:18` (version), `:24-31` (`KNOWN_EVENT_MSG`), `:259-288` (the `event_msg` switch)
- Test: `tests/providers/codex/parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `turn.completed` events carrying `{ durationMs: number | null; turnId: string | null; aborted?: true; reason?: string | null }`. `CODEX_PARSER_VERSION === 3`.

- [ ] **Step 1: Write the failing test**

In `tests/providers/codex/parse.test.ts`:

```ts
it('treats an interrupted turn as the end of the turn', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-09-17T04:31:40.000Z',
      payload: { type: 'task_started', turn_id: 't1' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-09-17T04:31:41.185Z',
      payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } }),
  ];
  const events = parseCodexLines(lines, { sessionId: 's1', sourceFile: '/tmp/r.jsonl', startOffset: 0 });
  const last = events[events.length - 1];
  expect(last.kind).toBe('turn.completed');
  expect(last.payload).toMatchObject({ aborted: true, reason: 'interrupted', turnId: 't1', durationMs: null });
  expect(events.some(e => e.kind === 'unparsed')).toBe(false);
});
```

Match the call shape the other tests in this file use — copy the options object from the test directly above yours rather than the one written here if they differ.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/providers/codex/parse.test.ts -t 'interrupted turn'`
Expected: FAIL — the last event is `unparsed` with `reason: 'unknown-event-msg'`.

- [ ] **Step 3: Make it pass**

In `src/providers/codex/parse.ts`, add `'turn_aborted'` to `KNOWN_EVENT_MSG`, and add this case beside `task_complete`:

```ts
        case 'turn_aborted':
          // Codex writes this instead of task_complete when a turn is
          // interrupted (Esc), and writes no task_complete afterwards.
          // Without it the last kind is never a turn end, so the session
          // reads as working for as long as its process lives -- the card
          // bug confirmed in the index on 2026-09-17.
          out.push(base(line, 'turn.completed', {
            durationMs: null,
            turnId: p.turn_id ?? null,
            aborted: true,
            reason: typeof p.reason === 'string' ? p.reason : null,
          }, ts, threadAgentId, p.turn_id ?? null));
          break;
```

Remove `turn_aborted` from the trailing `default:` comment's list if it names it.

- [ ] **Step 4: Bump the parser version**

`export const CODEX_PARSER_VERSION = 3;` — this forces a full re-read of every Codex file (`staleParser` in `src/watch/watcher.ts:101`).

- [ ] **Step 5: Run the file's tests and the suites that read turn ends**

Run: `npx vitest run tests/providers/codex tests/fleet/state.test.ts tests/store/conversation.test.ts tests/watch/watcher.test.ts`
Expected: PASS. `turn.completed` is read in exactly three places (`TURN_END_KINDS`, the `NOISY` filter, the conversation query's exclusion) and nothing reads `durationMs`, so an aborted turn end needs no other change. If any of these fail, stop and report — it means a fourth consumer exists that the spec's survey missed.

- [ ] **Step 6: Time the one-off re-read**

Time the re-read against a copy of the real index, so the app's own database is not touched:

```bash
cp ~/.llm-workspace/index.sqlite /tmp/reindex-check.sqlite
time node --experimental-strip-types --input-type=module -e "
import { openDb } from './src/store/db.ts';
import { ingestAll } from './src/watch/watcher.ts';
import { resolvePaths } from './src/config.ts';
import { homedir } from 'node:os';
// roots() is private to src/main/index.ts:37 -- this is the same list.
const paths = resolvePaths(homedir());
const roots = [
  { dir: paths.codexSessions, provider: 'codex', glob: /rollout-.*\.jsonl\$/ },
];
const db = openDb('/tmp/reindex-check.sqlite');
console.log(ingestAll(db, roots));
"
```

Only the Codex root matters here: the Claude parser's version is unchanged, so its files are not re-read. Write the elapsed time in the commit message. 617 Codex files, 260 MB on this machine. If it takes more than 10 seconds, stop and report before going further: re-reading in the background is a separate decision for David.

- [ ] **Step 7: Commit**

```bash
git add src/providers/codex/parse.ts tests/providers/codex/parse.test.ts
git commit -m "fix(codex): an interrupted turn ends the turn, so the session stops reading as working"
```

---

### Task 2: Is Codex mid-turn?

**Files:**
- Create: `src/main/codexBusy.ts`
- Test: `tests/main/codexBusy.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/store/db.ts`.
- Produces:
  - `export const ROLLOUT_TAIL_BYTES = 262_144`
  - `export function codexBusyFromTail(tail: string): boolean` — the pure rule.
  - `export function rolloutPathFor(db: Db, sessionId: string): string | null`
  - `export function isCodexBusy(db: Db, sessionId: string, read?: (path: string) => string | null): boolean | null` — `null` means "cannot tell".

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { codexBusyFromTail, isCodexBusy, ROLLOUT_TAIL_BYTES } from '../../src/main/codexBusy.ts';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';

const line = (type: string, turn = 't1') =>
  JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turn } });

describe('codexBusyFromTail', () => {
  it('is busy when a turn started and nothing ended it', () => {
    expect(codexBusyFromTail([line('task_started'), line('token_count')].join('\n'))).toBe(true);
  });

  it('is idle after the turn completes', () => {
    expect(codexBusyFromTail([line('task_started'), line('task_complete')].join('\n'))).toBe(false);
  });

  it('is idle after an interrupt, which writes no task_complete', () => {
    expect(codexBusyFromTail([line('task_started'), line('turn_aborted')].join('\n'))).toBe(false);
  });

  it('is idle when the tail holds no turn events at all', () => {
    expect(codexBusyFromTail(line('token_count'))).toBe(false);
  });

  it('ignores a half line at the start of the tail', () => {
    const tail = '{"type":"event_ms' + '\n' + line('task_started');
    expect(codexBusyFromTail(tail)).toBe(true);
  });
});

describe('isCodexBusy', () => {
  it('returns null when the session has no rollout path recorded', () => {
    const db = openDb(':memory:');
    expect(isCodexBusy(db, 'missing', () => null)).toBe(null);
  });

  it('returns null when the file cannot be read', () => {
    const db = openDb(':memory:');
    insertEvents(db, [{
      sessionId: 's1', runId: null, provider: 'codex', ts: '2026-09-17T04:00:00.000Z',
      kind: 'prompt.submitted', payload: { text: 'hi' }, sourceFile: '/tmp/gone.jsonl',
      sourceOffset: 0, contentHash: 'h1', subIndex: 0, parserVersion: 3, agentId: null, turnId: null,
    } as never]);
    expect(isCodexBusy(db, 's1', () => { throw new Error('ENOENT'); })).toBe(null);
  });
});
```

Copy the exact `insertEvents` row shape from `tests/main/ipc.test.ts` — it builds `NormalizedEvent` rows already and this plan's version may not match the current type.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/main/codexBusy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
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

/** The rollout file this session's events were read from. */
export function rolloutPathFor(db: Db, sessionId: string): string | null {
  const row = db.prepare(
    `SELECT source_file FROM events WHERE session_id = ? AND source_file IS NOT NULL
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
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/main/codexBusy.test.ts && npm run typecheck`
Expected: PASS, types clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/codexBusy.ts tests/main/codexBusy.test.ts
git commit -m "feat(main): read whether a codex session is mid-turn from its own rollout"
```

---

### Task 3: Measure what Tab does (gate for Task 4)

This task writes no production code. It decides which half of Task 4 gets built. Do not skip it, and do not infer the answer from the screen — Codex renders a submitted and an unsubmitted message the same way (`KNOWN_ISSUES.md`, method note).

**Files:**
- Create (throwaway, not committed): `<scratchpad>/live/tests/tab-queue.test.ts`

- [ ] **Step 1: Set up a real Codex session in tmux**

```bash
SCRATCH=$(mktemp -d)
tmux new-session -d -s tabprobe -c "$SCRATCH" 'codex'
sleep 5
tmux list-panes -t tabprobe -F '#{pane_pid} #{pane_in_mode} #{bracket_paste_flag}'
```

Expected: `bracket_paste_flag` is 1. If it is 0, stop: the paste path's safety depends on it.

- [ ] **Step 2: Write the probe**

In `<scratchpad>/live/tests/tab-queue.test.ts`, drive the production code, not a copy of it:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sendKeysFor } from '/Users/davidbrabbins/Documents/David/llm-workspace/src/main/ipc.ts';
import { registerSession } from '/Users/davidbrabbins/Documents/David/llm-workspace/src/main/sessions.ts';

const TAG = `probe-${Date.now()}`;   // unique per run; stale data has bitten this before

function rollout(): string {
  const dir = `${process.env.HOME}/.codex/sessions/2026/09/17`;
  const f = readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort().at(-1)!;
  return readFileSync(`${dir}/${f}`, 'utf8');
}

const submitted = (text: string) => rollout().split('\n').some(l => {
  try { const r = JSON.parse(l); return r?.payload?.type === 'user_message' && String(r.payload.message).includes(text); }
  catch { return false; }
});
```

- [ ] **Step 3: Run probe (c) — the detector must separate the outcomes**

Send a message to a **busy** Codex with today's Enter path, and assert it is **not** in the rollout within 10 seconds. Then send one to an **idle** Codex and assert it **is**. A detector that reports both the same way is broken — fix it before trusting anything below.

Make Codex busy with a long task first, for example `tmux send-keys -t tabprobe 'count slowly from 1 to 200, one line each' Enter`.

- [ ] **Step 4: Run probe (a) — Tab on a busy Codex**

Paste the message, then `tmux send-keys -t tabprobe Tab`. Wait for the current turn to end (`task_complete` in the rollout), then check whether a `user_message` with the tag appears.

Record: does it queue? Does it submit after the turn ends? How long after?

- [ ] **Step 5: Run probe (b) — Tab on an idle Codex**

Same paste and Tab against an idle session. Record exactly what happens: submitted, left in the input line, or something else (completion popup, indentation).

- [ ] **Step 6: Clean up and decide**

```bash
tmux kill-session -t tabprobe
```

Write the three results into `KNOWN_ISSUES.md` under a new heading "Sending to a busy Codex (measured 2026-09-17)". Then:

- **(a) queues reliably** → build Task 4 as written.
- **(a) does not queue** → build Task 4's fallback: a new refusal reason `agent_busy`, with the copy "Codex is working. Send when it finishes." Everything else in Task 4 (the `queued` flag for Claude) stays.

Report the outcome to David before starting Task 4.

- [ ] **Step 7: Commit the notes only**

```bash
git add KNOWN_ISSUES.md
git commit -m "docs: what tab does to a busy and an idle codex, measured"
```

---

### Task 4: Send to a busy agent honestly

**Files:**
- Modify: `src/main/ipc.ts` (`KeysResult`, `KeysDeps`, `sendKeysFor`'s final key, the `session:keys` handler), `src/renderer/types.d.ts`
- Test: `tests/main/ipc.test.ts`

**Interfaces:**
- Consumes: `isCodexBusy` (Task 2), `freshLiveSession` (existing, `src/main/ipc.ts:257`).
- Produces: `export type KeysResult = { status: 'sent'; queued: boolean } | { status: 'refused'; reason: KeysRefusalReason }`. `KeysDeps` gains `busy?: (pid: number) => boolean | null`.

- [ ] **Step 1: Write the failing tests**

In `tests/main/ipc.test.ts`, beside the existing `sendKeysFor` tests:

```ts
it('queues with Tab instead of Enter when codex is mid-turn', () => {
  const calls: string[][] = [];
  const r = sendKeysFor(4821, 'hello', {
    has: () => true,
    send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
    capture: () => ({ ok: true, stdout: '' }),
    sleep: () => {},
    busy: () => true,
  });
  expect(r).toEqual({ status: 'sent', queued: true });
  expect(calls.at(-1)).toContain('Tab');
  expect(calls.flat()).not.toContain('Enter');
});

it('submits with Enter when the agent is idle', () => {
  const calls: string[][] = [];
  const r = sendKeysFor(4821, 'hello', {
    has: () => true,
    send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
    capture: () => ({ ok: true, stdout: '' }),
    sleep: () => {},
    busy: () => false,
  });
  expect(r).toEqual({ status: 'sent', queued: false });
  expect(calls.at(-1)).toContain('Enter');
});

it('sends the way it always did when the busy check cannot tell', () => {
  const calls: string[][] = [];
  const r = sendKeysFor(4821, 'hello', {
    has: () => true,
    send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
    capture: () => ({ ok: true, stdout: '' }),
    sleep: () => {},
    busy: () => null,
  });
  expect(r).toEqual({ status: 'sent', queued: false });
  expect(calls.at(-1)).toContain('Enter');
});
```

The existing tests assert `{ status: 'sent' }`; update them to `{ status: 'sent', queued: false }` in the same commit — that is the deliberate contract change, not collateral damage.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/main/ipc.test.ts -t 'codex is mid-turn'`
Expected: FAIL — `busy` is not a dep, and the result has no `queued`.

- [ ] **Step 3: Implement**

In `src/main/ipc.ts`:

```ts
export type KeysResult =
  | { status: 'sent'; queued: boolean }
  | { status: 'refused'; reason: KeysRefusalReason };
```

Add to `KeysDeps`:

```ts
  /** Whether the receiving agent is mid-turn: true, false, or null when it
   *  cannot be told. Injected so tests never touch a real rollout file or
   *  status file. Production passes the closure built in registerIpc. */
  busy?: (pid: number) => boolean | null;
```

Replace the final key send:

```ts
  // A busy Codex does not submit on Enter at all -- it shows "tab to queue
  // message" and leaves the text in its input line, which used to be
  // reported here as a successful send (KNOWN_ISSUES.md, measured
  // 2026-09-16). Tab queues it instead, and the caller is told, so the
  // conversation can label the message Queued rather than claim it landed.
  const queued = deps.busy?.(pid) === true;
  const key = queued ? 'Tab' : 'Enter';
  const entered = sendKeyName(name, key, deps.send);
  if (!entered.ok) console.error(`tmux send-keys (${key}) failed:`, entered.error);
  return { status: 'sent', queued };
```

In `registerIpc`'s `session:keys` handler, build the dep:

```ts
    busy: (pid: number) => {
      const proc = getCachedLiveProcesses().find(p => p.pid === pid);
      if (!proc) return null;
      if (proc.provider === 'claude') {
        // Claude queues on Enter by itself; this only decides the label.
        const live = freshLiveSession(pid, getCachedLiveProcesses(), readLiveSessionFile);
        return live === null ? null : live.status === 'busy';
      }
      const sessionId = sessionIdForPid(pid);
      return sessionId === null ? null : isCodexBusy(db, sessionId);
    },
```

`sessionIdForPid` is the existing unique-match lookup used elsewhere in this file; reuse it rather than writing a second one. For Claude the key stays Enter regardless — only `queued` changes.

- [ ] **Step 4: If Task 3 said Tab does not queue, build the refusal instead**

Add `'agent_busy'` to `KeysRefusalReason`, return `{ status: 'refused', reason: 'agent_busy' }` when `deps.busy?.(pid) === true` and the provider is Codex, and add to `REFUSAL_TEXT` in `src/renderer/components/ReplyPopover.tsx`:

```ts
  agent_busy: 'Codex is working. Send when it finishes.',
```

Then the Tab tests above become a refusal test instead, and Task 9's Queued label applies to Claude only.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/main/ipc.test.ts tests/renderer && npm run typecheck`
Expected: PASS. `ConversationView.tsx` compiles because it only reads `r?.status === 'sent'` today.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/renderer/types.d.ts tests/main/ipc.test.ts
git commit -m "feat(main): queue a message sent to a busy codex, and say when a send was queued"
```

---

### Task 5: One session's live state

**Files:**
- Create: `src/main/sessionLive.ts`
- Modify: `src/fleet/state.ts` (export `deriveActivity`)
- Test: `tests/main/sessionLive.test.ts`

**Interfaces:**
- Consumes: `deriveActivity` (now exported), `freshLiveSession`, `getCachedLiveProcesses`.
- Produces:

```ts
export type LiveActivity = 'working' | 'idle' | 'waiting';
export type SessionLivePayload = {
  version: 1; pid: number; sessionId: string | null;
  activity: LiveActivity | null; since: number | null; events: number;
};
export function buildSessionLive(db: Db, pid: number, processes: LiveProcess[], now?: number): SessionLivePayload | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { buildSessionLive } from '../../src/main/sessionLive.ts';

// Build rows with the same helper the other main tests use; see
// tests/main/ipc.test.ts for the NormalizedEvent shape.

describe('buildSessionLive', () => {
  it('reports working for a codex session whose last turn has not ended, timed from the prompt', () => {
    // events: prompt.submitted at 10:00:00, prose at 10:00:02
    // process: codex, matched to the session
    const p = buildSessionLive(db, 4821, processes, Date.parse('2026-09-17T10:00:30Z'));
    expect(p?.activity).toBe('working');
    expect(p?.since).toBe(Date.parse('2026-09-17T10:00:00Z'));
  });

  it('reports idle once the turn is completed', () => {
    // events: ..., turn.completed
    expect(buildSessionLive(db, 4821, processes)?.activity).toBe('idle');
    expect(buildSessionLive(db, 4821, processes)?.since).toBe(null);
  });

  it('reports idle for an interrupted codex turn', () => {
    // events: prompt.submitted, turn.completed { aborted: true }
    expect(buildSessionLive(db, 4821, processes)?.activity).toBe('idle');
  });

  it('times a busy claude session from statusUpdatedAt, not from the prompt', () => {
    // process: claude with a live session file, status busy, statusUpdatedAt 10:00:20
    const p = buildSessionLive(db, 4822, processes, Date.parse('2026-09-17T10:00:30Z'));
    expect(p).toMatchObject({ activity: 'working', since: Date.parse('2026-09-17T10:00:20Z') });
  });

  it('maps both waiting kinds to waiting', () => {
    // claude status 'waiting'
    expect(buildSessionLive(db, 4822, processes)?.activity).toBe('waiting');
  });

  it('returns a null activity when the pid matches no session', () => {
    expect(buildSessionLive(db, 9999, processes)).toMatchObject({ activity: null, since: null });
  });

  it('returns null for a pid that is not a live process', () => {
    expect(buildSessionLive(db, 1234, [])).toBe(null);
  });
});
```

Fill in the `db` / `processes` setup from `tests/main/ipc.test.ts`'s existing fixtures — it already builds `LiveProcess` values and a `liveSession` with a `startedAtMs` guard.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/main/sessionLive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Export the shared rule**

In `src/fleet/state.ts`, change `function deriveActivity(` to `export function deriveActivity(`, and extend its doc comment: "Also used by buildSessionLive (src/main/sessionLive.ts) for the open conversation, so the pane and the cards can never disagree."

- [ ] **Step 4: Write the module**

```ts
import type { Db } from '../store/db.ts';
import type { LiveProcess } from '../discovery/parse.ts';
import { deriveActivity } from '../fleet/state.ts';
import { openBlockers } from '../store/signals.ts';

export type LiveActivity = 'working' | 'idle' | 'waiting';

export type SessionLivePayload = {
  version: 1;
  pid: number;
  sessionId: string | null;
  /** null means the app cannot tell -- the pane shows no strip and starts
   *  no "not seen" countdown on it. */
  activity: LiveActivity | null;
  /** Epoch ms this working stretch began, or null. Claude: statusUpdatedAt.
   *  Codex: the prompt that started the turn, since a Codex turn only ever
   *  starts from one. */
  since: number | null;
  events: number;
};
```

`buildSessionLive` then:

1. finds the process for `pid` in `processes`; returns `null` if absent (an unknown pid is not answered);
2. resolves the uniquely matched session id with the same helper `session:keys` uses; with none, returns `{ ..., sessionId: null, activity: null, since: null, events: 0 }`;
3. runs one query:

```sql
SELECT COUNT(*) AS events, MAX(ts) AS last_ts,
  (SELECT k.kind FROM events k WHERE k.session_id = e.session_id
    ORDER BY k.ts DESC, k.id DESC LIMIT 1) AS last_kind,
  (SELECT p.ts FROM events p WHERE p.session_id = e.session_id AND p.kind = 'prompt.submitted'
    ORDER BY p.ts DESC, p.id DESC LIMIT 1) AS last_prompt_ts
FROM events e WHERE e.session_id = ?
```

4. reads the Claude status file through `freshLiveSession` (keeping its start-time guard), passes everything to `deriveActivity`, and maps `waiting_permission` / `waiting_input` to `waiting` and `error` to `idle`;
5. sets `since`: for Claude, `statusUpdatedAt` when the status is `busy` (add `statusUpdatedAtMs` to `LiveSessionFile` in `src/providers/claude/liveSession.ts`, parsed with the same care as `startedAtMs` — a non-number becomes null); for Codex, `Date.parse(last_prompt_ts)` while working; otherwise null.

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run tests/main/sessionLive.test.ts tests/fleet/state.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/sessionLive.ts src/fleet/state.ts src/providers/claude/liveSession.ts tests/main/sessionLive.test.ts
git commit -m "feat(main): build one session's live state, sharing the cards' activity rule"
```

---

### Task 6: Push it to the open conversation

**Files:**
- Modify: `src/main/sessionLive.ts` (the watch), `src/main/ipc.ts` (`session:watch`), `src/main/index.ts` (triggers), `src/preload/index.ts`, `src/renderer/types.d.ts`
- Test: `tests/main/sessionLive.test.ts`, `tests/main/security.test.ts`

**Interfaces:**
- Produces:
  - `export function watchSessionFor(pid: number | null, deps: WatchDeps): void`
  - `export function notifySessionChanged(sessionIds: Set<string>): void`
  - `export function pushSessionLive(): void`
  - preload: `watchSession: (pid: number | null) => Promise<boolean>`, `onSessionLive: (cb: (p: SessionLivePayload) => void) => () => void`
  - channel: `'session:live'`

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses a pid that is not a live process, and keeps no watch', () => {
  expect(watchSessionFor(999999, deps)).toBe(false);
  expect(deps.watched()).toBe(null);
});

it('refuses anything that is not a positive integer', () => {
  for (const bad of [0, -1, 1.5, NaN, '4821' as never, null as never]) {
    expect(watchSessionFor(bad, deps)).toBe(false);
  }
});

it('pushes at most one payload per 250ms burst', () => {
  vi.useFakeTimers();
  watchSessionFor(4821, deps);
  notifySessionChanged(new Set(['s1']));
  notifySessionChanged(new Set(['s1']));
  notifySessionChanged(new Set(['s1']));
  vi.advanceTimersByTime(250);
  expect(deps.sent()).toHaveLength(1);
});

it('ignores changes to other sessions', () => {
  watchSessionFor(4821, deps);           // pid 4821 is session s1
  notifySessionChanged(new Set(['s2']));
  vi.advanceTimersByTime(250);
  expect(deps.sent()).toHaveLength(0);
});

it('watches the claude status file and stops watching when the watch moves', () => {
  watchSessionFor(4821, deps);            // claude
  expect(deps.watchedPaths()).toEqual([`${homedir()}/.claude/sessions/4821.json`]);
  watchSessionFor(null, deps);
  expect(deps.watchedPaths()).toEqual([]);
  expect(deps.closed()).toBe(1);
});
```

`deps` is a small fake capturing sends, watched paths and closes, injected the way `KeysDeps` is — no real `fs.watch` in unit tests.

Add to `tests/main/security.test.ts`, matching its existing style: `session:watch` rejects a non-integer, a negative number and a pid absent from discovery.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/main/sessionLive.test.ts -t 'watch'`
Expected: FAIL — `watchSessionFor` is not exported.

- [ ] **Step 3: Implement the watch**

In `src/main/sessionLive.ts`, module state: the watched pid, its session id, an `FSWatcher | null`, and a coalesce timer. `watchSessionFor`:

- validates the pid (`Number.isInteger(pid) && pid > 0`) and that it is in the discovery cache; logs and returns `false` otherwise;
- tears down any previous watcher and timer first;
- for a Claude process, starts `fs.watch(join(homedir(), '.claude', 'sessions', `${pid}.json`))` — **the path is built from the validated integer only** — with its own `error` handler that logs and falls back to the sweep;
- pushes once immediately so the pane is not blank until the first change.

`notifySessionChanged(ids)` pushes (coalesced at 250 ms) only when `ids` has the watched session. `pushSessionLive()` sends `session:live` to the window.

Register in `registerIpc`:

```ts
  ipcMain.handle('session:watch', (_e, pid: unknown) =>
    watchSessionFor(typeof pid === 'number' ? pid : null, { db, window: () => mainWindow }));
```

- [ ] **Step 4: Wire the triggers in `src/main/index.ts`**

- In the watcher callback, alongside the existing coalesced `pushFleet`:

```ts
  watcher = startWatcher(db, roots(), (_path, _provider, out) => {
    notifySessionChanged(new Set(out.events.map(e => e.sessionId)));
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; pushFleet(mainWindow); }, 250);
  });
```

- In `pushAfterDiscoverySweep`, after `pushFleet(mainWindow)`, call `pushSessionLive()`.
- On window close and app quit, call `watchSessionFor(null, ...)` so no watcher outlives the window.

- [ ] **Step 5: Add the bridge**

`src/preload/index.ts`:

```ts
  // Which session's conversation is on screen. Main validates the pid and
  // refuses anything it does not already know as a live process.
  watchSession: (pid: number | null) => ipcRenderer.invoke('session:watch', pid),
  onSessionLive: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('session:live', handler);
    return () => ipcRenderer.off('session:live', handler);
  },
```

Mirror both in `src/renderer/types.d.ts` with the real types.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/main && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/sessionLive.ts src/main/ipc.ts src/main/index.ts src/preload/index.ts src/renderer/types.d.ts tests/main
git commit -m "feat(main): push the open session's live state within a quarter second"
```

---

### Task 7: The renderer listens

**Files:**
- Create: `src/renderer/state/useSessionLive.ts`
- Modify: `src/renderer/components/ConversationView.tsx`, `src/renderer/components/MainPane.tsx`
- Test: `tests/renderer/useSessionLive.test.tsx`, `tests/renderer/ConversationView.test.tsx`

**Interfaces:**
- Produces: `export function useSessionLive(pid: number | null): SessionLive | null` where `SessionLive = { activity: 'working' | 'idle' | 'waiting' | null; since: number | null; events: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('watches on mount and stops on unmount', () => {
  const watchSession = vi.fn().mockResolvedValue(true);
  window.fleet = { watchSession, onSessionLive: () => () => {} } as never;
  const { unmount } = renderHook(() => useSessionLive(4821));
  expect(watchSession).toHaveBeenCalledWith(4821);
  unmount();
  expect(watchSession).toHaveBeenLastCalledWith(null);
});

it('ignores a payload for a different pid', () => { /* push { pid: 9999 }, expect state unchanged */ });

it('refreshes the conversation when the live event count is newer', async () => {
  // ConversationView: push session:live with events: 5 after a mount with events: 4
  // expect window.fleet.conversation to have been called a second time
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/renderer/useSessionLive.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

Subscribe in an effect keyed on `pid`: call `watchSession(pid)`, subscribe with `onSessionLive`, drop payloads whose `pid` is not the current one, and on cleanup unsubscribe and `watchSession(null)`. Two-argument `.then` on the invoke, as `useFleet.ts` does, so a missing handler in main becomes a logged error rather than an unhandled rejection.

- [ ] **Step 4: Use it in the pane**

In `ConversationView`, call `useSessionLive(pid)`. Feed its `events` into the existing live-refresh effect by taking the larger of the prop and the live value, so replies arrive at watcher speed. Leave the `events` prop in place — it is still the backstop.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/renderer && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/state/useSessionLive.ts src/renderer/components/ConversationView.tsx tests/renderer/useSessionLive.test.tsx
git commit -m "feat(conversation): follow the open session's live state"
```

---

### Task 8: The pending-message store

**Files:**
- Create: `src/renderer/state/pending.ts`
- Test: `tests/renderer/pending.test.ts`

**Interfaces:**
- Produces:

```ts
export type PendingAttachment = { id: string; name: string; kind: 'image' | 'file'; thumb: string | null };
export type Pending = {
  key: string; text: string; attachments: PendingAttachment[];
  sentAt: number; queued: boolean; idleMs: number;
};
export const MATCH_SKEW_MS = 2_000;
export const NOT_SEEN_AFTER_MS = 15_000;
export function addPending(pid: number, p: Omit<Pending, 'key' | 'idleMs'>): string;
export function pendingFor(pid: number): Pending[];
export function dropPending(pid: number, key: string): void;
export function clearPending(pid?: number): void;
export function matchPending(list: Pending[], turns: ConversationTurn[]): string[];   // keys to drop
export function normalise(text: string): string;
export function tickIdle(pid: number, ms: number): void;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { addPending, pendingFor, matchPending, normalise, clearPending, NOT_SEEN_AFTER_MS } from '../../src/renderer/state/pending.ts';

const turn = (id: number, ts: string, text: string, role: 'user' | 'assistant' = 'user') => ({ id, ts, role, text });

beforeEach(() => clearPending());

describe('matchPending', () => {
  it('matches a plain message', () => {
    const list = [{ key: 'k1', text: 'run the farm tests', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'run the farm tests')])).toEqual(['k1']);
  });

  it('matches when the log added an image marker', () => {
    const list = [{ key: 'k1', text: 'look at this', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', '[Image #1] look at this')])).toEqual(['k1']);
  });

  it('matches when codex prefixed an attached file path', () => {
    const list = [{ key: 'k1', text: 'check the log', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    const text = "Attached file: '/tmp/llm-workspace-files/a.log'\ncheck the log";
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', text)])).toEqual(['k1']);
  });

  it('ignores line-break differences', () => {
    const list = [{ key: 'k1', text: 'one\ntwo', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'one two')])).toEqual(['k1']);
  });

  it('matches an attachment-only message on time alone', () => {
    const list = [{ key: 'k1', text: '', attachments: [{ id: 'a', name: 'a.png', kind: 'image' as const, thumb: null }], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', "'/tmp/a.png'")])).toEqual(['k1']);
  });

  it('never matches a turn recorded before the send', () => {
    const list = [{ key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T09:59:00Z', 'hello')])).toEqual([]);
  });

  it('matches two quick sends in order, one turn each', () => {
    const base = Date.parse('2026-09-17T10:00:00Z');
    const list = [
      { key: 'k1', text: 'first', attachments: [], sentAt: base, queued: false, idleMs: 0 },
      { key: 'k2', text: 'second', attachments: [], sentAt: base + 100, queued: false, idleMs: 0 },
    ];
    const turns = [turn(1, '2026-09-17T10:00:01Z', 'first'), turn(2, '2026-09-17T10:00:02Z', 'second')];
    expect(matchPending(list, turns)).toEqual(['k1', 'k2']);
  });

  it('ignores turns the agent wrote', () => {
    const list = [{ key: 'k1', text: 'hello', attachments: [], sentAt: Date.parse('2026-09-17T10:00:00Z'), queued: false, idleMs: 0 }];
    expect(matchPending(list, [turn(1, '2026-09-17T10:00:01Z', 'hello', 'assistant')])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/renderer/pending.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Mirror `ConversationView.tsx`'s `drafts` map: module-level `Map<number, Pending[]>`, with `clearPending()` exported for tests (the draft store does the same, for the reason its comment gives). `normalise` collapses whitespace runs to one space and trims. `matchPending` walks the turns oldest-first, and for each one takes the oldest unmatched entry that satisfies both rules, so each turn consumes at most one entry:

```ts
export function matchPending(list: Pending[], turns: ConversationTurn[]): string[] {
  const matched: string[] = [];
  const taken = new Set<string>();
  for (const t of turns) {
    if (t.role !== 'user') continue;
    const ts = Date.parse(t.ts);
    if (!Number.isFinite(ts)) continue;
    const text = normalise(t.text);
    const hit = list.find(p => !taken.has(p.key) && ts >= p.sentAt - MATCH_SKEW_MS
      && (p.text === '' || text.includes(normalise(p.text))));
    if (hit) { taken.add(hit.key); matched.push(hit.key); }
  }
  return matched;
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run tests/renderer/pending.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/pending.ts tests/renderer/pending.test.ts
git commit -m "feat(conversation): hold messages that have not reached the agent's log yet"
```

---

### Task 9: Show the message the instant it is sent

**Files:**
- Modify: `src/renderer/components/ConversationView.tsx` (`MessageBox.send`, the turn list), `src/renderer/components/ConversationView.css`
- Test: `tests/renderer/ConversationView.test.tsx`

**Interfaces:**
- Consumes: Task 8's store, Task 7's `useSessionLive`, Task 4's `{ status: 'sent', queued }`.
- Produces: pending entries rendered as `.turn.user.pending`, with `.state` / `.state.warn` labels.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows your message straight away, before the log has it', async () => {
  window.fleet.sendKeys = async () => ({ status: 'sent', queued: false });
  renderConv();
  await typeAndSend('ship it');
  expect(screen.getByText('ship it')).toBeTruthy();
  expect(document.querySelector('.turn.user.pending')).toBeTruthy();
});

it('puts the text back in the box when the send is refused', async () => {
  window.fleet.sendKeys = async () => ({ status: 'refused', reason: 'session_gone' });
  renderConv();
  await typeAndSend('ship it');
  expect(document.querySelector('.turn.user.pending')).toBe(null);
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('ship it');
  expect(screen.getByText(/That session has ended/)).toBeTruthy();
});

it('labels a queued message', async () => {
  window.fleet.sendKeys = async () => ({ status: 'sent', queued: true });
  renderConv();
  await typeAndSend('ship it');
  expect(screen.getByText('Queued')).toBeTruthy();
});

it('replaces the pending entry when the log has the message', async () => {
  // conversation() returns the message on its second call; push a
  // session:live with a higher event count to trigger the refresh
  await waitFor(() => expect(document.querySelectorAll('.turn.user').length).toBe(1));
  expect(document.querySelector('.pending')).toBe(null);
});

it('warns after fifteen seconds of idle, and not while working', async () => {
  vi.useFakeTimers();
  // live: working -> advance 30s -> no warning
  // live: idle -> advance 15s -> warning
  expect(screen.getByText('Not seen by Claude')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open Terminal' })).toBeTruthy();
});
```

Write `typeAndSend` as a local helper using `fireEvent.change` then `fireEvent.keyDown(box, { key: 'Enter' })`, matching the send tests already in this file.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx -t 'straight away'`
Expected: FAIL — no `.pending` element.

- [ ] **Step 3: Implement**

In `MessageBox.send`, add the entry before the invoke and reconcile after it:

```ts
    const key = addPending(pid, { text, attachments, sentAt: Date.now(), queued: false });
    setText('');
    setAttachments([]);
    drafts.delete(pid);
    try {
      const r = await window.fleet?.sendKeys(...);
      if (r?.status === 'sent') { markQueued(pid, key, r.queued); return; }
      // Nothing reached the session, so the conversation must not keep a
      // message claiming otherwise: the entry goes, and the text and its
      // attachments come back exactly as they were typed.
      dropPending(pid, key);
      setText(text);
      setAttachments(attachments);
      setMessage(r ? REFUSAL_TEXT[r.reason] : 'Could not reach the app.');
      setChoiceOpen(r?.status === 'refused' && r.reason === 'prompt_open');
    } catch (err) { /* same restore, plus console.error, as today */ }
```

Pending entries render after `page.turns`, reusing the existing user-turn markup so they look identical, plus the attachment chips. `ConversationView` runs `matchPending` whenever `page.turns` changes and drops the matched keys. A one-second interval adds to `idleMs` only while `live?.activity === 'idle'`; at `NOT_SEEN_AFTER_MS` the entry renders the warning label with the Open Terminal button wired to `onOpenTerminal`. Clear the interval on unmount.

CSS goes in `ConversationView.css`, copied from the Live Feedback Options artifact's `.state` and `.state.warn` rules (mono, 12px, `--faint`, and `--signal` for the warning).

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run tests/renderer && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ConversationView.tsx src/renderer/components/ConversationView.css tests/renderer/ConversationView.test.tsx
git commit -m "feat(conversation): show your message as soon as you send it"
```

---

### Task 10: The working strip

**Files:**
- Create: `src/renderer/components/WorkingStrip.tsx`, `src/renderer/components/WorkingStrip.css`
- Modify: `src/renderer/components/ConversationView.tsx`
- Test: `tests/renderer/WorkingStrip.test.tsx`

**Interfaces:**
- Produces: `export function WorkingStrip({ provider, since, now }: { provider: Provider; since: number | null; now?: number }): JSX.Element` and `export function elapsed(ms: number): string`.

- [ ] **Step 1: Write the failing tests**

```ts
it('names the agent that is working', () => {
  render(<WorkingStrip provider="codex" since={null} />);
  expect(screen.getByText('Codex is working')).toBeTruthy();
});

it('counts up from the start of the work', () => {
  const since = Date.now() - 14_000;
  render(<WorkingStrip provider="claude" since={since} />);
  expect(screen.getByText('14s')).toBeTruthy();
});

it('shows no timer when the start is unknown', () => {
  const { container } = render(<WorkingStrip provider="claude" since={null} />);
  expect(container.querySelector('.strip .secs')).toBe(null);
});

it('formats minutes and hours', () => {
  expect(elapsed(14_000)).toBe('14s');
  expect(elapsed(125_000)).toBe('2m 5s');
  expect(elapsed(3_780_000)).toBe('1h 3m');
});

it('announces the words once, and not the ticking timer', () => {
  const { container } = render(<WorkingStrip provider="claude" since={Date.now()} />);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Claude is working');
  expect(container.querySelector('.secs')?.getAttribute('aria-hidden')).toBe('true');
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/renderer/WorkingStrip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Markup and classes from the Live Feedback Options artifact's `.strip`: a pulsing dot, `<ProviderMark provider={provider} size={13} />`, the words in a `role="status"` span, and the timer in `.secs` with `aria-hidden="true"`, ticking on a one-second interval that is cleared on unmount and never started when `since` is null. `WorkingStrip.css` carries the `.strip` rules, including `@media (prefers-reduced-motion: reduce) { .strip .dot { animation: none } }`.

In `ConversationView`, render it between the scroller and the message box when `live?.activity === 'working'` and `pid !== null`.

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run tests/renderer && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/WorkingStrip.tsx src/renderer/components/WorkingStrip.css src/renderer/components/ConversationView.tsx tests/renderer/WorkingStrip.test.tsx
git commit -m "feat(conversation): a strip above the message box while the agent works"
```

---

### Task 11: The waiting card

**Files:**
- Create: `src/renderer/components/WaitingCard.tsx`, `src/renderer/components/WaitingCard.css`
- Modify: `src/renderer/components/ConversationView.tsx`
- Test: `tests/renderer/WaitingCard.test.tsx`, `tests/renderer/ConversationView.test.tsx`

**Interfaces:**
- Produces: `export function WaitingCard({ provider, onOpenTerminal }: { provider: Provider; onOpenTerminal: () => void }): JSX.Element`.

- [ ] **Step 1: Write the failing tests**

```ts
it('says who is waiting and offers the terminal', () => {
  const onOpenTerminal = vi.fn();
  render(<WaitingCard provider="claude" onOpenTerminal={onOpenTerminal} />);
  expect(screen.getByText('Claude is waiting on you')).toBeTruthy();
  expect(screen.getByText('Answer in the Terminal')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
  expect(onOpenTerminal).toHaveBeenCalled();
});

// in ConversationView.test.tsx
it('turns the message box off while the agent waits, and keeps what was typed', async () => {
  renderConv();
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'half a thought' } });
  pushLive({ activity: 'waiting' });
  await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true));
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('half a thought');
  expect(screen.getByPlaceholderText("Answer Claude's prompt above to keep typing")).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
});

it('takes the card away once the agent is working again', async () => { /* push working, expect no .prompt */ });
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run tests/renderer/WaitingCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

Markup and CSS from the Conversation Pane Mockup's `.prompt` block (red `border-top: 3px solid var(--critical)`, `.p-head` / `.eyebrow` / `.p-body` / `.p-foot`, `.btn.primary`). Copy the values from the artifact's CSS rather than this plan. The eyebrow reads `<Agent> is waiting on you` with `<ProviderMark />`; the heading is "Answer in the Terminal"; the line under it is "Claude is showing a question or a permission prompt." with the provider's name; the footer button is "Open Terminal".

In `ConversationView`, when `live?.activity === 'waiting'`: render the card above the composer, pass `disabledReason` through so the textarea, attach button, Send and the pane's drop target are all disabled, and set the placeholder. Do not touch the draft.

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run tests/renderer && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/WaitingCard.tsx src/renderer/components/WaitingCard.css src/renderer/components/ConversationView.tsx tests/renderer
git commit -m "feat(conversation): show when the agent is waiting on you, and pause typing"
```

---

### Task 12: Prove it against real agents, then hand it over

**Files:**
- Create (throwaway): `<scratchpad>/live/tests/live-feedback.test.ts`
- Modify: `KNOWN_ISSUES.md`, `docs/superpowers/specs/2026-09-17-part-2-followups-handoff.md`

- [ ] **Step 1: Run the whole suite and the types**

Run: `npm test && npm run typecheck`
Expected: PASS, with the count written down. Report the real numbers, including any failure.

- [ ] **Step 2: Drive real sessions**

Launch the app detached so discovery does not see the launching shell as an ancestor:

```bash
tmux new-session -d -s workspace-app -c /Users/davidbrabbins/Documents/David/llm-workspace 'npm run dev'
```

With a real Claude session and a real Codex session, check each one from the agent's own log, never from the screen:

- send while idle: the entry appears at once and is replaced when the log has it;
- send while busy: Claude shows Queued and the message lands after the turn; Codex shows Queued and lands after the turn (or is refused, if Task 3 chose the fallback);
- the strip appears within about a second of the agent starting work, and goes when it stops;
- interrupt Codex with Esc: the strip goes and the card shows idle, instead of working forever;
- make Claude ask a question: the card appears, the box is off, and answering in the Terminal clears it.

- [ ] **Step 3: Eyes on**

Ask David to look at the real window: the strip, the waiting card, Queued, Not seen, in light and dark. A passing suite is not the finish line for a rendered surface. Fix what he reports before moving on.

- [ ] **Step 4: Stop the app cleanly**

```bash
tmux kill-session -t workspace-app
pgrep -fl 'Electron.*llm-workspace' || echo 'no electron mains left'
```

Killing the npm wrapper leaves the Electron window alive — check for zero mains, not just the wrapper.

- [ ] **Step 5: Update the docs**

- `KNOWN_ISSUES.md`: move the Codex interrupt bug to FIXED with the commit; record what Tab does.
- The Part 2 follow-ups handoff: mark priority 1 done, with the merge and the test count, and leave priorities 2 and 3 as they are.

- [ ] **Step 6: Commit and finish the branch**

```bash
git add KNOWN_ISSUES.md docs/superpowers/specs/2026-09-17-part-2-followups-handoff.md
git commit -m "docs: live conversation feedback shipped; codex interrupt fixed"
```

Then use the `superpowers:finishing-a-development-branch` skill to decide how this integrates.

---

## Self-review notes

- **Spec coverage.** §4 pending messages → Tasks 8, 9. §5 live state → Tasks 5, 6, 7. §6 strip and card → Tasks 10, 11. §7 Codex → Tasks 1, 2, 3, 4. §8 errors → the error paths inside Tasks 2, 5, 6, 9. §9 security → Task 6 (pid validation, path from the integer) plus the `security.test.ts` additions. §10 testing → each task's tests plus Task 12. §11 out of scope → nothing here builds Part 4's answer buttons.
- **Names used across tasks:** `isCodexBusy` (2 → 4), `deriveActivity` (5), `buildSessionLive` (5 → 6), `watchSessionFor` / `notifySessionChanged` / `pushSessionLive` (6 → 6's wiring), `useSessionLive` (7 → 9, 10, 11), `addPending` / `dropPending` / `matchPending` / `NOT_SEEN_AFTER_MS` (8 → 9), `elapsed` (10). Checked consistent.
- **Known gap by design:** Task 3 can change Task 4's shape. That is the point of the gate, and both branches are written out.
