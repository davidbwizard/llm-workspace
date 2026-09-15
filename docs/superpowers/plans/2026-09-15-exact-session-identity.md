# Exact Session Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve each live Claude process to its exact session by reading `~/.claude/sessions/<pid>.json`. This fixes Reattach and the Conversation view for sessions that share a folder, and gives a real "waiting on you" status.

**Architecture:**
- A new read-only module (`src/providers/claude/liveSession.ts`) reads and validates one pid's file.
- Discovery attaches the result to `LiveProcess.liveSession`, but only when the file's start time matches the process's.
- The two open-session builders let an exact match win over cwd matching. Everything else falls back to today's heuristics unchanged.
- Reattach re-reads the file right before acting.

**Tech Stack:** TypeScript, Node `fs`, Electron main process, better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-exact-session-identity-design.md`

## Global Constraints

- **Read-only.** Never write under `~/.claude`. Read only `<dir>/<pid>.json` for pids discovery already found. Never list the directory. Never open the `.key` files.
- **File size cap:** 64 KB (`64 * 1024` bytes). Larger files are rejected.
- **Session id pattern:** `/^[A-Za-z0-9_-]{1,128}$/` (the existing `SESSION_ID_SAFE`).
- **Start-time tolerance:** 5000 ms, `|startedAt - (now - ageSeconds * 1000)| <= 5000`. `ageSeconds` null means reject.
- **Renderer safety.** Nothing under `src/renderer/**` may import `liveSession.ts` or `discovery/live.ts` for a value (both import `node:*`). Type-only imports are fine.
- **Dependencies:** none added.
- **Code style:** no emojis in code, comments, or commit messages. Match the surrounding doc-comment style: explain why, not what.
- **Scope:** never touch `game-viewer/`. Commit only the files each task names.
- **Tests:**
  - Run with `npx vitest run <file>`.
  - `npm test` runs a `pretest` step that rebuilds `better-sqlite3` for Node, and `npm run dev` rebuilds it for Electron. Don't run the full suite while the dev app is running.
  - `tests/fleet/state.test.ts` sometimes crashes its worker (a known Node 24 / better-sqlite3 GC bug). A short count with "Worker exited unexpectedly" means rerun, not failure.
- **Measured facts** (2026-09-15, Claude Code 2.1.272), which settle spec §7:
  - `startedAt` does NOT change on `/clear`; `sessionId` does.
  - `status` is `waiting` during a permission prompt as well as a question.
  - `claude -p` also writes a file, with `entrypoint: "sdk-cli"` and `status: null` at first.

---

## File Map

| File | Change | Responsibility |
|---|---|---|
| `src/core/identity.ts` | modify | Export `SESSION_ID_SAFE` (moved from launch.ts) |
| `src/main/launch.ts` | modify | Import `SESSION_ID_SAFE` instead of defining it |
| `src/config.ts` | modify | `Paths.claudeLiveSessions` |
| `src/providers/claude/liveSession.ts` | create | Parse, read, and start-time-check one session file |
| `src/discovery/parse.ts` | modify | `LiveProcess.liveSession?` |
| `src/discovery/live.ts` | modify | Attach verified file during discovery; warn once; export `readLiveSession` |
| `src/discovery/match.ts` | modify | `applyExactMatches` |
| `src/fleet/state.ts` | modify | Use exact matches in both builders; `liveStatus` in activity |
| `src/main/ipc.ts` | modify | `resolveReattachTarget` with fresh re-read |
| `tests/providers/claude/liveSession.test.ts` | create | Module tests |
| `tests/discovery/live.test.ts` | modify | Discovery attaches or rejects |
| `tests/discovery/match.test.ts` | modify | `applyExactMatches` |
| `tests/fleet/state.test.ts` | modify | Builders and activity |
| `tests/main/ipc.test.ts` | modify | Reattach target |
| `tests/cli.test.ts` | modify | New path assertion |
| `docs/superpowers/specs/2026-09-15-exact-session-identity-design.md` | modify | Record measured answers to §7 |

---

### Task 1: Read and validate one live session file

**Files:**
- Modify: `src/core/identity.ts` (append)
- Modify: `src/main/launch.ts:81` (remove local `SESSION_ID_SAFE`, import it)
- Modify: `src/config.ts:10-28` (`Paths`, `resolvePaths`)
- Create: `src/providers/claude/liveSession.ts`
- Test: `tests/providers/claude/liveSession.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SESSION_ID_SAFE: RegExp` from `src/core/identity.ts`
  - `Paths.claudeLiveSessions: string`
  - `type LiveSessionStatus = 'idle' | 'busy' | 'waiting'`
  - `type LiveSessionFile = { sessionId: string; cwd: string; startedAtMs: number; status: LiveSessionStatus | null }`
  - `type LiveSessionReadFailure = 'missing' | 'missing_dir' | 'not_regular_file' | 'too_large' | 'invalid' | 'read_error'`
  - `type LiveSessionRead = { ok: true; file: LiveSessionFile } | { ok: false; reason: LiveSessionReadFailure }`
  - `LIVE_SESSION_MAX_BYTES = 65536`, `LIVE_SESSION_START_TOLERANCE_MS = 5000`
  - `parseLiveSessionFile(text: string, pid: number): LiveSessionFile | null`
  - `readLiveSessionFile(pid: number, dir: string): LiveSessionRead`
  - `startTimeAgrees(file: LiveSessionFile, ageSeconds: number | null | undefined, nowMs: number): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/providers/claude/liveSession.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLiveSessionFile, readLiveSessionFile, startTimeAgrees,
  LIVE_SESSION_MAX_BYTES, LIVE_SESSION_START_TOLERANCE_MS,
} from '../../../src/providers/claude/liveSession.ts';

// Shape copied from a real ~/.claude/sessions/<pid>.json (Claude Code
// 2.1.270), with every identifying value replaced.
const REAL_SHAPE = {
  pid: 14041, sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/Users/me/trellome',
  startedAt: 1789408337635, procStart: 'Mon Sep 14 17:52:16 2026', version: '2.1.270',
  peerProtocol: 1, peerFeatures: ['notify_idle'], kind: 'interactive', entrypoint: 'cli',
  pidDomain: 'darwin', tmux: 'llmws-claude-00000000:@0.%0', messagingSocketPath: '/tmp/cc-socks/14041.sock',
  name: 'trellome-35', nameSource: 'derived', nameSince: 1789408337635, status: 'idle',
  updatedAt: 1789410297851, statusUpdatedAt: 1789410297851, bridgeSessionId: 'session_0000',
};
const text = (o: object) => JSON.stringify(o);

describe('parseLiveSessionFile', () => {
  it('reads the fields the app uses from the real shape', () => {
    expect(parseLiveSessionFile(text(REAL_SHAPE), 14041)).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/Users/me/trellome',
      startedAtMs: 1789408337635, status: 'idle',
    });
  });

  it('accepts waiting and busy', () => {
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: 'waiting' }), 14041)?.status).toBe('waiting');
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: 'busy' }), 14041)?.status).toBe('busy');
  });

  it('keeps the file but nulls an unrecognised or missing status', () => {
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: 'thinking' }), 14041)?.status).toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: null }), 14041)?.status).toBeNull();
  });

  it.each([
    ['a different pid', { ...REAL_SHAPE, pid: 999 }],
    ['a session id with shell characters', { ...REAL_SHAPE, sessionId: '$(rm -rf ~)' }],
    ['an empty session id', { ...REAL_SHAPE, sessionId: '' }],
    ['a relative cwd', { ...REAL_SHAPE, cwd: 'repo' }],
    ['a missing startedAt', { ...REAL_SHAPE, startedAt: undefined }],
    ['a non-finite startedAt', { ...REAL_SHAPE, startedAt: 'yesterday' }],
  ])('rejects %s', (_label, o) => {
    expect(parseLiveSessionFile(text(o), 14041)).toBeNull();
  });

  it('rejects non-object JSON and invalid JSON', () => {
    expect(parseLiveSessionFile('[]', 14041)).toBeNull();
    expect(parseLiveSessionFile('null', 14041)).toBeNull();
    expect(parseLiveSessionFile('{not json', 14041)).toBeNull();
  });

  it('rejects text over the size cap', () => {
    const big = text({ ...REAL_SHAPE, name: 'x'.repeat(LIVE_SESSION_MAX_BYTES) });
    expect(parseLiveSessionFile(big, 14041)).toBeNull();
  });
});

describe('readLiveSessionFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'live-session-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads a valid regular file', () => {
    writeFileSync(join(dir, '14041.json'), text(REAL_SHAPE));
    const r = readLiveSessionFile(14041, dir);
    expect(r.ok && r.file.sessionId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('reports missing when the directory exists but the file does not', () => {
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports missing_dir when the directory itself is gone', () => {
    expect(readLiveSessionFile(14041, join(dir, 'nope'))).toEqual({ ok: false, reason: 'missing_dir' });
  });

  it('refuses a symlink, even one pointing at a valid file', () => {
    const real = join(dir, 'elsewhere.json');
    writeFileSync(real, text(REAL_SHAPE));
    symlinkSync(real, join(dir, '14041.json'));
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'not_regular_file' });
  });

  it('refuses a directory in place of the file', () => {
    mkdirSync(join(dir, '14041.json'));
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'not_regular_file' });
  });

  it('refuses a file over the size cap before parsing it', () => {
    writeFileSync(join(dir, '14041.json'), 'x'.repeat(LIVE_SESSION_MAX_BYTES + 1));
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reports invalid for a malformed file', () => {
    writeFileSync(join(dir, '14041.json'), '{not json');
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a pid that is not a positive integer without touching the filesystem', () => {
    expect(readLiveSessionFile(-1, dir)).toEqual({ ok: false, reason: 'invalid' });
    expect(readLiveSessionFile(1.5, dir)).toEqual({ ok: false, reason: 'invalid' });
  });

  // Least privilege (spec §3.1): the module reads exactly <pid>.json and
  // never enumerates the directory, which also holds .key files.
  it('never lists the directory', () => {
    const src = readFileSync('src/providers/claude/liveSession.ts', 'utf8');
    expect(src).not.toMatch(/readdir|opendir/);
  });
});

describe('startTimeAgrees', () => {
  const NOW = 1_789_500_000_000;
  const file = (startedAtMs: number) => ({ sessionId: 's', cwd: '/a', startedAtMs, status: null });

  it('accepts a start within the tolerance', () => {
    expect(startTimeAgrees(file(NOW - 323_000 + 900), 323, NOW)).toBe(true);
    expect(startTimeAgrees(file(NOW - 323_000 - LIVE_SESSION_START_TOLERANCE_MS), 323, NOW)).toBe(true);
  });

  it('rejects a start outside the tolerance (pid reuse)', () => {
    expect(startTimeAgrees(file(NOW - 323_000 - LIVE_SESSION_START_TOLERANCE_MS - 1), 323, NOW)).toBe(false);
  });

  it('rejects when the process age is unknown', () => {
    expect(startTimeAgrees(file(NOW), null, NOW)).toBe(false);
    expect(startTimeAgrees(file(NOW), undefined, NOW)).toBe(false);
  });
});
```

In `tests/cli.test.ts`, inside `it('points at the provider directories the spec names', ...)`, add after the `claudeProjects` line:

```ts
    expect(p.claudeLiveSessions).toBe('/home/me/.claude/sessions');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/providers/claude/liveSession.test.ts tests/cli.test.ts`
Expected: FAIL. liveSession tests fail to import (`Failed to load url ../../../src/providers/claude/liveSession.ts`). cli test fails on `claudeLiveSessions` (`expected undefined to be '/home/me/.claude/sessions'`).

- [ ] **Step 3: Move `SESSION_ID_SAFE` into `src/core/identity.ts`**

Append to `src/core/identity.ts`:

```ts
/** A session id safe to put on a command line. Anchored, and restricted to
 *  characters no shell gives special meaning to, because `claude --resume
 *  <id>` is handed to tmux as one shell string (src/main/launch.ts). Lives
 *  here rather than in launch.ts so the live session file reader
 *  (src/providers/claude/liveSession.ts) can reject an unsafe id at parse
 *  time without importing main-process code. */
