# Phase 6 — Launch and Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app a place to work in agent sessions, not just watch them — launch a session, stream its terminal, and reply to it, all in one window.

**Architecture:** Main owns tmux and every process; the renderer names a pid and nothing else. tmux is the PTY, so there is no node-pty: `pipe-pane` out, `send-keys` in, `capture-pane` for scrollback, `resize-window` for size. The card grid becomes a left rail when a session is selected, and the main area is a pluggable pane showing Conversation (parsed transcript) or Terminal (raw xterm.js).

**Tech Stack:** Electron 44, TypeScript, React, electron-vite, better-sqlite3, vitest + @testing-library/react, tmux 3.7c, @xterm/xterm 6.

**Spec:** `docs/superpowers/specs/2026-09-12-phase-6-launch-and-reply-design.md`

## Global Constraints

- **Existing styles only.** `theme.css` tokens and existing `.card` / `.crow` / `.prov` classes. No new palette, no new font stack.
- **No new native modules.** `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`, `@xterm/addon-webgl@0.19.0` only. All renderer-only; never import them from `src/main` or `src/preload`.
- **No keystroke injection into non-tmux terminals.** `selectTerminalSession` (`src/main/ipc.ts:343-385`) is never extended to typing. Binding spec §11.
- **Argument arrays only.** Everything reaching `tmux` or `osascript` is argv, never a shell string. Never `{shell: true}`.
- **`tmux send-keys` always uses `-l`** for message text, and Enter is always a separate call with a literal our code chose.
- **Exact tmux targeting:** `-t =<name>`, never a bare name.
- **The renderer never supplies a tmux session name or a tty.** It supplies a pid; main re-derives everything.
- **`sanitizeForDisplay` is never applied to terminal bytes.** It strips the CSI/OSC sequences that are the content.
- tmux session naming: `llmws-<provider>-<short-session-id>`.
- Test commands: `npm test` (all), `npx vitest run <path>` (one file), `npm run typecheck`.
- **Mutation-test every new test before trusting it** (no Stryker here — do it by hand: break the implementation, confirm the test fails, restore). Eleven tests shipped on Phase 3 unable to fail.
- **One agent on the working tree at a time.**

---

### Task 1: tmux primitives

The only module that shells out to tmux. Everything is argv; nothing here ever sees renderer input directly.

**Files:**
- Create: `src/main/tmux.ts`
- Test: `tests/main/tmux.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TmuxResult = { ok: true; stdout: string } | { ok: false; error: string }`
  - `type TmuxExec = (args: string[]) => TmuxResult`
  - `hasSession(name: string, exec?: TmuxExec): boolean`
  - `newSession(name: string, cwd: string, command: string, cols: number, rows: number, exec?: TmuxExec): TmuxResult`
  - `sendLiteral(name: string, text: string, exec?: TmuxExec): TmuxResult`
  - `sendKeyName(name: string, key: string, exec?: TmuxExec): TmuxResult`
  - `capturePane(name: string, lines: number, exec?: TmuxExec): TmuxResult`
  - `resizeWindow(name: string, cols: number, rows: number, exec?: TmuxExec): TmuxResult`
  - `panePid(name: string, exec?: TmuxExec): number | null`
  - `TMUX_NAME = /^llmws-(claude|codex)-[A-Za-z0-9_-]{1,64}$/`

- [ ] **Step 1: Write the failing test**

```ts
// tests/main/tmux.test.ts
import { describe, it, expect } from 'vitest';
import { sendLiteral, sendKeyName, hasSession, capturePane, TMUX_NAME } from '../../src/main/tmux.ts';

function spy() {
  const calls: string[][] = [];
  return { calls, exec: (args: string[]) => { calls.push(args); return { ok: true as const, stdout: '' }; } };
}

describe('tmux argv construction', () => {
  it('sends message text with -l, as its own argv element', () => {
    const s = spy();
    sendLiteral('llmws-claude-abc', 'C-c', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc', '-l', 'C-c']);
  });

  it('never concatenates text with a following Enter', () => {
    const s = spy();
    sendLiteral('llmws-claude-abc', 'hello', s.exec);
    for (const arg of s.calls[0]) expect(arg).not.toMatch(/hello.*Enter/);
    expect(s.calls).toHaveLength(1);
  });

  it('sends a key name without -l, in its own call', () => {
    const s = spy();
    sendKeyName('llmws-claude-abc', 'Enter', s.exec);
    expect(s.calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc', 'Enter']);
  });

  it('targets exactly, never by prefix', () => {
    const s = spy();
    hasSession('llmws-claude-abc', s.exec);
    capturePane('llmws-claude-abc', 2000, s.exec);
    for (const c of s.calls) {
      const t = c[c.indexOf('-t') + 1];
      expect(t.startsWith('=')).toBe(true);
    }
  });

  it('rejects a name that is not ours', () => {
    expect(TMUX_NAME.test('llmws-claude-abc123')).toBe(true);
    expect(TMUX_NAME.test('other-session')).toBe(false);
    expect(TMUX_NAME.test('llmws-claude-a;rm -rf /')).toBe(false);
    expect(TMUX_NAME.test('llmws-claude-a:0.1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/tmux.test.ts`
Expected: FAIL — cannot resolve `../../src/main/tmux.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/tmux.ts
import { execFileSync } from 'node:child_process';

export type TmuxResult = { ok: true; stdout: string } | { ok: false; error: string };
export type TmuxExec = (args: string[]) => TmuxResult;

/** Only names this app generates. Anchored, and deliberately excludes ':'
 *  and '.', which tmux's own target grammar uses for window.pane. */
export const TMUX_NAME = /^llmws-(claude|codex)-[A-Za-z0-9_-]{1,64}$/;

function defaultExec(args: string[]): TmuxResult {
  try {
    return { ok: true, stdout: execFileSync('tmux', args, { timeout: 5000 }).toString() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'tmux failed' };
  }
}

/** Every target is '=name': tmux matches by prefix otherwise. */
function target(name: string): string {
  return `=${name}`;
}

function guard(name: string): void {
  if (!TMUX_NAME.test(name)) throw new Error('refusing a tmux name this app did not generate');
}

export function hasSession(name: string, exec: TmuxExec = defaultExec): boolean {
  guard(name);
  return exec(['has-session', '-t', target(name)]).ok;
}

export function newSession(
  name: string, cwd: string, command: string, cols: number, rows: number,
  exec: TmuxExec = defaultExec,
): TmuxResult {
  guard(name);
  // -x/-y at creation: there is no attached client, so tmux never learns the
  // size on its own and output would wrap at the default width.
  return exec(['new-session', '-d', '-s', name, '-c', cwd, '-x', String(cols), '-y', String(rows), command]);
}

/** -l is mandatory. Without it tmux reads the text as a KEY NAME: sending
 *  the three characters "C-c" delivers a real Ctrl-C instead. */
export function sendLiteral(name: string, text: string, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['send-keys', '-t', target(name), '-l', text]);
}

/** Deliberate control keys only, chosen by our code, never derived from
 *  user text. Kept in a separate call so text and Enter can never merge. */
export function sendKeyName(name: string, key: string, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['send-keys', '-t', target(name), key]);
}

export function capturePane(name: string, lines: number, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['capture-pane', '-p', '-S', `-${lines}`, '-t', target(name)]);
}

export function resizeWindow(name: string, cols: number, rows: number, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  return exec(['resize-window', '-t', target(name), '-x', String(cols), '-y', String(rows)]);
}

export function panePid(name: string, exec: TmuxExec = defaultExec): number | null {
  guard(name);
  const r = exec(['list-panes', '-t', target(name), '-F', '#{pane_pid}']);
  if (!r.ok) return null;
  const pid = Number.parseInt(r.stdout.trim().split('\n')[0] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/tmux.test.ts && npm run typecheck`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-test the suite**

Make each mutation, confirm a test fails, restore:
1. Drop `'-l'` from `sendLiteral` → the first test must fail.
2. Change `target()` to return `name` → the exact-targeting test must fail.
3. Loosen `TMUX_NAME` to `/llmws-/` → the rejection test must fail.