export const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;
```

In `src/main/launch.ts`, delete the line `const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;` (keep the doc comment above it, now describing the import) and add to the imports at the top:

```ts
import { SESSION_ID_SAFE } from '../core/identity.ts';
```

- [ ] **Step 4: Add the path**

In `src/config.ts`, add `claudeLiveSessions: string;` to `interface Paths` after `claudeSettings: string;`, and in `resolvePaths` add after the `claudeSettings` line:

```ts
    claudeLiveSessions: join(home, '.claude/sessions'),
```

- [ ] **Step 5: Create `src/providers/claude/liveSession.ts`**

```ts
import { openSync, fstatSync, readFileSync, closeSync, existsSync, constants } from 'node:fs';
import { join } from 'node:path';
import { SESSION_ID_SAFE } from '../../core/identity.ts';

/** Claude Code writes ~/.claude/sessions/<pid>.json for every running
 *  session (interactive and `claude -p` alike) and deletes it on exit.
 *  Undocumented internals: this module treats the file as an accelerator
 *  that can vanish or change shape in any update, never as the only path.
 *  Spec: docs/superpowers/specs/2026-09-15-exact-session-identity-design.md.
 *
 *  Read-only, and deliberately narrow: it opens exactly <dir>/<pid>.json
 *  for a pid discovery already found, and never enumerates the directory,
 *  which also holds .key files. */

export type LiveSessionStatus = 'idle' | 'busy' | 'waiting';

export type LiveSessionFile = {
  sessionId: string;
  cwd: string;
  /** Epoch ms. Stable across `/clear` (measured 2026-09-15), which is what
   *  lets the start-time check and Reattach's fresh re-read trust it. */
  startedAtMs: number;
  /** null when absent (a `claude -p` session starts with null) or a value
   *  this code does not recognise -- an unknown status never rejects the
   *  file, it only falls back to the transcript-based activity rule. */
  status: LiveSessionStatus | null;
};

export type LiveSessionReadFailure =
  | 'missing' | 'missing_dir' | 'not_regular_file' | 'too_large' | 'invalid' | 'read_error';

export type LiveSessionRead =
  | { ok: true; file: LiveSessionFile }
  | { ok: false; reason: LiveSessionReadFailure };

export const LIVE_SESSION_MAX_BYTES = 64 * 1024;

/** `ps -o etime=` reports whole seconds, so a process's derived start can
 *  sit a second or so off the millisecond `startedAt` Claude Code records.
 *  Same 5 s the cwd matcher's START_TOLERANCE_MS uses (src/fleet/state.ts)
 *  for the same reason. */
export const LIVE_SESSION_START_TOLERANCE_MS = 5_000;

const STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'waiting']);

/** Untrusted input: any process running as this user can write the file.
 *  Only `sessionId` ever reaches a command line (via Reattach), so it is
 *  checked against SESSION_ID_SAFE here and again in reattachSession. */
export function parseLiveSessionFile(text: string, pid: number): LiveSessionFile | null {
  if (Buffer.byteLength(text, 'utf8') > LIVE_SESSION_MAX_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.pid !== pid) return null;
  if (typeof r.sessionId !== 'string' || !SESSION_ID_SAFE.test(r.sessionId)) return null;
  if (typeof r.cwd !== 'string' || !r.cwd.startsWith('/')) return null;
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return null;
  const status = typeof r.status === 'string' && STATUSES.has(r.status) ? r.status as LiveSessionStatus : null;
  return { sessionId: r.sessionId, cwd: r.cwd, startedAtMs: r.startedAt, status };
}

/** Opens with O_NOFOLLOW so a symlink is refused at open time rather than
 *  checked and then raced, and O_NONBLOCK so a FIFO planted at the path
 *  cannot hang the discovery sweep. The size cap is checked on the open
 *  descriptor before anything is read. */
export function readLiveSessionFile(pid: number, dir: string): LiveSessionRead {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'invalid' };
  const path = join(dir, `${pid}.json`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: existsSync(dir) ? 'missing' : 'missing_dir' };
    if (code === 'ELOOP') return { ok: false, reason: 'not_regular_file' };
    return { ok: false, reason: 'read_error' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not_regular_file' };
    if (st.size > LIVE_SESSION_MAX_BYTES) return { ok: false, reason: 'too_large' };
    const file = parseLiveSessionFile(readFileSync(fd, 'utf8'), pid);
    return file ? { ok: true, file } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'read_error' };
  } finally {
    closeSync(fd);
  }
}

/** The pid-reuse guard. A leftover file whose pid was later reused by an
 *  unrelated process would carry a start time that does not match that
 *  process, so it is ignored. Unknown process age rejects rather than
 *  trusting the file unchecked. */
export function startTimeAgrees(
  file: LiveSessionFile, ageSeconds: number | null | undefined, nowMs: number,
): boolean {
  if (ageSeconds == null) return false;
  return Math.abs(file.startedAtMs - (nowMs - ageSeconds * 1000)) <= LIVE_SESSION_START_TOLERANCE_MS;
}
```

Note on the directory case: `openSync` on a directory with `O_RDONLY` succeeds on macOS, so `fstatSync(...).isFile()` is what rejects it. On Linux it may throw `EISDIR`, which maps to `read_error`. If the directory test fails on Linux, add `if (code === 'EISDIR') return { ok: false, reason: 'not_regular_file' };`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/providers/claude/liveSession.test.ts tests/cli.test.ts tests/main/launch.test.ts`
Expected: PASS, all tests. `launch.test.ts` confirms the moved `SESSION_ID_SAFE` still rejects `$(rm -rf ~)`.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/core/identity.ts src/main/launch.ts src/config.ts src/providers/claude/liveSession.ts tests/providers/claude/liveSession.test.ts tests/cli.test.ts
git commit -m "feat(identity): read and validate Claude Code's per-pid session file"
```

---

### Task 2: Attach the verified file during discovery

**Files:**
- Modify: `src/discovery/parse.ts:5-28` (`LiveProcess`)
- Modify: `src/discovery/live.ts:22-30` (imports), `:140-159` (`inspectPid`), `:201-212` (`discoverLiveProcesses`), `:249-261` (`refreshLiveProcesses`)
- Test: `tests/discovery/live.test.ts`

**Interfaces:**
- Consumes (Task 1): `readLiveSessionFile`, `startTimeAgrees`, `LiveSessionFile`, `LiveSessionRead`, `Paths.claudeLiveSessions`.
- Produces:
  - `LiveProcess.liveSession?: LiveSessionFile`. The key is present only when valid and verified; it is omitted otherwise, never `null`.
  - `type DiscoveryDeps = { readLiveSession?: (pid: number) => LiveSessionRead; now?: () => number; warn?: (message: string) => void }`
  - `discoverLiveProcesses(exec?: ExecFn, deps?: DiscoveryDeps): Promise<LiveProcess[]>`
  - `refreshLiveProcesses(exec?: ExecFn, deps?: DiscoveryDeps): Promise<LiveProcess[]>`
  - `readLiveSession(pid: number): LiveSessionRead`, the production reader against `~/.claude/sessions`
  - `verifiedLiveSession(pid: number, ageSeconds: number | null | undefined, deps?: DiscoveryDeps): LiveSessionFile | null`
  - `resetLiveSessionWarnings(): void`, for tests

- [ ] **Step 1: Write the failing tests**

In `tests/discovery/live.test.ts`, change the import line to:

```ts
import {
  discoverLiveProcesses, execFileSoft, resetLiveSessionWarnings, type ExecFn,
} from '../../src/discovery/live.ts';
import type { LiveSessionFile, LiveSessionRead } from '../../src/providers/claude/liveSession.ts';
```

Append this `describe` block at the end of the file:

```ts
describe('discoverLiveProcesses: live session file', () => {
  const NOW = 1_789_500_000_000;
  // 05:23 elapsed = 323 s, so the process started at NOW - 323_000.
  const claudeExec = fakeExec({
    'pgrep -x claude': '100\n',
    'ps -o tty= -p 100': 'ttys001\n',
    'lsof -a -p 100 -d cwd -Fn': 'p100\nfcwd\nn/repo/a\n',
    'ps -o etime=,rss= -p 100': '05:23  1234\n',
    'ps -o ppid=,comm= -p 100': '1 claude\n',
  });
  const file = (o: Partial<LiveSessionFile> = {}): LiveSessionFile => ({
    sessionId: 'sess-a', cwd: '/repo/a', startedAtMs: NOW - 323_000 + 700, status: 'waiting', ...o,
  });
  const ok = (f: LiveSessionFile): LiveSessionRead => ({ ok: true, file: f });

  beforeEach(() => resetLiveSessionWarnings());

  it('attaches the file when its start time agrees with the process', async () => {
    const [p] = await discoverLiveProcesses(claudeExec, { readLiveSession: () => ok(file()), now: () => NOW, warn: vi.fn() });
    expect(p!.liveSession).toEqual(file());
  });

  it('ignores the file and warns once when the start time disagrees (pid reuse)', async () => {
    const warn = vi.fn();
    const deps = { readLiveSession: () => ok(file({ startedAtMs: NOW - 900_000 })), now: () => NOW, warn };
    const [p] = await discoverLiveProcesses(claudeExec, deps);
    await discoverLiveProcesses(claudeExec, deps);
    expect(p).not.toHaveProperty('liveSession');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/pid 100.*start time/);
  });

  it('ignores the file when the process age is unknown', async () => {
    const exec: ExecFn = async (bin, args) =>
      (bin === 'ps' && args[1] === 'etime=,rss=') ? '' : claudeExec(bin, args);
    const [p] = await discoverLiveProcesses(exec, { readLiveSession: () => ok(file()), now: () => NOW, warn: vi.fn() });
    expect(p).not.toHaveProperty('liveSession');
  });

  it('treats a missing file as normal: no liveSession, no warning', async () => {
    const warn = vi.fn();
    const [p] = await discoverLiveProcesses(claudeExec, {
      readLiveSession: () => ({ ok: false, reason: 'missing' }), now: () => NOW, warn,
    });
    expect(p).not.toHaveProperty('liveSession');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per pid and reason for a rejected file, naming the reason but not the contents', async () => {
    const warn = vi.fn();
    const deps = { readLiveSession: (): LiveSessionRead => ({ ok: false, reason: 'invalid' }), now: () => NOW, warn };
    await discoverLiveProcesses(claudeExec, deps);
    await discoverLiveProcesses(claudeExec, deps);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/pid 100.*invalid/);
  });

  it('warns once per app run, not per pid, when the sessions directory is missing', async () => {
    const warn = vi.fn();
    const exec = fakeExec({
      'pgrep -x claude': '100\n101\n',
      'ps -o etime=,rss= -p 100': '05:23  1\n', 'ps -o ppid=,comm= -p 100': '1 claude\n',
      'ps -o etime=,rss= -p 101': '05:23  1\n', 'ps -o ppid=,comm= -p 101': '1 claude\n',
    });
    const deps = { readLiveSession: (): LiveSessionRead => ({ ok: false, reason: 'missing_dir' }), now: () => NOW, warn };
    await discoverLiveProcesses(exec, deps);
    await discoverLiveProcesses(exec, deps);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never reads a session file for a Codex process', async () => {
    const readLiveSession = vi.fn((): LiveSessionRead => ({ ok: true, file: file() }));
    const exec = fakeExec({
      'pgrep -x codex': '200\n',
      'ps -o etime=,rss= -p 200': '05:23  1\n',
      'ps -o ppid=,comm= -p 200': '1 codex\n',
    });
    const [p] = await discoverLiveProcesses(exec, { readLiveSession, now: () => NOW, warn: vi.fn() });
    expect(readLiveSession).not.toHaveBeenCalled();
    expect(p).not.toHaveProperty('liveSession');
  });
});
```

Also change the file's first import line to include `beforeEach`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/discovery/live.test.ts`
Expected: FAIL. `resetLiveSessionWarnings` is not exported, so the suite fails to load (`does not provide an export named 'resetLiveSessionWarnings'`).