If any mutation passes, the test is decorative — fix it before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/main/tmux.ts tests/main/tmux.test.ts
git commit -m "feat(tmux): argv-only primitives, with -l and exact targeting enforced by test"
```

---

### Task 2: Outbound sanitiser

The reverse direction of every sanitiser in this codebase. `sanitizeForDisplay` protects a *viewer* from agent text; this protects a *running process* from text we are about to type into it.

**Files:**
- Create: `src/main/outbound.ts`
- Test: `tests/main/outbound.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type OutboundRefusal = 'empty' | 'too_long' | 'contains_newline'`
  - `type OutboundResult = { ok: true; text: string } | { ok: false; reason: OutboundRefusal }`
  - `sanitizeOutbound(raw: unknown): OutboundResult`
  - `MAX_REPLY_CHARS = 4000`

- [ ] **Step 1: Write the failing test**

```ts
// tests/main/outbound.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, MAX_REPLY_CHARS } from '../../src/main/outbound.ts';

describe('sanitizeOutbound', () => {
  it('passes ordinary prose through unchanged', () => {
    expect(sanitizeOutbound('yes, commit it')).toEqual({ ok: true, text: 'yes, commit it' });
  });

  it('strips C0 controls, including ESC', () => {
    const r = sanitizeOutbound('a\x1bb\x03c\x07d');
    expect(r).toEqual({ ok: true, text: 'abcd' });
  });

  it('strips C1 controls', () => {
    expect(sanitizeOutbound('a\x85b\x9bc')).toEqual({ ok: true, text: 'abc' });
  });

  it('refuses embedded newlines rather than silently submitting twice', () => {
    expect(sanitizeOutbound('line one\nline two')).toEqual({ ok: false, reason: 'contains_newline' });
    expect(sanitizeOutbound('line one\r\nline two')).toEqual({ ok: false, reason: 'contains_newline' });
  });

  it('refuses text over the cap', () => {
    expect(sanitizeOutbound('x'.repeat(MAX_REPLY_CHARS + 1))).toEqual({ ok: false, reason: 'too_long' });
    expect(sanitizeOutbound('x'.repeat(MAX_REPLY_CHARS)).ok).toBe(true);
  });

  it('refuses anything that is not a string, and anything empty after stripping', () => {
    expect(sanitizeOutbound(42)).toEqual({ ok: false, reason: 'empty' });
    expect(sanitizeOutbound(null)).toEqual({ ok: false, reason: 'empty' });
    expect(sanitizeOutbound('\x1b\x03')).toEqual({ ok: false, reason: 'empty' });
  });

  it('leaves tab alone -- it is ordinary typed input, not a control action', () => {
    expect(sanitizeOutbound('a\tb')).toEqual({ ok: true, text: 'a\tb' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/outbound.test.ts`
Expected: FAIL — cannot resolve `../../src/main/outbound.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/outbound.ts

/** Outbound, renderer -> a live process's keyboard. The inverse of
 *  sanitizeForDisplay (src/main/ipc.ts:82), which exists to stop agent text
 *  harming a VIEWER. "Safe to display" is not "safe to type": here the danger
 *  is the receiving program acting on a control byte -- Ctrl-C, Ctrl-D, a bare
 *  ESC a TUI treats as cancel, a bracketed-paste introducer. Never reuse
 *  sanitizeForTerminal for this; it is tuned for the opposite direction. */

export const MAX_REPLY_CHARS = 4000;

export type OutboundRefusal = 'empty' | 'too_long' | 'contains_newline';
export type OutboundResult = { ok: true; text: string } | { ok: false; reason: OutboundRefusal };

// Tab (\t) is deliberately absent -- it is ordinary typed input. Newlines are
// handled separately and explicitly, before stripping, so they refuse loudly
// rather than vanishing.
const C0_EXCEPT_TAB_NEWLINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const C1_CONTROLS = /[\x80-\x9f]/g;
const NEWLINE = /[\r\n]/;

/** A newline typed into a pane submits the current line, so multi-line text
 *  becomes several submissions -- a way to smuggle a second message past what
 *  the UI showed as one reply. Refuse; do not silently collapse. */
export function sanitizeOutbound(raw: unknown): OutboundResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  if (NEWLINE.test(raw)) return { ok: false, reason: 'contains_newline' };
  if (raw.length > MAX_REPLY_CHARS) return { ok: false, reason: 'too_long' };
  const text = raw.replace(C0_EXCEPT_TAB_NEWLINE, '').replace(C1_CONTROLS, '');
  if (text.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, text };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/outbound.test.ts && npm run typecheck`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-test the suite**

1. Remove `\x1b` from the C0 class (change `\x0e-\x1f` to `\x0e-\x1a`) → the ESC-stripping test must fail.
2. Change the newline branch to `return { ok: true, text: raw.replace(NEWLINE, ' ') }` → the newline test must fail.
3. Change `>` to `>=` in the length check → the boundary test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/main/outbound.ts tests/main/outbound.test.ts
git commit -m "feat(security): outbound sanitiser -- safe to display is not safe to type"
```

---

### Task 3: Session registry and revalidation

Main's own map of pid to tmux name, and the "re-derive before acting" rule that `killSession` already sets the precedent for.

**Files:**
- Create: `src/main/sessions.ts`
- Test: `tests/main/sessions.test.ts`

**Interfaces:**
- Consumes: Task 1 (`hasSession`, `panePid`, `TMUX_NAME`).
- Produces:
  - `registerSession(pid: number, name: string): void`
  - `forgetSession(pid: number): void`
  - `tmuxNameForPid(pid: unknown): string | null`
  - `resolveLiveTmux(pid: unknown, deps?: { has?: (n: string) => boolean }): string | null`
  - `clearRegistry(): void` (tests only)

- [ ] **Step 1: Write the failing test**

```ts
// tests/main/sessions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { registerSession, forgetSession, tmuxNameForPid, resolveLiveTmux, clearRegistry } from '../../src/main/sessions.ts';

beforeEach(() => clearRegistry());

describe('session registry', () => {
  it('maps a pid to the name main itself chose', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(tmuxNameForPid(4821)).toBe('llmws-claude-abc');
  });

  it('refuses to register a name this app did not generate', () => {
    expect(() => registerSession(4821, 'someone-elses-session')).toThrow();
    expect(tmuxNameForPid(4821)).toBeNull();
  });

  it('returns null for an unknown or malformed pid', () => {
    expect(tmuxNameForPid(9999)).toBeNull();
    expect(tmuxNameForPid('4821')).toBeNull();
    expect(tmuxNameForPid(-1)).toBeNull();
    expect(tmuxNameForPid(1.5)).toBeNull();
  });

  it('resolveLiveTmux refuses when the session is gone, even though the map still has it', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(resolveLiveTmux(4821, { has: () => false })).toBeNull();
    expect(resolveLiveTmux(4821, { has: () => true })).toBe('llmws-claude-abc');
  });

  it('forgets a pid', () => {
    registerSession(4821, 'llmws-claude-abc');
    forgetSession(4821);
    expect(tmuxNameForPid(4821)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/sessions.test.ts`
Expected: FAIL — cannot resolve `../../src/main/sessions.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/sessions.ts
import { hasSession, TMUX_NAME } from './tmux.ts';

/** pid -> tmux session name, populated at launch because main is what ran
 *  `tmux new-session` and therefore already knows the name it chose. Names are
 *  never regenerated, guessed, or accepted from the renderer: the renderer
 *  names a pid, exactly as session:kill already requires (src/main/ipc.ts:485). */
const byPid = new Map<number, string>();

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

export function registerSession(pid: number, name: string): void {
  if (!validPid(pid)) throw new Error('invalid pid');
  if (!TMUX_NAME.test(name)) throw new Error('refusing a tmux name this app did not generate');
  byPid.set(pid, name);
}

export function forgetSession(pid: number): void {
  byPid.delete(pid);
}

export function tmuxNameForPid(pid: unknown): string | null {
  if (!validPid(pid)) return null;
  return byPid.get(pid) ?? null;
}

/** The equivalent of killSession's fresh-discovery check. A name that merely
 *  LOOKS right, or that was true a minute ago, is not enough: re-verify the
 *  session exists right now, on this call, before anything is typed into it. */
export function resolveLiveTmux(pid: unknown, deps: { has?: (n: string) => boolean } = {}): string | null {
  const name = tmuxNameForPid(pid);
  if (name === null) return null;
  const has = deps.has ?? ((n: string) => hasSession(n));
  return has(name) ? name : null;
}

export function clearRegistry(): void {
  byPid.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/sessions.test.ts && npm run typecheck`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-test the suite**

1. Make `resolveLiveTmux` return `name` without calling `has` → the "session is gone" test must fail.
2. Drop the `TMUX_NAME` check in `registerSession` → the refusal test must fail.
3. Change `validPid` to `typeof pid === 'number'` → the malformed-pid test must fail on `1.5` and `-1`.

- [ ] **Step 6: Commit**

```bash
git add src/main/sessions.ts tests/main/sessions.test.ts
git commit -m "feat(sessions): pid->tmux registry, revalidated on every use"
```

---

### Task 4: Conversation query

**Files:**
- Create: `src/store/conversation.ts`
- Test: `tests/store/conversation.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/store/db.ts`.
- Produces:
  - `type ConversationTurn = { id: number; ts: string; role: 'user' | 'assistant'; text: string; agentId: string | null }`
  - `conversationFor(db: Db, sessionId: string, limit?: number): ConversationTurn[]`
  - `unwrapSlashCommand(text: string): string`
  - `CONVERSATION_LIMIT = 500`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/conversation.test.ts
import { describe, it, expect } from 'vitest';
import { unwrapSlashCommand } from '../../src/store/conversation.ts';

describe('unwrapSlashCommand', () => {
  it('reduces a slash-command wrapper to the command the user actually typed', () => {
    const raw = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
    expect(unwrapSlashCommand(raw)).toBe('/clear');
  });

  it('keeps the arguments when there are some', () => {
    const raw = '<command-name>/loop</command-name><command-args>5m /foo</command-args>';
    expect(unwrapSlashCommand(raw)).toBe('/loop 5m /foo');
  });

  it('leaves ordinary prose completely alone', () => {
    expect(unwrapSlashCommand('run the farm tests')).toBe('run the farm tests');
    expect(unwrapSlashCommand('use <angle brackets> in prose')).toBe('use <angle brackets> in prose');
  });

  it('returns empty for a wrapper with no command name, rather than leaking markup', () => {
    expect(unwrapSlashCommand('<command-message>x</command-message>')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/conversation.test.ts`
Expected: FAIL — cannot resolve `../../src/store/conversation.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/store/conversation.ts
import type { Db } from './db.ts';

export const CONVERSATION_LIMIT = 500;

export type ConversationTurn = {
  id: number;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  agentId: string | null;
};

const NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** prompt.submitted sometimes carries a slash-command wrapper as literal text
 *  -- 115 Claude rows and 83 Codex rows in the real index. Rendered verbatim
 *  it shows as XML. Both providers do it, so this is one rule, not two. */
export function unwrapSlashCommand(text: string): string {
  if (!text.includes('<command-')) return text;
  const name = NAME.exec(text)?.[1]?.trim() ?? '';
  if (name === '') return '';
  const args = ARGS.exec(text)?.[1]?.trim() ?? '';
  return args === '' ? name : `${name} ${args}`;
}

/** Served entirely by events_session_ts(session_id, ts) -- src/store/schema.ts:50.
 *  Verified with EXPLAIN QUERY PLAN against the real index: SEARCH, not SCAN,
 *  and 3ms on the busiest session (18,683 events). The kind filter does not
 *  force a scan because session_id leads the index, so the missing
 *  events.kind index costs nothing here. Do not add one. */
export function conversationFor(db: Db, sessionId: string, limit = CONVERSATION_LIMIT): ConversationTurn[] {
  const rows = db.prepare(`
    SELECT id, ts, kind, agent_id, json_extract(payload,'$.text') AS text
    FROM events
    WHERE session_id = ? AND kind IN ('prompt.submitted','prose')
    ORDER BY ts, id
    LIMIT ?
  `).all(sessionId, limit) as Array<{
    id: number; ts: string; kind: string; agent_id: string | null; text: string | null;
  }>;

  const turns: ConversationTurn[] = [];
  for (const r of rows) {
    if (r.text === null) continue;
    // prompt.submitted = user, prose = assistant, in BOTH parsers. This is the
    // provider-agnostic backbone; richer detail (tokens, tool payloads) is not.
    const role = r.kind === 'prompt.submitted' ? 'user' as const : 'assistant' as const;
    const text = role === 'user' ? unwrapSlashCommand(r.text) : r.text;
    if (text === '') continue;
    turns.push({ id: r.id, ts: r.ts, role, text, agentId: r.agent_id });
  }
  return turns;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/conversation.test.ts && npm run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the query plan against the real index, not a fixture**

```bash
sqlite3 ~/.llm-workspace/index.sqlite "EXPLAIN QUERY PLAN SELECT id, ts, kind, agent_id FROM events WHERE session_id = (SELECT session_id FROM events LIMIT 1) AND kind IN ('prompt.submitted','prose') ORDER BY ts, id LIMIT 500;"
```

Expected: output contains `USING INDEX events_session_ts`. If it says `SCAN`, stop — the query has drifted from the plan and the 3ms figure no longer holds.

- [ ] **Step 6: Mutation-test the suite**

1. Make `unwrapSlashCommand` return `text` unconditionally → the first two tests must fail.
2. Make it return `name` and ignore args → the arguments test must fail.
3. Drop the `name === ''` guard → the no-command-name test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/store/conversation.ts tests/store/conversation.test.ts
git commit -m "feat(store): per-session conversation query, on the index that already exists"
```

---

### Task 5: Terminal stream with coalescing

`pipe-pane` can deliver ~30 MB/s. Unbatched, that is millions of IPC messages. This is where it is bounded.

**Files:**
- Create: `src/main/stream.ts`
- Test: `tests/main/stream.test.ts`

**Interfaces:**
- Consumes: Task 3 (`resolveLiveTmux`).
- Produces:
  - `type TerminalDataPayload = { version: 1; pid: number; seq: number; data: string }`
  - `class Coalescer` with `push(chunk: string): void`, `flushNow(): void`
  - `makeCoalescer(pid: number, emit: (p: TerminalDataPayload) => void, schedule?: (fn: () => void) => void): Coalescer`
  - `COALESCE_MS = 16`, `MAX_FLUSH_CHARS = 262144`

- [ ] **Step 1: Write the failing test**

```ts
// tests/main/stream.test.ts
import { describe, it, expect } from 'vitest';
import { makeCoalescer, MAX_FLUSH_CHARS } from '../../src/main/stream.ts';

function harness() {
  const sent: Array<{ seq: number; data: string }> = [];
  let pending: (() => void) | null = null;
  const c = makeCoalescer(4821, p => sent.push({ seq: p.seq, data: p.data }), fn => { pending = fn; });
  return { sent, c, tick: () => { const f = pending; pending = null; f?.(); } };
}

describe('terminal stream coalescing', () => {
  it('batches many small writes into one message', () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.c.push('x');
    expect(h.sent).toHaveLength(0);
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].data).toHaveLength(1000);
  });

  it('numbers messages so the renderer can detect a gap', () => {
    const h = harness();
    h.c.push('a'); h.tick();
    h.c.push('b'); h.tick();
    expect(h.sent.map(s => s.seq)).toEqual([0, 1]);
  });

  it('caps a single flush and keeps the remainder for the next one', () => {
    const h = harness();
    h.c.push('y'.repeat(MAX_FLUSH_CHARS + 500));
    h.tick();
    expect(h.sent[0].data).toHaveLength(MAX_FLUSH_CHARS);
    h.tick();
    expect(h.sent[1].data).toHaveLength(500);
  });

  it('emits nothing when there is nothing buffered', () => {
    const h = harness();
    h.tick();
    expect(h.sent).toHaveLength(0);
  });

  it('schedules once per burst, not once per chunk', () => {
    let scheduled = 0;
    const c = makeCoalescer(1, () => {}, () => { scheduled++; });
    c.push('a'); c.push('b'); c.push('c');
    expect(scheduled).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/stream.test.ts`
Expected: FAIL — cannot resolve `../../src/main/stream.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/stream.ts

/** tmux pipe-pane measured at ~30 MB/s on this machine (18.6 MB in 0.59s).
 *  That is far faster than anyone reads and fast enough to drown the renderer:
 *  one IPC message per line would be millions of messages. Bound it here, by
 *  design rather than by luck. Nothing about pushFleet (src/main/ipc.ts:622)
 *  is reusable -- that sends a whole snapshot and throttles at its call sites,
 *  which does not generalise to an append-only stream. */

export const COALESCE_MS = 16;
export const MAX_FLUSH_CHARS = 262_144;

export type TerminalDataPayload = { version: 1; pid: number; seq: number; data: string };

export type Coalescer = { push(chunk: string): void; flushNow(): void };

export function makeCoalescer(
  pid: number,
  emit: (payload: TerminalDataPayload) => void,
  schedule: (fn: () => void) => void = fn => { setTimeout(fn, COALESCE_MS); },
): Coalescer {
  let buffer = '';
  let seq = 0;
  let armed = false;

  function flushNow(): void {
    armed = false;
    if (buffer.length === 0) return;
    const data = buffer.slice(0, MAX_FLUSH_CHARS);
    buffer = buffer.slice(MAX_FLUSH_CHARS);
    emit({ version: 1, pid, seq: seq++, data });
    // A burst larger than one flush keeps its remainder and re-arms, rather
    // than dropping it or sending an unbounded message.
    if (buffer.length > 0) arm();
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    schedule(flushNow);
  }

  return {
    push(chunk: string): void { buffer += chunk; arm(); },
    flushNow,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/stream.test.ts && npm run typecheck`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-test the suite**

1. Remove the `if (armed) return;` guard → the schedule-once test must fail.
2. Emit the whole buffer ignoring `MAX_FLUSH_CHARS` → the cap test must fail.
3. Remove the `buffer.length === 0` guard → the empty-tick test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/main/stream.ts tests/main/stream.test.ts
git commit -m "feat(stream): coalesce terminal bytes -- 30MB/s in, one frame's worth out"
```

---

### Task 6: IPC channels

**Files:**
- Modify: `src/main/ipc.ts` (add handlers next to the existing four at `:596-604`)
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types.d.ts`
- Modify: `tests/main/ipc.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces:
  - `type KeysRefusalReason = 'not_tmux' | 'session_gone' | 'invalid_pid' | OutboundRefusal`
  - `type KeysResult = { status: 'sent' } | { status: 'refused'; reason: KeysRefusalReason }`
  - preload: `conversation(sessionId)`, `sendKeys(pid, text)`, `attach(pid, cols, rows)`, `detach(pid)`, `onTerminalData(cb)`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/main/ipc.test.ts
import { sendKeysFor } from '../../src/main/ipc.ts';
import { registerSession, clearRegistry } from '../../src/main/sessions.ts';

describe('session:keys', () => {
  beforeEach(() => clearRegistry());

  it('refuses a pid with no tmux session -- the iTerm case', () => {
    expect(sendKeysFor(4821, 'hello', { has: () => true, send: () => ({ ok: true, stdout: '' }) }))
      .toEqual({ status: 'refused', reason: 'not_tmux' });
  });

  it('refuses when the session vanished between render and click', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(sendKeysFor(4821, 'hello', { has: () => false, send: () => ({ ok: true, stdout: '' }) }))
      .toEqual({ status: 'refused', reason: 'session_gone' });
  });

  it('refuses multi-line text before it reaches tmux', () => {
    registerSession(4821, 'llmws-claude-abc');
    let called = false;
    const r = sendKeysFor(4821, 'a\nb', { has: () => true, send: () => { called = true; return { ok: true, stdout: '' }; } });
    expect(r).toEqual({ status: 'refused', reason: 'contains_newline' });
    expect(called).toBe(false);
  });

  it('sends text and Enter as two separate calls, text first, with -l', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = sendKeysFor(4821, 'yes', {
      has: () => true,
      send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'sent' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc', '-l', 'yes']);
    expect(calls[1]).toEqual(['send-keys', '-t', '=llmws-claude-abc', 'Enter']);
  });
});

describe('terminal:data parity', () => {
  // The parity test at :700 only sees ipcMain.handle/ipcRenderer.invoke, so a
  // push channel is invisible to it and ships unguarded otherwise.
  it('every webContents.send channel has a matching ipcRenderer.on in preload', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    const preload = strip(readFileSync('src/preload/index.ts', 'utf8'));
    const pushed = [...ipc.matchAll(/webContents\.send\('([^']+)'/g)].map(m => m[1]).sort();
    const heard = [...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map(m => m[1]).sort();
    expect(pushed).toEqual(heard);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/ipc.test.ts`
Expected: FAIL — `sendKeysFor` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/main/ipc.ts`:

```ts
import { sanitizeOutbound, type OutboundRefusal } from './outbound.ts';
import { resolveLiveTmux } from './sessions.ts';
import { sendLiteral, sendKeyName, type TmuxResult } from './tmux.ts';

export type KeysRefusalReason = 'not_tmux' | 'session_gone' | 'invalid_pid' | OutboundRefusal;
export type KeysResult = { status: 'sent' } | { status: 'refused'; reason: KeysRefusalReason };

type KeysDeps = { has?: (n: string) => boolean; send?: (args: string[]) => TmuxResult };

/** The renderer sends a pid and text, never a session name. Refusals are
 *  returned, not thrown: the card has to be able to say WHY nothing happened,
 *  and "not_tmux" is the ordinary answer for a session running in plain iTerm. */
export function sendKeysFor(pid: unknown, raw: unknown, deps: KeysDeps = {}): KeysResult {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { status: 'refused', reason: 'invalid_pid' };
  }
  // Sanitise BEFORE resolving, so malformed text never reaches tmux even
  // momentarily, and the cheap check runs first.
  const clean = sanitizeOutbound(raw);
  if (!clean.ok) return { status: 'refused', reason: clean.reason };

  const known = tmuxNameForPid(pid);
  if (known === null) return { status: 'refused', reason: 'not_tmux' };
  const name = resolveLiveTmux(pid, { has: deps.has });
  if (name === null) return { status: 'refused', reason: 'session_gone' };

  // Two calls, always. Text with -l; Enter as a key name our code chose.
  // Concatenating them would let a reply of "Enter" become a keypress.
  sendLiteral(name, clean.text, deps.send);
  sendKeyName(name, 'Enter', deps.send);
  return { status: 'sent' };
}
```

Register the channels inside `registerIpc`:

```ts
  ipcMain.handle('session:conversation', (_e, sessionId: unknown) =>
    typeof sessionId === 'string' ? conversationFor(db, sessionId) : []);
  ipcMain.handle('session:keys', (_e, pid: unknown, text: unknown) => sendKeysFor(pid, text));
```

Add to `src/preload/index.ts`'s `api` object. All nine channels go in together —
`TerminalView` (Task 10) calls `attach`, `detach`, `resize` and `sendRaw`, so
omitting any of them leaves that task unbuildable:

```ts
  // Free-form text from the renderer: the first channel of its kind here.
  // Main sanitises and revalidates; the typing below narrows nothing.
  sendKeys: (pid: number, text: string) => ipcRenderer.invoke('session:keys', pid, text),
  // Raw keystrokes from the terminal widget itself -- arrow keys, Ctrl-C, the
  // TUI menu navigation the reply box deliberately refuses. Separate channel
  // from sendKeys precisely because the rules differ: this one MUST pass
  // control bytes through, so it is only ever reachable from a focused
  // TerminalView, never from the popover.
  sendRaw: (pid: number, data: string) => ipcRenderer.invoke('session:raw', pid, data),
  conversation: (sessionId: string) => ipcRenderer.invoke('session:conversation', sessionId),
  attach: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:attach', pid, cols, rows),
  detach: (pid: number) => ipcRenderer.invoke('session:detach', pid),
  resize: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:resize', pid, cols, rows),
  launch: (provider: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.invoke('session:launch', provider, cwd, cols, rows),
  reattach: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:reattach', pid, cols, rows),
  onTerminalData: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.off('terminal:data', handler);
  },
```

- [ ] **Step 3b: Add the capture-pane check before sending (spec §9)**

Write this test first, then make it pass:

```ts
it('refuses when the pane no longer looks like the session we think it is', () => {
  registerSession(4821, 'llmws-claude-abc');
  const r = sendKeysFor(4821, 'yes', {
    has: () => true,
    capture: () => ({ ok: false as const, error: 'no such pane' }),
    send: () => ({ ok: true, stdout: '' }),
  });
  expect(r).toEqual({ status: 'refused', reason: 'session_gone' });
});
```

In `sendKeysFor`, after `resolveLiveTmux` succeeds, call `capturePane(name, 1, deps.capture)`
and refuse with `session_gone` if it fails. The session name resolving is not
proof the pane is still there to receive anything.

Add the matching entries to `src/renderer/types.d.ts`, importing `KeysResult` and `ConversationTurn`. (Note the existing bug there: `RevealResult` is referenced but not imported — do not replicate the pattern.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main/ipc.test.ts && npm run typecheck`
Expected: PASS, including both existing parity tests and the new push-parity test.

- [ ] **Step 5: Mutation-test the new tests**

1. Swap the order so Enter is sent before the text → the two-calls test must fail.
2. Merge them into `sendLiteral(name, clean.text + ' Enter')` → the same test must fail.
3. Drop the `resolveLiveTmux` call and use `known` → the session-gone test must fail.
4. Remove `onTerminalData` from preload → the new push-parity test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/renderer/types.d.ts tests/main/ipc.test.ts
git commit -m "feat(ipc): conversation and keys channels, plus parity coverage for pushes"
```

---

### Task 7: Hoist fleet state so views are peers

Spec §14: the Fleet grid and the future Game view must be peers over one state source. Cheap now, expensive to retrofit.

**Files:**
- Create: `src/renderer/state/useFleet.ts`
- Modify: `src/renderer/components/FleetView.tsx:47-68` (remove its private subscription)
- Test: `tests/renderer/useFleet.test.tsx`

**Interfaces:**
- Produces:
  - `type Selection = { pid: number; view: 'conversation' | 'terminal' } | null`
  - `useFleet(): { payload: FleetListPayload | null; error: string | null; selection: Selection; select(pid: number): void; setView(v: 'conversation'|'terminal'): void; clear(): void }`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/renderer/useFleet.test.tsx
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFleet } from '../../src/renderer/state/useFleet.ts';

describe('useFleet selection', () => {
  it('starts with nothing selected, so the grid renders full width', () => {
    const { result } = renderHook(() => useFleet());
    expect(result.current.selection).toBeNull();
  });

  it('selects a pid and defaults to the conversation view, not the raw terminal', () => {
    const { result } = renderHook(() => useFleet());
    act(() => result.current.select(4821));
    expect(result.current.selection).toEqual({ pid: 4821, view: 'conversation' });
  });

  it('switches view without losing the selection', () => {
    const { result } = renderHook(() => useFleet());
    act(() => result.current.select(4821));
    act(() => result.current.setView('terminal'));
    expect(result.current.selection).toEqual({ pid: 4821, view: 'terminal' });
  });

  it('clears back to the grid', () => {
    const { result } = renderHook(() => useFleet());
    act(() => result.current.select(4821));
    act(() => result.current.clear());
    expect(result.current.selection).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/useFleet.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/renderer/state/useFleet.ts
import { useCallback, useEffect, useState } from 'react';
import type { FleetListPayload } from '../../fleet/state.ts';

export type PaneView = 'conversation' | 'terminal';
export type Selection = { pid: number; view: PaneView } | null;

/** One source of fleet state, consumed by every pane. The grid used to own
 *  this privately (FleetView.tsx:47-68); the Game view needs exactly the same
 *  data and the same "select this session" callback, so it lives here instead.
 *  Defaulting to 'conversation' is what keeps the raw terminal opt-in. */
export function useFleet() {
  const [payload, setPayload] = useState<FleetListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  useEffect(() => {
    let alive = true;
    const api = window.fleet;
    if (!api) { setError('bridge unavailable'); return; }
    void api.listFleet().then(p => { if (alive) setPayload(p as FleetListPayload); });
    const unsub = api.onFleet(p => { if (alive) { setPayload(p as FleetListPayload); setError(null); } });
    return () => { alive = false; unsub(); };
  }, []);

  const select = useCallback((pid: number) => setSelection({ pid, view: 'conversation' }), []);
  const setView = useCallback((view: PaneView) => {
    setSelection(s => (s === null ? s : { ...s, view }));
  }, []);
  const clear = useCallback(() => setSelection(null), []);

  return { payload, error, selection, select, setView, clear };
}
```

Then change `FleetView` to accept `payload`/`error`/`onSelect` as props and delete its own `useEffect` subscription at `:47-68`, and replace both `onOpen={() => {}}` sites (`:135`, `:176`) with `onOpen={onSelect}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/renderer/ && npm run typecheck`
Expected: PASS. Existing `FleetView` tests may need their props updated; update them, do not delete assertions.

- [ ] **Step 5: Mutation-test the suite**

1. Default `select` to `'terminal'` → the default-view test must fail.
2. Make `setView` replace the whole selection → the keeps-selection test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/state/useFleet.ts src/renderer/components/FleetView.tsx tests/renderer/
git commit -m "refactor(renderer): one fleet state, so grid and game view are peers"
```

---

### Task 8: Session rail

**Files:**
- Create: `src/renderer/components/SessionRail.tsx`, `src/renderer/components/SessionRail.css`
- Test: `tests/renderer/SessionRail.test.tsx`

**Interfaces:**
- Consumes: Task 7 (`Selection`), existing `OpenSession`, `OpenSessionCard`.
- Produces: `<SessionRail sessions selectedPid onSelect side />` where `side: 'left' | 'right'`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/renderer/SessionRail.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionRail } from '../../src/renderer/components/SessionRail.tsx';

const sessions = [
  { pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'All green.', cwd: '/a', host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
  { pid: 2, project: 'game-viewer', provider: 'codex', activity: 'waiting_input', lastProse: 'Overwrite?', cwd: '/b', host: 'iterm2', ageSeconds: 60, rssBytes: 1e8, events: 10 },
] as never[];

describe('SessionRail', () => {
  it('renders one card per session, keeping its content', () => {
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} side="left" />);
    expect(screen.getByText('llm-workspace')).toBeTruthy();
    expect(screen.getByText('Overwrite?')).toBeTruthy();
  });

  it('still flags a session that needs you, so the rail stays readable while you work', () => {
    const { container } = render(<SessionRail sessions={sessions} selectedPid={1} onSelect={() => {}} side="left" />);
    expect(container.querySelectorAll('.attn')).toHaveLength(1);
  });

  it('reports the pid when a card is chosen', async () => {
    const onSelect = vi.fn();
    render(<SessionRail sessions={sessions} selectedPid={null} onSelect={onSelect} side="left" />);
    await userEvent.click(screen.getByText('game-viewer'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('carries the side as a class so the toggle is CSS, not a second tree', () => {
    const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} side="right" />);
    expect(container.querySelector('.rail.right')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/SessionRail.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/renderer/components/SessionRail.tsx
import type { OpenSession } from '../../fleet/state.ts';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import './SessionRail.css';

/** The card grid, collapsed to one column. Deliberately reuses
 *  OpenSessionCard rather than a slimmer variant: the whole point is that the
 *  fleet stays readable while you work in one session, which means the cards
 *  keep their content and their attention state. */
export function SessionRail({ sessions, selectedPid, onSelect, side }: {
  sessions: OpenSession[];
  selectedPid: number | null;
  onSelect: (pid: number) => void;
  side: 'left' | 'right';
}) {
  return (
    <nav className={`rail ${side}`} aria-label="Open sessions">
      {sessions.map(s => (
        <div key={s.pid} className={s.pid === selectedPid ? 'railitem sel' : 'railitem'}>
          <OpenSessionCard
            state={s}
            onOpen={onSelect}
            onKill={async () => ({ status: 'already_gone' as const })}
          />
        </div>
      ))}
    </nav>
  );
}
```

```css
/* src/renderer/components/SessionRail.css
   Tokens only -- theme.css owns every colour. */
.rail { display:flex; flex-direction:column; gap:6px; padding:8px;
  width:180px; flex:none; overflow-y:auto;
  background:var(--surface); }
.rail.left  { border-right:1px solid var(--line); order:0; }
.rail.right { border-left:1px solid var(--line); order:2; }
.railitem.sel .card { border-color:var(--accent); background:var(--raised); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/SessionRail.test.tsx && npm run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-test the suite**

1. Hard-code `side` to `'left'` in the className → the side test must fail.
2. Pass `onOpen={() => {}}` → the pid-reporting test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/SessionRail.tsx src/renderer/components/SessionRail.css tests/renderer/SessionRail.test.tsx
git commit -m "feat(rail): the grid, one column wide, still showing who needs you"
```

---

### Task 9: Conversation view component

**Files:**
- Create: `src/renderer/components/ConversationView.tsx`, `.css`
- Test: `tests/renderer/ConversationView.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`ConversationTurn`), Task 6 (`window.fleet.conversation`).
- Produces: `<ConversationView sessionId />`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/renderer/ConversationView.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConversationView } from '../../src/renderer/components/ConversationView.tsx';

const turns = [
  { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'run the farm tests', agentId: null },
  { id: 2, ts: '2026-09-12T10:00:05Z', role: 'assistant', text: 'All green. Want me to commit?', agentId: null },
];

beforeEach(() => {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    conversation: async () => turns,
  };
});

describe('ConversationView', () => {
  it('renders both sides of the conversation', async () => {
    render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.getByText('All green. Want me to commit?')).toBeTruthy();
  });

  it('labels who said what, since prose alone never showed the user', async () => {
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    expect(container.querySelector('.turn.assistant')).toBeTruthy();
  });

  it('says so plainly when a session has nothing to show', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = { conversation: async () => [] };
    render(<ConversationView sessionId="empty" />);
    await waitFor(() => expect(screen.getByText(/no conversation/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/renderer/components/ConversationView.tsx
import { useEffect, useState } from 'react';
import type { ConversationTurn } from '../../store/conversation.ts';
import './ConversationView.css';

/** The clean half of the toggle: what was said, not how it was rendered.
 *  This is the only view a non-tmux session can have, and it is still a real
 *  upgrade on the card -- the card shows one line. */
export function ConversationView({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);

  useEffect(() => {
    let alive = true;
    setTurns(null);
    void window.fleet?.conversation(sessionId).then(t => {
      if (alive) setTurns(t as ConversationTurn[]);
    });
    return () => { alive = false; };
  }, [sessionId]);

  if (turns === null) return <div className="conv loading">Loading…</div>;
  if (turns.length === 0) return <div className="conv empty">No conversation recorded for this session.</div>;

  return (
    <div className="conv">
      {turns.map(t => (
        <article key={t.id} className={`turn ${t.role}`}>
          <span className="who">{t.role === 'user' ? 'you' : 'agent'}</span>
          <p className="said">{t.text}</p>
        </article>
      ))}
    </div>
  );
}
```

```css
/* src/renderer/components/ConversationView.css */
.conv { padding:12px 14px; overflow-y:auto; flex:1; }
.conv.empty, .conv.loading { color:var(--muted); }
.turn { display:flex; gap:10px; margin-bottom:10px; }
.turn .who { font-family:var(--f-mono); font-size:11px; color:var(--faint);
  width:48px; flex:none; padding-top:2px; }
.turn .said { margin:0; font-size:13px; line-height:1.5; color:var(--ink-2);
  white-space:pre-wrap; }
.turn.user .said { color:var(--ink); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx && npm run typecheck`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-test the suite**

1. Render `t.text` without the `turn.${t.role}` class → the labelling test must fail.
2. Return `null` instead of the empty message → the empty test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ConversationView.tsx src/renderer/components/ConversationView.css tests/renderer/ConversationView.test.tsx
git commit -m "feat(conversation): both sides of the transcript, not just the last line"
```

---

### Task 10: Terminal view

**Files:**
- Modify: `package.json` (add three deps)
- Create: `src/renderer/components/TerminalView.tsx`, `.css`
- Test: `tests/renderer/TerminalView.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`TerminalDataPayload`), Task 6 (`attach`/`detach`/`onTerminalData`).
- Produces: `<TerminalView pid />`

- [ ] **Step 1: Install the dependencies**

```bash
npm install @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-webgl@0.19.0
npm run typecheck
```

Confirm no native build ran: the install must not invoke `node-gyp`. If it does, stop — the no-native-modules constraint is broken.

- [ ] **Step 2: Write the failing test**

```tsx
// tests/renderer/TerminalView.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalView } from '../../src/renderer/components/TerminalView.tsx';

const writes: string[] = [];
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24;
    loadAddon() {} open() {} dispose() {} onResize() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    write(d: string) { writes.push(d); }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} } }));

let handler: ((p: unknown) => void) | null = null;
beforeEach(() => {
  writes.length = 0;
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    attach: vi.fn(async () => ({ status: 'attached', backlog: 'previous output\n' })),
    detach: vi.fn(async () => ({ status: 'detached' })),
    onTerminalData: (cb: (p: unknown) => void) => { handler = cb; return () => { handler = null; }; },
  };
});

describe('TerminalView', () => {
  it('writes bytes imperatively, never through React state', async () => {
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    handler?.({ version: 1, pid: 4821, seq: 0, data: 'hello' });
    expect(writes).toContain('hello');
  });

  it('ignores bytes addressed to a different session', async () => {
    render(<TerminalView pid={4821} />);
    await Promise.resolve();
    handler?.({ version: 1, pid: 9999, seq: 0, data: 'not mine' });
    expect(writes).not.toContain('not mine');
  });

  it('detaches on unmount so a closed view stops streaming', async () => {
    const { unmount } = render(<TerminalView pid={4821} />);
    await Promise.resolve();
    unmount();
    expect(window.fleet.detach).toHaveBeenCalledWith(4821);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/renderer/TerminalView.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 4: Write minimal implementation**

```tsx
// src/renderer/components/TerminalView.tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

/** The raw half of the toggle. Bytes are written IMPERATIVELY -- a setState
 *  per chunk would re-render the card tree at stream rate, which is the
 *  mistake FleetView's own un-debounced subscription would invite copying. */
export function TerminalView({ pid }: { pid: number }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ scrollback: 5000, fontFamily: 'var(--f-mono)', convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new WebglAddon()); } catch { /* canvas/DOM fallback is fine */ }
    term.open(el);
    fit.fit();

    const api = window.fleet;
    let alive = true;

    // tmux has no attached client, so it never learns our size on its own:
    // without this the window keeps its creation size and output wraps wrong.
    const onResize = term.onResize(({ cols, rows }) => { void api?.resize(pid, cols, rows); });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);

    void api?.attach(pid, term.cols, term.rows).then(r => {
      const res = r as { status: string; backlog?: string };
      if (alive && res.backlog) term.write(res.backlog);
    });

    const unsub = api?.onTerminalData(p => {
      const d = p as { pid: number; data: string };
      if (alive && d.pid === pid) term.write(d.data);
    });

    const onData = term.onData(text => { void api?.sendRaw(pid, text); });

    return () => {
      alive = false;
      unsub?.();
      onData.dispose();
      onResize.dispose();
      ro.disconnect();
      void api?.detach(pid);
      term.dispose();
    };
  }, [pid]);

  return <div className="term" ref={host} />;
}
```

```css
/* src/renderer/components/TerminalView.css */
.term { flex:1; min-height:0; background:var(--ground); padding:6px 8px; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/renderer/TerminalView.test.tsx && npm run typecheck`
Expected: PASS, 3 tests.

- [ ] **Step 6: Mutation-test the suite**

1. Drop the `d.pid === pid` check → the cross-session test must fail.
2. Remove `api?.detach(pid)` from the cleanup → the unmount test must fail.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/renderer/components/TerminalView.tsx src/renderer/components/TerminalView.css tests/renderer/TerminalView.test.tsx
git commit -m "feat(terminal): xterm driven imperatively, sized by resize-window"
```

---

### Task 11: Reply popover

Standalone and keyed by session id, because the Game view opens this same component from a farmer (spec §14).

**Files:**
- Create: `src/renderer/components/ReplyPopover.tsx`, `.css`
- Test: `tests/renderer/ReplyPopover.test.tsx`

**Interfaces:**
- Consumes: Task 6 (`window.fleet.sendKeys`, `KeysResult`).
- Produces: `<ReplyPopover pid prompt onClose />`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/renderer/ReplyPopover.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReplyPopover } from '../../src/renderer/components/ReplyPopover.tsx';

let sendKeys: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sendKeys = vi.fn(async () => ({ status: 'sent' }));
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = { sendKeys };
});

describe('ReplyPopover', () => {
  it('sends what was typed, to the pid it was opened for', async () => {
    render(<ReplyPopover pid={4821} prompt="Overwrite farm.mjs?" onClose={() => {}} />);
    await userEvent.type(screen.getByRole('textbox'), 'yes');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(sendKeys).toHaveBeenCalledWith(4821, 'yes');
  });

  it('explains a refusal instead of failing silently', async () => {
    sendKeys.mockResolvedValue({ status: 'refused', reason: 'not_tmux' });
    render(<ReplyPopover pid={4821} prompt="x" onClose={() => {}} />);
    await userEvent.type(screen.getByRole('textbox'), 'yes');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/not running inside tmux/i)).toBeTruthy());
  });

  it('closes on escape', async () => {
    const onClose = vi.fn();
    render(<ReplyPopover pid={4821} prompt="x" onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('will not send an empty reply', async () => {
    render(<ReplyPopover pid={4821} prompt="x" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(sendKeys).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/ReplyPopover.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/renderer/components/ReplyPopover.tsx
import { useEffect, useState } from 'react';
import type { KeysResult, KeysRefusalReason } from '../../main/ipc.ts';
import './ReplyPopover.css';

/** Keyed by pid and nothing else, so a rail card and a game-view farmer can
 *  both open it (spec section 14). Never owned by the rail. */
const REFUSAL_TEXT: Record<KeysRefusalReason, string> = {
  not_tmux: 'This session is not running inside tmux, so it cannot be typed into. Reattach it to reply.',
  session_gone: 'That session has ended.',
  invalid_pid: 'Could not reach that session.',
  empty: 'Nothing to send.',
  too_long: 'That reply is too long to send as keystrokes.',
  contains_newline: 'Send one line at a time — a line break would submit early.',
};

export function ReplyPopover({ pid, prompt, onClose }: {
  pid: number; prompt: string | null; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send(): Promise<void> {
    if (text.trim() === '') return;
    setMessage(null);
    const r = (await window.fleet?.sendKeys(pid, text)) as KeysResult | undefined;
    if (r?.status === 'sent') { setText(''); onClose(); return; }
    setMessage(r ? REFUSAL_TEXT[r.reason] : 'Could not reach the app.');
  }

  return (
    <div className="replypop" role="dialog" aria-label={`Reply to session ${pid}`}>
      {prompt && <p className="replyprompt">{prompt}</p>}
      <input className="replyinput" type="text" value={text} aria-label="Reply"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void send(); }} />
      <button type="button" className="replysend" onClick={() => void send()}>Send</button>
      {message && <p className="replymsg">{message}</p>}
    </div>
  );
}
```

```css
/* src/renderer/components/ReplyPopover.css */
.replypop { position:absolute; z-index:20; width:220px; padding:8px;
  background:var(--raised); border:1px solid var(--accent);
  border-radius:var(--r-sm); box-shadow:0 8px 20px #0009; }
.replyprompt { margin:0 0 6px; font-size:11px; color:var(--muted); }
.replyinput { width:100%; box-sizing:border-box; background:var(--ground);
  border:1px solid var(--line); border-radius:5px; padding:4px 7px;
  color:var(--ink); font-family:var(--f-mono); font-size:11px; }
.replysend { margin-top:6px; background:var(--accent); color:var(--ground);
  border:0; border-radius:5px; padding:4px 10px; font-size:11px; font-weight:600; }
.replymsg { margin:6px 0 0; font-size:11px; color:var(--signal); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/ReplyPopover.test.tsx && npm run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-test the suite**

1. Ignore the refusal and always close → the refusal test must fail.
2. Drop the `text.trim() === ''` guard → the empty test must fail.
3. Remove the Escape listener → the escape test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ReplyPopover.tsx src/renderer/components/ReplyPopover.css tests/renderer/ReplyPopover.test.tsx
git commit -m "feat(reply): answer one session without leaving the one you are in"
```

---

### Task 12: Main pane and layout

**Files:**
- Create: `src/renderer/components/MainPane.tsx`, `.css`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/MainPane.test.tsx`

**Interfaces:**
- Consumes: Tasks 7-11.
- Produces: `<MainPane selection sessions onSelect onSetView onClear railSide />`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/renderer/MainPane.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MainPane } from '../../src/renderer/components/MainPane.tsx';

const sessions = [{ pid: 1, project: 'llm-workspace', provider: 'claude', activity: 'working', lastProse: 'x', cwd: '/a', host: 'iterm2', ageSeconds: 1, rssBytes: 1, events: 1, sessionId: 's1' }] as never[];

describe('MainPane', () => {
  it('shows the full grid and no rail when nothing is selected', () => {
    const { container } = render(<MainPane selection={null} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    expect(container.querySelector('.rail')).toBeNull();
    expect(container.querySelector('.fleet')).toBeTruthy();
  });

  it('shows the rail and hides the grid once a session is selected', () => {
    const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    expect(container.querySelector('.rail')).toBeTruthy();
    expect(container.querySelector('.fleet')).toBeNull();
  });

  it('offers the toggle and reports the switch', async () => {
    const onSetView = vi.fn();
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={onSetView} onClear={() => {}} railSide="left" />);
    await userEvent.click(screen.getByRole('button', { name: /terminal/i }));
    expect(onSetView).toHaveBeenCalledWith('terminal');
  });

  it('puts the rail on the chosen side', () => {
    const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="right" />);
    expect(container.querySelector('.rail.right')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/MainPane.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/renderer/components/MainPane.tsx
import type { OpenSession } from '../../fleet/state.ts';
import type { PaneView, Selection } from '../state/useFleet.ts';
import { FleetView } from './FleetView.tsx';
import { SessionRail } from './SessionRail.tsx';
import { ConversationView } from './ConversationView.tsx';
import { TerminalView } from './TerminalView.tsx';
import './MainPane.css';

/** The pluggable pane. Fleet and the session views today; Graph (Phase 4) and
 *  Game (spec section 14) are additional cases here, not rewrites -- which is
 *  why the grid is one branch rather than the frame everything hangs off. */
export function MainPane({ selection, sessions, onSelect, onSetView, onClear, railSide }: {
  selection: Selection;
  sessions: OpenSession[];
  onSelect: (pid: number) => void;
  onSetView: (v: PaneView) => void;
  onClear: () => void;
  railSide: 'left' | 'right';
}) {
  if (selection === null) {
    return <div className="mainpane"><FleetView sessions={sessions} onSelect={onSelect} /></div>;
  }

  const session = sessions.find(s => s.pid === selection.pid) ?? null;

  return (
    <div className="mainpane split">
      <SessionRail sessions={sessions} selectedPid={selection.pid} onSelect={onSelect} side={railSide} />
      <section className="pane">
        <header className="panehead">
          <button type="button" className="paneback" onClick={onClear}>All sessions</button>
          <span className="panetitle">{session?.project ?? 'session'}</span>
          <span className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={selection.view === 'conversation'}
              onClick={() => onSetView('conversation')}>Conversation</button>
            <button type="button" aria-pressed={selection.view === 'terminal'}
              onClick={() => onSetView('terminal')}>Terminal</button>
          </span>
        </header>
        {selection.view === 'terminal'
          ? <TerminalView pid={selection.pid} />
          : <ConversationView sessionId={session?.sessionId ?? ''} />}
      </section>
    </div>
  );
}
```

```css
/* src/renderer/components/MainPane.css */
.mainpane { display:flex; flex-direction:column; flex:1; min-height:0; }
.mainpane.split { flex-direction:row; }
.pane { display:flex; flex-direction:column; flex:1; min-width:0; order:1; }
.panehead { display:flex; gap:10px; align-items:center; padding:7px 12px;
  border-bottom:1px solid var(--line); background:var(--surface); }
.panetitle { font-family:var(--f-display); font-size:14px; }
.paneback { background:none; border:0; color:var(--muted); font-size:11px; cursor:pointer; }
.seg { margin-left:auto; display:inline-flex; border:1px solid var(--line);
  border-radius:6px; overflow:hidden; }
.seg button { background:none; border:0; color:var(--muted); font-size:11px;
  padding:3px 9px; cursor:pointer; }
.seg button[aria-pressed="true"] { background:var(--raised); color:var(--ink); }
```

Then wire `App.tsx` to `useFleet()` and render `<MainPane>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderer/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation-test the suite**

1. Always render the rail → the nothing-selected test must fail.
2. Hard-code `side="left"` → the side test must fail.
3. Call `onSetView('conversation')` from both buttons → the toggle test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/MainPane.tsx src/renderer/components/MainPane.css src/renderer/App.tsx tests/renderer/MainPane.test.tsx
git commit -m "feat(layout): grid becomes a rail, main area becomes the session"
```

---

### Task 13: Launch and reattach

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/types.d.ts`
- Create: `src/renderer/components/LaunchBar.tsx`
- Test: `tests/main/launch.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3.
- Produces:
  - `type LaunchResult = { status: 'launched'; pid: number } | { status: 'failed'; reason: string }`
  - `launchSession(provider, cwd, cols, rows, deps?): LaunchResult`
  - `reattachSession(pid, deps?): LaunchResult`

- [ ] **Step 1: Write the failing test**

```ts
// tests/main/launch.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { launchSession } from '../../src/main/launch.ts';
import { clearRegistry, tmuxNameForPid } from '../../src/main/sessions.ts';

beforeEach(() => clearRegistry());

describe('launchSession', () => {
  it('names the session so it is findable in tmux ls, and registers the pid', () => {
    const calls: string[][] = [];
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 4821,
    });
    expect(r).toEqual({ status: 'launched', pid: 4821 });
    const name = tmuxNameForPid(4821)!;
    expect(name).toMatch(/^llmws-claude-[A-Za-z0-9_-]+$/);
    expect(calls[0]).toContain('new-session');
  });

  it('passes the size at creation, since tmux never learns it otherwise', () => {
    const calls: string[][] = [];
    launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 1,
    });
    expect(calls[0]).toContain('-x'); expect(calls[0]).toContain('120');
    expect(calls[0]).toContain('-y'); expect(calls[0]).toContain('40');
  });

  it('never sends a key after launching -- a blind Enter picks "No, exit"', () => {
    const calls: string[][] = [];
    launchSession('claude', '/tmp/proj', 120, 40, {
      exec: (a: string[]) => { calls.push(a); return { ok: true, stdout: '' }; },
      panePid: () => 1,
    });
    expect(calls.some(c => c.includes('send-keys'))).toBe(false);
  });

  it('reports failure rather than registering a session that never started', () => {
    const r = launchSession('claude', '/tmp/proj', 120, 40, {
      exec: () => ({ ok: false, error: 'tmux: no server' }),
      panePid: () => null,
    });
    expect(r.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/launch.test.ts`
Expected: FAIL — cannot resolve `../../src/main/launch.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/launch.ts
import { randomUUID } from 'node:crypto';
import { newSession, panePid as tmuxPanePid, type TmuxExec } from './tmux.ts';
import { registerSession } from './sessions.ts';

export type Provider = 'claude' | 'codex';
export type LaunchResult = { status: 'launched'; pid: number } | { status: 'failed'; reason: string };

type LaunchDeps = { exec?: TmuxExec; panePid?: (name: string) => number | null };

/** Nothing spawns on its own: this is only ever reached from an explicit
 *  choice of provider and directory.
 *
 *  No key is sent after launching. Claude Code opens on a trust prompt with
 *  "No, exit" selected by default -- during the phase-6 probe a single Enter
 *  chose it and killed the session. The card surfaces the prompt; the person
 *  answers it. */
export function launchSession(
  provider: Provider, cwd: string, cols: number, rows: number, deps: LaunchDeps = {},
): LaunchResult {
  const name = `llmws-${provider}-${randomUUID().slice(0, 8)}`;
  const started = newSession(name, cwd, provider, cols, rows, deps.exec);
  if (!started.ok) return { status: 'failed', reason: started.error };

  const lookup = deps.panePid ?? (n => tmuxPanePid(n));
  const pid = lookup(name);
  if (pid === null) return { status: 'failed', reason: 'session started but no pid could be read' };

  registerSession(pid, name);
  return { status: 'launched', pid };
}
```

Add `reattachSession` in the same file: resolve the session id for the pid, call the existing `killSession`, then `launchSession` with `claude --resume <session-id>` as the command. Return `{ status: 'failed' }` if the kill is refused, so the renderer can never leave a session killed but not relaunched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/launch.test.ts && npm run typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-test the suite**

1. Drop `-x`/`-y` from `newSession` → the size test must fail.
2. Add a `sendKeyName(name, 'Enter')` after launch → the blind-Enter test must fail.
3. Register the pid before checking `started.ok` → the failure test must fail.

- [ ] **Step 6: Commit**

```bash
git add src/main/launch.ts src/main/ipc.ts src/preload/index.ts src/renderer/types.d.ts src/renderer/components/LaunchBar.tsx tests/main/launch.test.ts
git commit -m "feat(launch): start a session from the app, and never answer its trust prompt for it"
```

---

### Task 14: Whole-phase verification on the real machine

Tests did not catch a single one of the three wrong models in Phase 3. This task is the one that finds what they miss.

**Files:** none. This is verification.

- [ ] **Step 1: Full suite and typecheck**

```bash
npm test && npm run typecheck
```
Expected: all green. Record the test count.

- [ ] **Step 2: Byte-scan the branch for zero-width and bidi characters**

```bash
git diff main...HEAD | python3 -c "
import sys
d = sys.stdin.read()
bad = {'\u200b':'ZWSP','\u2060':'WJ','\ufeff':'BOM','\u202e':'RLO','\u202d':'LRO'}
hits = [v for k, v in bad.items() if k in d]
print('FAIL:', hits) if hits else print('PASS: clean')"
```
Expected: PASS. Phase 3 shipped a literal U+202E inside the test for the sanitiser that strips it — the defence is the scan, never care.

- [ ] **Step 3: Launch a real session and answer its trust prompt from the app**

Kill the Electron process (not the dev server), then `npm run dev`. Launch a session in a scratch directory. Confirm:
- the card appears in the fleet without special-casing, via ordinary discovery;
- the terminal view shows the trust prompt;
- the app did **not** answer it;
- answering from the app works.

- [ ] **Step 4: Flood the terminal and watch the app, not the test**

In the launched session, run something that dumps hard:
```bash
cat /usr/share/dict/words; cat /usr/share/dict/words
```
Confirm the window stays responsive, the rail keeps updating, and scrollback is capped. This is the 30 MB/s path — if anything is going to melt, it melts here.

- [ ] **Step 5: Resize the window while output is streaming**

Drag the window narrower and wider. Confirm the output re-wraps correctly. If it does not, `resize-window` is not being called and the symptom will later look like a rendering bug.

- [ ] **Step 6: Confirm a non-tmux session refuses honestly**

Open one of the twelve existing iTerm sessions. Confirm: Conversation view works, Terminal is unavailable, and the reply popover says it is not running inside tmux rather than silently doing nothing.

- [ ] **Step 7: Reattach one, end to end**

Reattach a real iTerm session. Confirm the conversation survives, the old process is gone, one process remains, and the new one is fully interactive.

- [ ] **Step 8: Confirm the app is still a viewer, not an owner**

Quit the app entirely with a session running. Confirm via `tmux ls` that the session survives. Reopen; confirm it reattaches.

- [ ] **Step 9: Commit the findings**

```bash
git add -A
git commit -m "test(phase 6): verified on the real machine, not fixtures"
```

---

## Self-Review

**Spec coverage.** §1 launch/reply/reattach → Tasks 13, 6, 13. §2 decisions → Tasks 7, 8, 12 (layout, toggle, styles), 13 (no blind Enter). §4 replyable matrix → Task 6's refusal reasons. §5 no AppleScript → nothing extends `selectTerminalSession`; asserted by absence in Task 14 step 6. §6 architecture → Task 3. §7 IPC → Task 6. §8 sanitisation → Task 2, and the terminal path never touches `sanitizeForDisplay` (Tasks 5, 10). §9 send-keys hardening → Tasks 1, 6. §10 rendering → Tasks 5, 10. §11 conversation → Tasks 4, 9. §12 launch/reattach → Task 13. §13 testing → mutation steps throughout, Task 14. §14 game view constraints → Task 7 (peer state) and Task 11 (standalone popover).

**Two gaps found and fixed inline:** `resize` and `sendRaw` are called by `TerminalView` (Task 10) but were missing from Task 6's channel list — both added, along with `attach`/`detach`/`launch`/`reattach`, so Task 10 is buildable from Task 6's output alone. And `capture-pane`-before-send (spec §9) had no step — added as Task 6 Step 3b with its own test.

**Deliberate deviation from the spec, recorded not hidden:** the spec lists seven channels; this plan needs **nine**. The two additions are `session:resize` (spec §10 requires `resize-window` on every fit change, which needs a channel to carry it) and `session:raw`.

`session:raw` deserves its reasoning stated, because it looks like a hole in §8's outbound rule and is not. The reply popover refuses control bytes: a typed reply containing ESC or Ctrl-C is a mistake or an attack. A focused terminal is the opposite — arrow keys, Ctrl-C and TUI navigation are the entire point, and are how the trust prompt gets answered. So the two paths keep different rules, and `session:raw` is reachable only from a focused `TerminalView`, never from the popover. Update spec §7 and §8 to record this split when the plan is executed.