- [ ] **Step 3: Add the field to `LiveProcess`**

In `src/discovery/parse.ts`, add at the top:

```ts
import type { LiveSessionFile } from '../providers/claude/liveSession.ts';
```

Inside `interface LiveProcess`, after `rssBytes?: number | null;`:

```ts
  /** Exact identity from Claude Code's own ~/.claude/sessions/<pid>.json
   *  (src/providers/claude/liveSession.ts). Present only when the file was
   *  valid AND its start time agreed with this process's; omitted, never
   *  null, otherwise -- so every fixture that predates it, every Codex
   *  process, and every rejected file look identical to before. */
  liveSession?: LiveSessionFile;
```

- [ ] **Step 4: Attach it in discovery**

In `src/discovery/live.ts`, add to the imports:

```ts
import { homedir } from 'node:os';
import { resolvePaths } from '../config.ts';
import {
  readLiveSessionFile, startTimeAgrees, type LiveSessionFile, type LiveSessionRead,
} from '../providers/claude/liveSession.ts';
```

(`parseProcessChainHop` is already imported from `../config.ts`, so merge `resolvePaths` into that existing import line instead of adding a second one.)

Add below `defaultExec`:

```ts
/** Injectable pieces of the live session lookup, so tests never read the
 *  real ~/.claude/sessions and can pin the clock and capture warnings. */
export type DiscoveryDeps = {
  readLiveSession?: (pid: number) => LiveSessionRead;
  now?: () => number;
  warn?: (message: string) => void;
};

/** The production reader. Exported for Reattach's fresh re-read
 *  (src/main/ipc.ts), which must hit the same directory discovery does. */
export function readLiveSession(pid: number): LiveSessionRead {
  return readLiveSessionFile(pid, resolvePaths(homedir()).claudeLiveSessions);
}

/** Spec §3.6: a rejected file is logged once per pid and reason per app
 *  run (so format drift is visible without flooding the console every
 *  5-second sweep), and a missing directory once per app run in total. */
const warnedLiveSession = new Set<string>();
export function resetLiveSessionWarnings(): void {
  warnedLiveSession.clear();
}
function warnOnce(key: string, message: string, warn: (m: string) => void): void {
  if (warnedLiveSession.has(key)) return;
  warnedLiveSession.add(key);
  warn(message);
}

/** The file for `pid`, or null when it is missing, rejected, or fails the
 *  pid-reuse start-time check. Never throws. Never logs file contents. */
export function verifiedLiveSession(
  pid: number, ageSeconds: number | null | undefined, deps: DiscoveryDeps = {},
): LiveSessionFile | null {
  const warn = deps.warn ?? (m => console.warn(m));
  const read = (deps.readLiveSession ?? readLiveSession)(pid);
  if (!read.ok) {
    if (read.reason === 'missing_dir') {
      warnOnce('missing_dir', '[live-session] ~/.claude/sessions not found; falling back to cwd matching', warn);
    } else if (read.reason !== 'missing') {
      warnOnce(`${pid}:${read.reason}`, `[live-session] pid ${pid}: session file ignored (${read.reason})`, warn);
    }
    return null;
  }
  if (ageSeconds == null) {
    warnOnce(`${pid}:no_age`, `[live-session] pid ${pid}: session file ignored (process start time unknown)`, warn);
    return null;
  }
  if (!startTimeAgrees(read.file, ageSeconds, (deps.now ?? Date.now)())) {
    warnOnce(`${pid}:start`, `[live-session] pid ${pid}: session file ignored (start time does not match the process)`, warn);
    return null;
  }
  return read.file;
}
```

Change `inspectPid` to take `deps` and attach the file:

```ts
async function inspectPid(pid: number, provider: Provider, exec: ExecFn, deps: DiscoveryDeps): Promise<InspectedPid> {
  const [ttyOut, cwdOut, statOut, walk] = await Promise.all([
    exec('ps', ['-o', 'tty=', '-p', String(pid)]),
    exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    exec('ps', ['-o', 'etime=,rss=', '-p', String(pid)]),
    walkProcessChain(pid, exec),
  ]);
  const ageSeconds = parseEtime(statOut);
  const liveSession = provider === 'claude' ? verifiedLiveSession(pid, ageSeconds, deps) : null;
  return {
    process: {
      pid,
      provider,
      tty: parseTty(ttyOut),
      cwd: parseLsofCwd(cwdOut),
      host: classifyHost(walk.chain),
      ageSeconds,
      rssBytes: parseRss(statOut),
      ...(liveSession ? { liveSession } : {}),
    },
    ancestorPids: walk.pids.slice(1), // walk.pids[0] is pid itself, not an ancestor
  };
}
```

Thread `deps` through the two exported functions:

```ts
export async function discoverLiveProcesses(exec: ExecFn = defaultExec, deps: DiscoveryDeps = {}): Promise<LiveProcess[]> {
  try {
    const matched = (await Promise.all(PROVIDER_BINS.map(async bin =>
      parsePgrep(await exec('pgrep', ['-x', bin])).map(pid => ({ pid, provider: bin }))))).flat();
    const matchedPids = new Set(matched.map(m => m.pid));

    const inspected = await Promise.all(matched.map(({ pid, provider }) => inspectPid(pid, provider, exec, deps)));
    return filterToSessions(inspected, matchedPids);
  } catch {
    return [];
  }
}
```

```ts
export async function refreshLiveProcesses(exec: ExecFn = defaultExec, deps: DiscoveryDeps = {}): Promise<LiveProcess[]> {
  if (inFlightSweep) return inFlightSweep;
  const sweep = discoverLiveProcesses(exec, deps).then(result => {
```

(The rest of `refreshLiveProcesses` is unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discovery/live.test.ts`
Expected: PASS, all tests. The pre-existing `toEqual` shape tests still pass, because `liveSession` is omitted when there is no verified file; their fake pids have no file under the real `~/.claude/sessions`.

- [ ] **Step 6: Typecheck and check the renderer does not reach the new module**

Run: `npm run typecheck && grep -rn "liveSession.ts\|discovery/live.ts" src/renderer || echo "renderer clean"`
Expected: typecheck exits 0, and the output ends with `renderer clean`.

- [ ] **Step 7: Commit**

```bash
git add src/discovery/parse.ts src/discovery/live.ts tests/discovery/live.test.ts
git commit -m "feat(discovery): attach Claude's live session file, guarded by process start time"
```

---

### Task 3: Exact identity wins in both open-session builders

**Files:**
- Modify: `src/discovery/match.ts` (append `applyExactMatches`)
- Modify: `src/fleet/state.ts:598-617` (`buildOpenSession`), `:670-699` (`openSessions`), `:772-808` (`openSessionsLive` matching and `pidCwdCounts`)
- Test: `tests/discovery/match.test.ts`, `tests/fleet/state.test.ts`

**Interfaces:**
- Consumes (Task 2): `LiveProcess.liveSession?: LiveSessionFile`.
- Produces: `applyExactMatches(procs: LiveProcess[], matches: MatchResult[]): MatchResult[]`, which keeps one result per process in the same order, like `classifyMatch`.

- [ ] **Step 1: Write the failing tests**

In `tests/discovery/match.test.ts`, change the import to:

```ts
import { classifyMatch, applyExactMatches } from '../../src/discovery/match.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';
```

Append:

```ts
describe('applyExactMatches', () => {
  const p = (pid: number, cwd: string, sessionId?: string): LiveProcess => ({
    pid, provider: 'claude', tty: null, cwd, host: 'unknown', ageSeconds: 10, rssBytes: null,
    ...(sessionId ? { liveSession: { sessionId, cwd, startedAtMs: 0, status: null } } : {}),
  });
  const refs = [{ sessionId: 's1', cwd: '/r' }, { sessionId: 's2', cwd: '/r' }];

  it('resolves each process with a live session file to its own session', () => {
    const procs = [p(1, '/r', 's1'), p(2, '/r', 's2')];
    const out = applyExactMatches(procs, classifyMatch(procs, refs));
    expect(out.map(m => [m.pid, m.quality, m.sessionId])).toEqual([[1, 'unique', 's1'], [2, 'unique', 's2']]);
  });

  it('leaves matching untouched when no process has a file', () => {
    const procs = [p(1, '/r'), p(2, '/r')];
    const before = classifyMatch(procs, refs);
    expect(applyExactMatches(procs, before)).toEqual(before);
  });

  it('resolves to a session id the index has never seen', () => {
    const procs = [p(1, '/r', 'brand-new')];
    expect(applyExactMatches(procs, classifyMatch(procs, refs))[0]).toMatchObject({ quality: 'unique', sessionId: 'brand-new' });
  });

  it("removes a claimed id from a neighbour's candidates", () => {
    const procs = [p(1, '/r', 's1'), p(2, '/r')];
    const out = applyExactMatches(procs, classifyMatch(procs, refs));
    expect(out[1]).toMatchObject({ quality: 'unique', sessionId: 's2', candidates: ['s2'] });
  });

  it('keeps a neighbour ambiguous when more than one candidate remains', () => {
    const three = [...refs, { sessionId: 's3', cwd: '/r' }];
    const procs = [p(1, '/r', 's1'), p(2, '/r')];
    expect(applyExactMatches(procs, classifyMatch(procs, three))[1]).toMatchObject({ quality: 'ambiguous', sessionId: null });
  });
});
```

In `tests/fleet/state.test.ts`, inside `describe('openSessionsLive', ...)` after its `proc` helper, add:

```ts
  const live = (sessionId: string, cwd: string, status: 'idle' | 'busy' | 'waiting' | null = null) =>
    ({ liveSession: { sessionId, cwd, startedAtMs: 0, status } });

  describe('exact session identity', () => {
    function twoSessionsOneFolder() {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ sessionId:'s1', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
        ev({ sessionId:'s1', kind:'prose', payload:{ text:'from s1' }, contentHash:'b', subIndex:1 }),
        ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'c' }),
        ev({ sessionId:'s2', kind:'prose', payload:{ text:'from s2' }, contentHash:'d', subIndex:1 }),
      ]);
      return db;
    }

    it('gives two live processes in one folder their own sessions', () => {
      const db = twoSessionsOneFolder();
      const open = openSessionsLive(db, [
        proc({ pid:1, cwd:'/repo/shared', ageSeconds:60, ...live('s1', '/repo/shared') }),
        proc({ pid:2, cwd:'/repo/shared', ageSeconds:60, ...live('s2', '/repo/shared') }),
      ], NOW);
      const byPid = new Map(open.map(o => [o.pid, o]));
      expect(byPid.get(1)).toMatchObject({ match:'unique', sessionId:'s1', lastProse:'from s1' });
      expect(byPid.get(2)).toMatchObject({ match:'unique', sessionId:'s2', lastProse:'from s2' });
    });

    it('stays ambiguous for the same setup without files (fallback pinned)', () => {
      const db = twoSessionsOneFolder();
      const open = openSessionsLive(db, [
        proc({ pid:1, cwd:'/repo/shared', ageSeconds:60 }),
        proc({ pid:2, cwd:'/repo/shared', ageSeconds:60 }),
      ], NOW);
      expect(open.map(o => [o.match, o.sessionId])).toEqual([['ambiguous', null], ['ambiguous', null]]);
    });

    it('resolves the neighbour of an exactly-matched process when one candidate remains', () => {
      const db = twoSessionsOneFolder();
      const open = openSessionsLive(db, [
        proc({ pid:1, cwd:'/repo/shared', ageSeconds:60, ...live('s1', '/repo/shared') }),
        proc({ pid:2, cwd:'/repo/shared', ageSeconds:60 }),
      ], NOW);
      expect(open.find(o => o.pid === 2)).toMatchObject({ match:'unique', sessionId:'s2' });
    });

    it('keeps the exact session id even before the index has any rows for it', () => {
      const db = openDb(':memory:');
      const [o] = openSessionsLive(db, [proc({ pid:1, cwd:'/repo/new', ageSeconds:5, ...live('just-launched', '/repo/new') })], NOW);
      expect(o).toMatchObject({ match:'unique', sessionId:'just-launched', lastProse:null, events:null });
    });
  });
```

In the same file, find `describe('openSessions', ...)`. It is the describe whose `proc` helper is at line 436; confirm with `grep -n "describe('openSessions'" tests/fleet/state.test.ts`. Add inside it:

```ts
  it('uses exact identity from a live session file even with no session list', () => {
    const open = openSessions([], [proc({
      pid:7, cwd:'/repo/x', ageSeconds:5,
      liveSession: { sessionId:'exact-1', cwd:'/repo/x', startedAtMs:0, status:null },
    })]);
    expect(open[0]).toMatchObject({ match:'unique', sessionId:'exact-1' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/discovery/match.test.ts tests/fleet/state.test.ts`
Expected: FAIL. `match.test.ts` fails to load (`does not provide an export named 'applyExactMatches'`). In `state.test.ts`, "gives two live processes in one folder their own sessions" fails with `match: 'ambiguous'`, and "keeps the exact session id..." fails with `sessionId: null`.

- [ ] **Step 3: Add `applyExactMatches`**

Append to `src/discovery/match.ts`:

```ts
/** Exact identity beats cwd matching (spec
 *  2026-09-15-exact-session-identity-design.md §3.3). Runs AFTER
 *  classifyMatch, which stays a pure cwd matcher. A process carrying a
 *  verified live session file resolves to that session outright. Its id is
 *  then removed from every other process's candidates, and those are
 *  re-classified with classifyMatch's own length rule -- so a neighbour
 *  left with one candidate resolves, and one left with several stays
 *  ambiguous rather than guessed. One result per process, same order. */
export function applyExactMatches(procs: LiveProcess[], matches: MatchResult[]): MatchResult[] {
  const claimed = new Set(procs.flatMap(p => p.liveSession ? [p.liveSession.sessionId] : []));
  if (claimed.size === 0) return matches;
  // Annotated so the literal 'unique' is not widened to string.
  return matches.map((m, i): MatchResult => {
    const exact = procs[i]!.liveSession;
    if (exact) return { ...m, quality: 'unique', sessionId: exact.sessionId, candidates: [exact.sessionId] };
    const candidates = m.candidates.filter(id => !claimed.has(id));
    if (candidates.length === m.candidates.length) return m;
    const quality: MatchQuality =
      candidates.length === 1 ? 'unique' : candidates.length > 1 ? 'ambiguous' : 'unknown';
    return { ...m, candidates, quality, sessionId: quality === 'unique' ? candidates[0]! : null };
  });
}
```

- [ ] **Step 4: Use it in both builders**

In `src/fleet/state.ts`, change the match import to:

```ts
import { classifyMatch, applyExactMatches, type MatchQuality, type MatchResult } from '../discovery/match.ts';
```

In `buildOpenSession`, replace the `sessionId` line with:

```ts
    // A unique match with no enrichment yet is an exact live-session match
    // whose transcript has not been ingested (right after launch or /clear).
    // The id is still known and still true; only the enrichment is empty.
    sessionId: enrichment?.sessionId ?? (m.quality === 'unique' ? m.sessionId : null),
```

In `openSessions`, replace `const matches = classifyMatch(processes, refs);` with:

```ts
  const matches = applyExactMatches(processes, classifyMatch(processes, refs));
```

In `openSessionsLive`, replace `const matches = classifyMatch(processes, refs);` with:

```ts
  const matches = applyExactMatches(processes, classifyMatch(processes, refs));
```

In `openSessionsLive`, replace the `pidCwdCounts` loop with:

```ts
  const pidCwdCounts = new Map<string, number>();
  for (const p of processes) {
    // An exactly-resolved process is not competing for this cwd's sessions,
    // so it must not stop the one remaining process there from resolving.
    if (p.cwd !== null && !p.liveSession) pidCwdCounts.set(p.cwd, (pidCwdCounts.get(p.cwd) ?? 0) + 1);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/discovery/match.test.ts tests/fleet/state.test.ts`
Expected: PASS, all tests, including every pre-existing `openSessions`/`openSessionsLive` test. If the worker crashes ("Worker exited unexpectedly"), rerun.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/discovery/match.ts src/fleet/state.ts tests/discovery/match.test.ts tests/fleet/state.test.ts
git commit -m "feat(fleet): exact live-session identity wins over cwd matching"
```

---

### Task 4: "Waiting on you" from the live session status

**Files:**
- Modify: `src/fleet/state.ts:128-158` (`deriveActivity`), `:898-942` (`openSessionsLive` enrichment and final map)
- Test: `tests/fleet/state.test.ts`

**Interfaces:**
- Consumes: `LiveSessionStatus` (Task 1), `LiveProcess.liveSession` (Task 2), exact matches (Task 3).
- Produces: `activityFromLiveStatus(status: LiveSessionStatus | null | undefined): Activity | null`, exported from `src/fleet/state.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/fleet/state.test.ts`, add `activityFromLiveStatus` to the import from `'../../src/fleet/state.ts'`. Inside `describe('openSessionsLive', ...)`, after the Task 3 block, add:

```ts
  describe('activity from the live session status', () => {
    function oneSession(lastKind: 'turn.completed' | 'prose') {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', ts:at(2), payload:{ cwd:'/repo/s' }, contentHash:'a' }),
        ev({ kind:lastKind, ts:at(1), payload: lastKind === 'prose' ? { text:'hi' } : {}, contentHash:'b', subIndex:1 }),
      ]);
      return db;
    }
    const withStatus = (status: 'idle' | 'busy' | 'waiting' | null) =>
      proc({ pid:3, cwd:'/repo/s', ageSeconds:600, ...live('s1', '/repo/s', status) });

    it('waiting means waiting on you, even after a turn boundary', () => {
      expect(openSessionsLive(oneSession('turn.completed'), [withStatus('waiting')], NOW)[0]!.activity).toBe('waiting_input');
    });

    it('busy means working, even after a turn boundary', () => {
      expect(openSessionsLive(oneSession('turn.completed'), [withStatus('busy')], NOW)[0]!.activity).toBe('working');
    });

    it('idle means idle, even mid-turn by the transcript rule', () => {
      expect(openSessionsLive(oneSession('prose'), [withStatus('idle')], NOW)[0]!.activity).toBe('idle');
    });

    it('null status keeps the transcript rule', () => {
      expect(openSessionsLive(oneSession('prose'), [withStatus(null)], NOW)[0]!.activity).toBe('working');
    });

    it('a hook PermissionRequest still wins over the file', () => {
      const db = oneSession('turn.completed');
      db.prepare(`INSERT INTO signal_events
        (event_id, occurred_at, ingested_at, provider, session_id, tool_use_id, kind, payload)
        VALUES (?,?,?,?,?,?,?,?)`).run('e1', at(1), at(1), 'claude', 's1', 't1',
          'PermissionRequest', JSON.stringify({ tool_name:'Bash', tool_input:{ command:'ls' } }));
      expect(openSessionsLive(db, [withStatus('idle')], NOW)[0]!.activity).toBe('waiting_permission');
    });

    it('an exact match with no index rows yet still shows waiting', () => {
      const [o] = openSessionsLive(openDb(':memory:'), [
        proc({ pid:4, cwd:'/repo/new', ageSeconds:5, ...live('fresh', '/repo/new', 'waiting') }),
      ], NOW);
      expect(o!.activity).toBe('waiting_input');
    });

    it('an exact match with no index rows and no status leaves activity unknown', () => {
      const [o] = openSessionsLive(openDb(':memory:'), [
        proc({ pid:4, cwd:'/repo/new', ageSeconds:5, ...live('fresh', '/repo/new', null) }),
      ], NOW);
      expect(o!.activity).toBeNull();
    });
  });
```

Add at the end of the file:

```ts
describe('activityFromLiveStatus', () => {
  it('maps each known status and nothing else', () => {
    expect(activityFromLiveStatus('waiting')).toBe('waiting_input');
    expect(activityFromLiveStatus('busy')).toBe('working');
    expect(activityFromLiveStatus('idle')).toBe('idle');
    expect(activityFromLiveStatus(null)).toBeNull();
    expect(activityFromLiveStatus(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/fleet/state.test.ts`
Expected: FAIL. The import of `activityFromLiveStatus` is undefined, and the status tests fail. For example, "waiting means waiting on you" gets `'idle'`.

- [ ] **Step 3: Add the mapping and use it in `deriveActivity`**

In `src/fleet/state.ts`, add near the top imports:

```ts
import type { LiveSessionStatus } from '../providers/claude/liveSession.ts';
```

Add above `deriveActivity`:

```ts
/** Claude Code's own status for a live session, from its session file.
 *  `waiting` covers both a question and a permission prompt (measured
 *  2026-09-15) and does not say which, so it maps to the generic
 *  waiting_input; a hook blocker, when one exists, still supplies the
 *  specific kind (see deriveActivity). */
export function activityFromLiveStatus(status: LiveSessionStatus | null | undefined): Activity | null {
  switch (status) {
    case 'waiting': return 'waiting_input';
    case 'busy': return 'working';
    case 'idle': return 'idle';
    default: return null;
  }
}
```

Change `deriveActivity`'s options type and first branches:

```ts
function deriveActivity(opts: {
  lastTs: string | null; lastKind: string | null; blocker: Blocker | null;
  hasMatchedProcess: boolean; hasLiveSignal: boolean; now: number;
  /** From the matched process's live session file, when there is one. It
   *  outranks the transcript rule (the process knows its own state) but not
   *  a hook blocker, which also says what kind of prompt is open. */
  liveStatus?: LiveSessionStatus | null;
}): { lifecycle: Lifecycle; activity: Activity } {
  const lastMs = opts.lastTs ? Date.parse(opts.lastTs) : 0;
  const age = opts.now - lastMs;
  const lifecycle: Lifecycle = age <= ACTIVE_MS ? 'active' : 'disconnected';
  const fromStatus = activityFromLiveStatus(opts.liveStatus);
  let activity: Activity;
  if (opts.blocker) {
    activity = opts.blocker.kind === 'PermissionRequest' ? 'waiting_permission' : 'waiting_input';
  } else if (fromStatus !== null) {
    activity = fromStatus;
  } else if (lifecycle === 'active' && !TURN_END_KINDS.has(opts.lastKind ?? '') &&
```

(The rest of `deriveActivity` is unchanged.)

- [ ] **Step 4: Feed the status in `openSessionsLive`**

In `openSessionsLive`, immediately before `const enrichmentById = new Map<...`, add:

```ts
  // One live status per exactly-matched session, from its process's file.
  const liveStatusBySession = new Map(processes.flatMap(p =>
    p.liveSession ? [[p.liveSession.sessionId, p.liveSession.status] as const] : []));
```

Hoist the blockers map out of the `if (uniqueIds.length > 0)` block, so the no-rows path can use it. Replace:

```ts
  if (uniqueIds.length > 0) {
    const hasLiveSignal = processes.length > 0;
    const blockers = new Map<string, Blocker>();
    for (const b of openBlockers(db, undefined, now)) blockers.set(b.sessionId, b);
```

with:

```ts
  const hasLiveSignal = processes.length > 0;
  const blockers = new Map<string, Blocker>();
  if (uniqueIds.length > 0) {
    for (const b of openBlockers(db, undefined, now)) blockers.set(b.sessionId, b);
```

In the `for (const r of rows)` loop, pass the status:

```ts
      const { activity } = deriveActivity({
        lastTs: r.last_ts, lastKind: r.last_kind, blocker, hasMatchedProcess: true, hasLiveSignal, now,
        liveStatus: liveStatusBySession.get(r.session_id) ?? null,
      });
```

Replace the final `return processes.map((p, i) => { ... })` body (before `.sort(`) with:

```ts
  return processes.map((p, i) => {
    const m = resolvedMatches[i]!;
    let enrichment: { sessionId: string; lastProse: string | null; events: number | null; activity: Activity | null } | null =
      m.quality === 'unique' ? enrichmentById.get(m.sessionId!) ?? null : null;
    // An exact match whose transcript has no rows yet: the process's own
    // status (or a hook blocker) is the only activity signal there is.
    // With neither, activity stays unknown rather than defaulting to idle.
    if (!enrichment && m.quality === 'unique' && p.liveSession) {
      const blocker = blockers.get(m.sessionId!) ?? null;
      const activity = (blocker || activityFromLiveStatus(p.liveSession.status) !== null)
        ? deriveActivity({
            lastTs: null, lastKind: null, blocker, hasMatchedProcess: true, hasLiveSignal, now,
            liveStatus: p.liveSession.status,
          }).activity
        : null;
      enrichment = { sessionId: m.sessionId!, lastProse: null, events: null, activity };
    }
    return buildOpenSession(p, m, enrichment, isTmux);
  })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/fleet/state.test.ts tests/main/ipc.test.ts`
Expected: PASS, all tests. `ipc.test.ts` covers `refreshPushEnrichment`, which calls `openSessionsLive`. Rerun if a worker crashes.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/fleet/state.ts tests/fleet/state.test.ts
git commit -m "feat(fleet): derive waiting/working/idle from Claude's live session status"
```

---

### Task 5: Reattach re-reads the file right before acting

**Files:**
- Modify: `src/main/ipc.ts:15-18` (imports), `:234-248` (`resolveSessionForReattach`)
- Test: `tests/main/ipc.test.ts`

**Interfaces:**
- Consumes: `readLiveSession(pid): LiveSessionRead` and `getCachedLiveProcesses()` from `src/discovery/live.ts`; `LiveProcess.liveSession`; `OpenSession`.
- Produces: `resolveReattachTarget(pid: number, deps: { cached: OpenSession[]; processes: LiveProcess[]; read: (pid: number) => LiveSessionRead }): { sessionId: string; provider: Provider; cwd: string } | null`, exported from `src/main/ipc.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/main/ipc.test.ts`, add `resolveReattachTarget` to the import list from `'../../src/main/ipc.ts'`, and add:

```ts
import type { LiveProcess } from '../../src/discovery/parse.ts';
import type { OpenSession } from '../../src/fleet/state.ts';
import type { LiveSessionRead } from '../../src/providers/claude/liveSession.ts';
```

Append:

```ts
describe('resolveReattachTarget', () => {
  const STARTED = 1_789_000_000_000;
  const proc = (o: Partial<LiveProcess> = {}): LiveProcess => ({
    pid: 50, provider: 'claude', tty: null, cwd: '/repo/a', host: 'iterm2', ageSeconds: 60, rssBytes: null,
    liveSession: { sessionId: 'before-clear', cwd: '/repo/a', startedAtMs: STARTED, status: 'idle' }, ...o,
  });
  const cached = [{ pid: 50, provider: 'claude', cwd: '/repo/a', sessionId: 'before-clear' } as OpenSession];
  const fresh = (sessionId: string, startedAtMs = STARTED): LiveSessionRead =>
    ({ ok: true, file: { sessionId, cwd: '/repo/a', startedAtMs, status: 'idle' } });

  it('uses a fresh read when /clear changed the session since the last sweep', () => {
    const r = resolveReattachTarget(50, { cached, processes: [proc()], read: () => fresh('after-clear') });
    expect(r).toEqual({ sessionId: 'after-clear', provider: 'claude', cwd: '/repo/a' });
  });

  it('ignores a fresh read from a different process instance (start time changed)', () => {
    const r = resolveReattachTarget(50, { cached, processes: [proc()], read: () => fresh('someone-else', STARTED + 60_000) });
    expect(r).toEqual({ sessionId: 'before-clear', provider: 'claude', cwd: '/repo/a' });
  });

  it('falls back to the cache when the fresh read fails', () => {
    const r = resolveReattachTarget(50, { cached, processes: [proc()], read: () => ({ ok: false, reason: 'missing' }) });
    expect(r).toEqual({ sessionId: 'before-clear', provider: 'claude', cwd: '/repo/a' });
  });

  it('does not read at all for a process discovery never verified', () => {
    const read = vi.fn((): LiveSessionRead => fresh('x'));
    const { liveSession: _omit, ...unverified } = proc();
    resolveReattachTarget(50, { cached, processes: [unverified], read });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not read for Codex', () => {
    const read = vi.fn((): LiveSessionRead => fresh('x'));
    resolveReattachTarget(50, { cached, processes: [proc({ provider: 'codex' })], read });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns null when nothing identifies the pid', () => {
    expect(resolveReattachTarget(99, { cached, processes: [], read: () => ({ ok: false, reason: 'missing' }) })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/main/ipc.test.ts`
Expected: FAIL. `resolveReattachTarget` is not exported (`resolveReattachTarget is not a function`).

- [ ] **Step 3: Implement**

In `src/main/ipc.ts`, add `readLiveSession` to the existing import from `'../discovery/live.ts'` (the block that already imports `getCachedLiveProcesses, refreshLiveProcesses, execFileSoft, type ExecFn`), and add:

```ts
import type { LiveSessionRead } from '../providers/claude/liveSession.ts';
```

Replace `resolveSessionForReattach` (and keep its doc comment above, appending the paragraph below to it) with:

```ts
 *
 *  Exact identity first (spec 2026-09-15-exact-session-identity-design.md
 *  §3.5): the enriched cache can be up to one sweep old, and a `/clear` in
 *  that window changes the session id. For a Claude process discovery
 *  already verified, the file is re-read now and trusted only if its
 *  startedAt is the one discovery verified -- stable across `/clear`,
 *  different for any other process. Anything else falls back to the cache
 *  exactly as before. */
export function resolveReattachTarget(
  pid: number,
  deps: { cached: OpenSession[]; processes: LiveProcess[]; read: (pid: number) => LiveSessionRead },
): { sessionId: string; provider: Provider; cwd: string } | null {
  const proc = deps.processes.find(p => p.pid === pid);
  if (proc?.provider === 'claude' && proc.liveSession) {
    const fresh = deps.read(pid);
    if (fresh.ok && fresh.file.startedAtMs === proc.liveSession.startedAtMs) {
      return { sessionId: fresh.file.sessionId, provider: 'claude', cwd: fresh.file.cwd };
    }
  }
  const open = deps.cached.find(o => o.pid === pid);
  if (!open || open.sessionId === null || open.cwd === null) return null;
  return { sessionId: open.sessionId, provider: open.provider, cwd: open.cwd };
}

function resolveSessionForReattach(pid: number): { sessionId: string; provider: Provider; cwd: string } | null {
  return resolveReattachTarget(pid, {
    cached: cachedPushOpenSessions, processes: getCachedLiveProcesses(), read: readLiveSession,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/main/ipc.test.ts tests/main/launch.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts tests/main/ipc.test.ts
git commit -m "fix(reattach): re-read the live session file right before acting"
```

---

### Task 6: Record the measurements, run everything, check in the real app

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-exact-session-identity-design.md` (§7)

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces: a verified build and an updated spec.

- [ ] **Step 1: Record the measured answers in the spec**

Replace the body of §7 ("Open items to settle while planning") with:

```markdown
All three were measured on 2026-09-15 (Claude Code 2.1.272) before planning:

1. **`startedAt` does not change on `/clear`.** A throwaway session kept
   `startedAt: 1789484783913` while `sessionId` went from `ac322d5f…` to
   `9e3c4b49…`. The start-time guard uses `startedAt`, and Reattach's fresh
   re-read compares it to the value discovery verified.
2. **`status` is `waiting` during a permission prompt**, the same as during a
   multiple-choice question. §3.4 stands.
3. **`claude -p` writes the file too**, with `entrypoint: "sdk-cli"`,
   `kind: "interactive"`, and `status: null` at first. Such sessions get exact
   identity; their activity uses the transcript rule until a status appears.
```

- [ ] **Step 2: Full suite and typecheck (stop the dev app first)**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0. All test files pass. The count is 829 plus the tests added in Tasks 1 to 5, and none fail. If the count is short with "Worker exited unexpectedly", rerun `npx vitest run tests/fleet/state.test.ts`.

- [ ] **Step 3: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-09-15-exact-session-identity-design.md
git commit -m "docs(spec): record measured answers for exact session identity"
```

- [ ] **Step 4: Restart the app**

Run: `npm run dev` (its `predev` step rebuilds the native module for Electron). Wait for `starting electron app...`.

- [ ] **Step 5: Eyes-on checks with David**

A green suite is permission to look, not proof. Work through each with David watching the window:

1. **Same folder, two sessions.** Launch two Claude sessions from the app in the same real folder, for example `~/Documents/David/llm-workspace`. Send each a different short message. **Expect:** both cards show their own last reply, and each Conversation view shows its own conversation, with no "several recorded sessions" message.
2. **`/clear`.** In one of them, run `/clear`. **Expect:** within about 5 seconds its Conversation view switches to the new, empty conversation.
3. **Waiting.** Ask one to use AskUserQuestion. **Expect:** its card shows waiting on you while the question is open.
4. **Reattach.** Start a Claude session in plain iTerm (not from the app) in the same folder as another live session, then click Reattach in app on its card. **Expect:** it resumes in the app with its own conversation.
5. **Log check.** Read the dev server log for `[live-session]` lines. **Expect:** none for healthy sessions.

Record each result (PASS/FAIL, with what was seen) in the final report. A FAIL goes back to the task that owns it; don't mark the plan done.
