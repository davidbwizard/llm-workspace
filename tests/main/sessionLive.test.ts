import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSession, clearRegistry } from '../../src/main/sessions.ts';
import { clearPromptCache, answerPrompt } from '../../src/main/answer.ts';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { ingestSpool } from '../../src/hooks/spool.ts';
import {
  buildSessionLive, watchSessionFor, notifySessionChanged, pushSessionLive,
  type SessionLivePayload, type WatchDeps, type WatchHandle,
} from '../../src/main/sessionLive.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';
import type { OpenSession } from '../../src/fleet/state.ts';
import type { LiveSessionRead } from '../../src/providers/claude/liveSession.ts';
import { readModeFor } from '../../src/main/mode.ts';

// Same shape tests/main/ipc.test.ts's own `ev` helper uses -- agentId
// defaults to null (a root-thread event), overridden per row for the
// subagent test below.
function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'claude', sessionId: 's1', runId: 'r1', agentId: null,
    ts: '2026-09-10T12:00:00Z', kind: 'prose', payload: {}, nativeId: null,
    sourceFile: '/f', sourceOffset: 0, contentHash: 'h', subIndex: 0,
    parserVersion: 1, ...o,
  } as NormalizedEvent;
}

const STARTED = 1_789_000_000_000;

// Same fixture shape tests/main/ipc.test.ts's own `proc` helpers use.
function proc(o: Partial<LiveProcess> = {}): LiveProcess {
  return {
    pid: 1, provider: 'codex', tty: null, cwd: '/repo', host: 'iterm2',
    ageSeconds: 60, rssBytes: null, ...o,
  };
}

// Same shape tests/main/ipc.test.ts's own insertBlocker uses, parameterised
// by session and occurred_at so each test can place it precisely relative
// to the `now` it passes buildSessionLive.
function insertBlocker(db: ReturnType<typeof openDb>, sessionId: string, occurredAt: string): void {
  db.prepare(`INSERT INTO signal_events
    (event_id, occurred_at, ingested_at, provider, session_id, tool_use_id, kind, payload)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    `${sessionId}-e1`, occurredAt, occurredAt, 'claude', sessionId, 't1',
    'PermissionRequest', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run dist' } }),
  );
}

describe('buildSessionLive', () => {
  it('reports working for a codex session whose last turn has not ended, timed from the prompt', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({
        provider: 'codex', sessionId: 'codex-1', kind: 'prompt.submitted',
        ts: '2026-09-17T10:00:00Z', payload: { text: 'go' }, contentHash: 'a',
      }),
      ev({
        provider: 'codex', sessionId: 'codex-1', kind: 'prose',
        ts: '2026-09-17T10:00:02Z', payload: { text: 'working on it' }, contentHash: 'b', subIndex: 1,
      }),
    ]);
    const processes = [proc({ pid: 4821, provider: 'codex', cwd: '/repo/codex' })];
    const cached = [{ pid: 4821, provider: 'codex', cwd: '/repo/codex', sessionId: 'codex-1' } as OpenSession];

    const p = buildSessionLive(db, 4821, processes, Date.parse('2026-09-17T10:00:30Z'), { cached });
    expect(p?.activity).toBe('working');
    expect(p?.since).toBe(Date.parse('2026-09-17T10:00:00Z'));
  });

  it('reports idle once the turn is completed', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({
        provider: 'codex', sessionId: 'codex-1', kind: 'prompt.submitted',
        ts: '2026-09-17T10:00:00Z', payload: { text: 'go' }, contentHash: 'a',
      }),
      ev({
        provider: 'codex', sessionId: 'codex-1', kind: 'prose',
        ts: '2026-09-17T10:00:02Z', payload: { text: 'done' }, contentHash: 'b', subIndex: 1,
      }),
      ev({
        provider: 'codex', sessionId: 'codex-1', kind: 'turn.completed',
        ts: '2026-09-17T10:00:05Z', payload: { durationMs: 5000, turnId: 't1' }, contentHash: 'c', subIndex: 2,
      }),
    ]);
    const processes = [proc({ pid: 4821, provider: 'codex', cwd: '/repo/codex' })];
    const cached = [{ pid: 4821, provider: 'codex', cwd: '/repo/codex', sessionId: 'codex-1' } as OpenSession];

    const p = buildSessionLive(db, 4821, processes, Date.parse('2026-09-17T10:00:10Z'), { cached });
    expect(p?.activity).toBe('idle');
    expect(p?.since).toBe(null);
  });

  // Task 1 (commit 3effd6d) made an interrupted Codex turn store as
  // turn.completed with `aborted: true` in its payload -- the parser has
  // no separate "turn aborted" event kind, so this must read as an
  // ordinary turn end, exactly like test above, not as still-working.
  it('reports idle for an interrupted codex turn', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({
        provider: 'codex', sessionId: 'codex-1', kind: 'prompt.submitted',
        ts: '2026-09-17T10:00:00Z', payload: { text: 'go' }, contentHash: 'a',
      }),
      ev({
        provider: 'codex', sessionId: 'codex-1', kind: 'turn.completed',
        ts: '2026-09-17T10:00:03Z',
        payload: { durationMs: null, turnId: 't1', aborted: true, reason: 'interrupted' },
        contentHash: 'b', subIndex: 1,
      }),
    ]);
    const processes = [proc({ pid: 4821, provider: 'codex', cwd: '/repo/codex' })];
    const cached = [{ pid: 4821, provider: 'codex', cwd: '/repo/codex', sessionId: 'codex-1' } as OpenSession];

    const p = buildSessionLive(db, 4821, processes, Date.parse('2026-09-17T10:00:10Z'), { cached });
    expect(p?.activity).toBe('idle');
  });

  it('times a busy claude session from statusUpdatedAt, not from the prompt', () => {
    const db = openDb(':memory:');
    // No transcript events at all -- proves `since` comes from the live
    // status file's own statusUpdatedAtMs, not from a prompt row (there
    // isn't one yet -- this is what a fresh launch, or right after
    // /clear, looks like before ingest catches up).
    const processes = [proc({
      pid: 4822, provider: 'claude', cwd: '/repo/claude',
      liveSession: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'busy' },
    })];
    const read = (): LiveSessionRead => ({
      ok: true,
      file: {
        sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'busy',
        statusUpdatedAtMs: Date.parse('2026-09-17T10:00:20Z'),
      },
    });

    const p = buildSessionLive(db, 4822, processes, Date.parse('2026-09-17T10:00:30Z'), { read });
    expect(p).toMatchObject({ activity: 'working', since: Date.parse('2026-09-17T10:00:20Z') });
  });

  it('maps a live waiting status to waiting', () => {
    const db = openDb(':memory:');
    const processes = [proc({
      pid: 4822, provider: 'claude', cwd: '/repo/claude',
      liveSession: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'idle' },
    })];
    const read = (): LiveSessionRead => ({
      ok: true,
      file: {
        sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting',
        statusUpdatedAtMs: Date.parse('2026-09-17T10:00:20Z'),
      },
    });

    const p = buildSessionLive(db, 4822, processes, Date.parse('2026-09-17T10:00:30Z'), { read });
    expect(p?.activity).toBe('waiting');
  });

  // Reachable path (quick-answers design §5.2): a PermissionRequest is
  // keyed by prompt_id, whose resolver (PostToolUse) is not among the
  // installed hook events, so this stale blocker would otherwise never
  // close before SessionEnd or the 24h window -- reading as waiting for the
  // rest of the day even after the process itself went idle. The live
  // status file now wins whenever one is present, so this reads idle.
  it('reports idle for a stale permission blocker once the live status file says idle', () => {
    const db = openDb(':memory:');
    insertBlocker(db, 'claude-1', '2026-09-17T10:00:15Z');
    const processes = [proc({
      pid: 4822, provider: 'claude', cwd: '/repo/claude',
      liveSession: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'idle' },
    })];
    const read = (): LiveSessionRead => ({
      ok: true,
      file: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'idle' },
    });

    const p = buildSessionLive(db, 4822, processes, Date.parse('2026-09-17T10:00:30Z'), { read });
    expect(p?.activity).toBe('idle');
  });

  // Without a status file at all (no liveSession on the matched process),
  // an open blocker is still the only signal buildSessionLive has, so it
  // must keep deciding activity -- the "no status + blocker" branch.
  it('falls back to the blocker when the process has no live status file', () => {
    const db = openDb(':memory:');
    insertBlocker(db, 'codex-1', '2026-09-17T10:00:15Z');
    const processes = [proc({ pid: 4823, provider: 'codex', cwd: '/repo/codex' })];
    const cached = [{ pid: 4823, provider: 'codex', cwd: '/repo/codex', sessionId: 'codex-1' } as OpenSession];

    const p = buildSessionLive(db, 4823, processes, Date.parse('2026-09-17T10:00:30Z'), { cached });
    expect(p?.activity).toBe('waiting');
  });

  // Final review I2/I4: a status file wins over a blocker even when its
  // status string is one this code does not recognise -- the blocker is
  // only consulted with no status file at all, same as the cards.
  it('does not fall back to a blocker when the status file exists but its status is unrecognised', () => {
    const db = openDb(':memory:');
    insertBlocker(db, 'claude-1', '2026-09-17T10:00:15Z');
    const processes = [proc({
      pid: 4822, provider: 'claude', cwd: '/repo/claude',
      liveSession: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: null },
    })];
    const read = (): LiveSessionRead => ({
      ok: true,
      file: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: null },
    });

    const p = buildSessionLive(db, 4822, processes, Date.parse('2026-09-17T10:00:30Z'), { read });
    expect(p?.activity).toBe('idle');
  });

  // Final review I4: the 24 h blocker scan (openBlockers' own query) is not
  // run at all when a status file answers the question.
  it('does not scan for blockers when the live status file is present', () => {
    const db = openDb(':memory:');
    insertBlocker(db, 'claude-1', '2026-09-17T10:00:15Z');
    const processes = [proc({
      pid: 4822, provider: 'claude', cwd: '/repo/claude',
      liveSession: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'idle' },
    })];
    const read = (): LiveSessionRead => ({
      ok: true,
      file: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'idle' },
    });
    const prepare = vi.spyOn(db, 'prepare');

    buildSessionLive(db, 4822, processes, Date.parse('2026-09-17T10:00:30Z'), { read });
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('WHERE occurred_at >= ?'))).toBe(false);
  });

  it('returns a null activity when the pid matches no session', () => {
    const db = openDb(':memory:');
    const processes = [proc({ pid: 9999, provider: 'codex', cwd: '/repo/unmatched' })];

    const p = buildSessionLive(db, 9999, processes);
    expect(p).toMatchObject({ sessionId: null, activity: null, since: null });
  });

  it('returns null for a pid that is not a live process', () => {
    const db = openDb(':memory:');
    expect(buildSessionLive(db, 1234, [])).toBe(null);
  });

  // Pins the deliberate agent_id split this module's query makes: `events`
  // counts every row for the session, subagent thread included (matching
  // fleetState's own unfiltered COUNT(*) -- see buildSessionLive's own
  // comment on why), but `since` times the turn from the ROOT thread's own
  // last prompt only, matching what conversationFor actually shows in the
  // pane (src/store/conversation.ts's own agent_id IS NULL scope). Without
  // that split, this session would time "since" from the subagent's later
  // prompt (10:00:05) instead of the root conversation's own (10:00:00).
  it('counts every event including a subagent thread, but times the turn from the root thread prompt only', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({
        provider: 'codex', sessionId: 'codex-2', agentId: null, kind: 'prompt.submitted',
        ts: '2026-09-17T10:00:00Z', payload: { text: 'go' }, contentHash: 'a',
      }),
      ev({
        provider: 'codex', sessionId: 'codex-2', agentId: 'sub-1', kind: 'prompt.submitted',
        ts: '2026-09-17T10:00:05Z', payload: { text: 'subtask' }, contentHash: 'b', subIndex: 1,
      }),
      ev({
        provider: 'codex', sessionId: 'codex-2', agentId: 'sub-1', kind: 'prose',
        ts: '2026-09-17T10:00:06Z', payload: { text: 'subagent output' }, contentHash: 'c', subIndex: 2,
      }),
    ]);
    const processes = [proc({ pid: 4821, provider: 'codex', cwd: '/repo/codex' })];
    const cached = [{ pid: 4821, provider: 'codex', cwd: '/repo/codex', sessionId: 'codex-2' } as OpenSession];

    const p = buildSessionLive(db, 4821, processes, Date.parse('2026-09-17T10:00:30Z'), { cached });
    expect(p?.events).toBe(3);
    expect(p?.activity).toBe('working');
    expect(p?.since).toBe(Date.parse('2026-09-17T10:00:00Z'));
  });
});

// Quick answers design §5-6: while Claude's status file says waiting, the
// payload carries the open prompt -- content from the hook, choices from
// the screen -- and says whether the app can answer it.
describe('buildSessionLive -- the open prompt', () => {
  const EVENTS = 'tests/fixtures/quick-answers/events';
  const SCREENS = 'tests/fixtures/quick-answers/screens';
  const WAITING_SINCE = Date.parse('2026-09-17T21:40:14Z');
  const NOW = WAITING_SINCE + 5_000;
  const PID = 4822;

  afterEach(() => { clearRegistry(); clearPromptCache(); });

  function insertPrompt(db: ReturnType<typeof openDb>, file: string, eventId = 'pr-1', atMs = WAITING_SINCE): void {
    const payload = readFileSync(join(EVENTS, file), 'utf8');
    const at = new Date(atMs).toISOString();
    db.prepare(`INSERT INTO signal_events
      (event_id, occurred_at, ingested_at, provider, session_id, prompt_id, kind, payload)
      VALUES (?,?,?,?,?,?,?,?)`).run(eventId, at, at, 'claude', 'claude-1', 'p1', 'PermissionRequest', payload);
  }

  const processes = [proc({
    pid: PID, provider: 'claude', cwd: '/repo/claude',
    liveSession: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting' },
  })];
  const readAs = (status: 'waiting' | 'busy' | 'idle') => (): LiveSessionRead => ({
    ok: true,
    file: {
      sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status,
      statusUpdatedAtMs: WAITING_SINCE, waitingFor: status === 'waiting' ? 'permission prompt' : null,
    },
  });
  const captureOf = (name: string) => () => ({ ok: true as const, stdout: readFileSync(join(SCREENS, `${name}.txt`), 'utf8') });

  it('carries the prompt kind and content from the hook event', () => {
    const db = openDb(':memory:');
    insertPrompt(db, '1789706218.842-PermissionRequest-89928.json');
    registerSession(PID, 'llmws-claude-live');

    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('waiting') });
    expect(p?.activity).toBe('waiting');
    expect(p?.prompt).toMatchObject({ id: 'pr-1', kind: 'question', answerable: true, reason: null });
    expect(p?.prompt?.questions?.map(q => q.question)).toEqual(['Which color?', 'Which pets?']);
  });

  it('reads permission choices from the pane of an app tmux session', () => {
    const db = openDb(':memory:');
    insertPrompt(db, '1789706414.213-PermissionRequest-47761.json');
    registerSession(PID, 'llmws-claude-live');

    const p = buildSessionLive(db, PID, processes, NOW, {
      read: readAs('waiting'), answer: { capture: captureOf('50-perm-bash-dialog') },
    });
    expect(p?.prompt).toMatchObject({ kind: 'permission', answerable: true, command: 'touch perm-probe.txt' });
    expect(p?.prompt?.choices?.map(c => c.key)).toEqual(['1', '2', '3']);
  });

  it('is read-only with not_tmux for a session the app did not launch', () => {
    const db = openDb(':memory:');
    insertPrompt(db, '1789706414.213-PermissionRequest-47761.json');
    const capture = vi.fn(captureOf('50-perm-bash-dialog'));

    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('waiting'), answer: { capture } });
    expect(p?.prompt).toMatchObject({
      kind: 'permission', answerable: false, reason: 'not_tmux', command: 'touch perm-probe.txt',
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it('is read-only with screen_unread when the tmux pane does not show the dialog', () => {
    const db = openDb(':memory:');
    insertPrompt(db, '1789706414.213-PermissionRequest-47761.json');
    registerSession(PID, 'llmws-claude-live');

    const p = buildSessionLive(db, PID, processes, NOW, {
      read: readAs('waiting'), answer: { capture: captureOf('51-perm-bash-after-1') },
    });
    expect(p?.prompt).toMatchObject({ kind: 'permission', answerable: false, reason: 'screen_unread' });
  });

  it('carries no prompt when the status file is not waiting', () => {
    const db = openDb(':memory:');
    insertPrompt(db, '1789706218.842-PermissionRequest-89928.json');
    registerSession(PID, 'llmws-claude-live');

    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('idle') });
    expect(p?.prompt).toBeNull();
  });

  // Final review M7: with no statusUpdatedAt there is no waitingSince to
  // match against, so no event can be proven to belong to this wait.
  it('carries no prompt when the waiting status file has no statusUpdatedAt', () => {
    const db = openDb(':memory:');
    insertPrompt(db, '1789706218.842-PermissionRequest-89928.json');
    const read = (): LiveSessionRead => ({
      ok: true,
      file: { sessionId: 'claude-1', cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting' },
    });

    const p = buildSessionLive(db, PID, processes, NOW, { read });
    expect(p).toMatchObject({ activity: 'waiting', prompt: null });
  });

  it('carries no prompt when nothing matches the wait', () => {
    const db = openDb(':memory:');
    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('waiting') });
    expect(p).toMatchObject({ activity: 'waiting', prompt: null });
  });

  // Coordinator ruling (security review, 2026-09-18): parallel tool calls
  // can write two PermissionRequests in one wait while the pane shows one
  // dialog, so the card could show one prompt and answer the other.
  const BASH_YES = '1789706414.213-PermissionRequest-47761.json';
  const BASH_NO = '1789706452.876-PermissionRequest-59737.json';

  it('is read-only with multiple_prompts when two PermissionRequests land in the same wait, without reading the pane', () => {
    const db = openDb(':memory:');
    insertPrompt(db, BASH_NO, 'pr-1');
    insertPrompt(db, BASH_YES, 'pr-2');
    registerSession(PID, 'llmws-claude-live');
    const capture = vi.fn(captureOf('50-perm-bash-dialog'));

    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('waiting'), answer: { capture } });
    expect(p?.prompt).toMatchObject({
      id: 'pr-2', kind: 'permission', answerable: false, reason: 'multiple_prompts', command: 'touch perm-probe.txt',
    });
    expect(p?.prompt?.choices).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it('applies to a question too, which otherwise needs no screen read', () => {
    const db = openDb(':memory:');
    insertPrompt(db, BASH_YES, 'pr-1');
    insertPrompt(db, '1789706218.842-PermissionRequest-89928.json', 'pr-2');
    registerSession(PID, 'llmws-claude-live');

    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('waiting') });
    expect(p?.prompt).toMatchObject({ id: 'pr-2', kind: 'question', answerable: false, reason: 'multiple_prompts' });
  });

  it('does not count an older PermissionRequest from before this wait', () => {
    const db = openDb(':memory:');
    insertPrompt(db, BASH_NO, 'pr-old', WAITING_SINCE - 5_000);
    insertPrompt(db, BASH_YES, 'pr-2');
    registerSession(PID, 'llmws-claude-live');

    const p = buildSessionLive(db, PID, processes, NOW, {
      read: readAs('waiting'), answer: { capture: captureOf('50-perm-bash-dialog') },
    });
    expect(p?.prompt).toMatchObject({ id: 'pr-2', answerable: true, reason: null });
  });

  it('answerPrompt refuses a multiple_prompts prompt before pressing any key', async () => {
    const db = openDb(':memory:');
    insertPrompt(db, BASH_NO, 'pr-1');
    insertPrompt(db, BASH_YES, 'pr-2');
    registerSession(PID, 'llmws-claude-live');
    const send = vi.fn(() => ({ ok: true as const, stdout: '' }));
    const capture = vi.fn((args: string[]) => (args[0] === 'display-message'
      ? { ok: true as const, stdout: '0\n' } : captureOf('50-perm-bash-dialog')()));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await answerPrompt(PID, 'pr-2', { kind: 'choice', key: '1' }, {
      send, capture, has: () => true, sleep: async () => {},
      currentPrompt: pid => buildSessionLive(db, pid, processes, NOW, { read: readAs('waiting'), answer: { capture } })?.prompt ?? null,
    });
    expect(result).toEqual({ status: 'refused', reason: 'unconfirmed' });
    expect(send).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('watchSessionFor / notifySessionChanged / pushSessionLive', () => {
  const CLAUDE_PATH = `${homedir()}/.claude/sessions/4821.json`;

  // A fake fs.watch: records every path it is asked to watch and lets a
  // test fire that path's own registered 'error' or 'change' handler, or
  // close it, without ever touching the real filesystem or leaving a real
  // watcher running past the test.
  function fakeWatch() {
    const errorHandlers = new Map<string, (err: Error) => void>();
    const changeHandlers = new Map<string, () => void>();
    const active = new Set<string>();
    let closedCount = 0;
    const watch = (path: string): WatchHandle => {
      active.add(path);
      return {
        on: ((event: 'error' | 'change', cb: ((err: Error) => void) | (() => void)) => {
          if (event === 'error') errorHandlers.set(path, cb as (err: Error) => void);
          else changeHandlers.set(path, cb as () => void);
        }) as WatchHandle['on'],
        close: () => { active.delete(path); closedCount += 1; },
      };
    };
    return {
      watch,
      watchedPaths: () => [...active],
      closedCount: () => closedCount,
      triggerError: (path: string, err: Error) => errorHandlers.get(path)?.(err),
      triggerChange: (path: string) => changeHandlers.get(path)?.(),
    };
  }

  function makeDeps(o: {
    processes: LiveProcess[];
    buildPayload: () => SessionLivePayload | null;
    fake?: ReturnType<typeof fakeWatch>;
  }): { deps: WatchDeps; sent: SessionLivePayload[]; fake: ReturnType<typeof fakeWatch> } {
    const sent: SessionLivePayload[] = [];
    const fake = o.fake ?? fakeWatch();
    return {
      deps: { processes: () => o.processes, buildPayload: o.buildPayload, send: p => sent.push(p), watch: fake.watch },
      sent,
      fake,
    };
  }

  // Nothing watched, and never touches deps -- watchSessionFor(null, ...)
  // never reaches processes()/buildPayload()/watch(), so this is a safe
  // reset even though none of its fields do anything real.
  const NOOP: WatchDeps = { processes: () => [], buildPayload: () => null, send: () => {} };

  afterEach(() => {
    watchSessionFor(null, NOOP);
    vi.useRealTimers();
  });

  it('refuses a pid absent from the discovery cache, and starts no watch', () => {
    const { deps, sent, fake } = makeDeps({ processes: [], buildPayload: () => null });
    expect(watchSessionFor(999999, deps)).toBe(false);
    expect(fake.watchedPaths()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses anything that is not a positive integer', () => {
    const { deps, fake } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => null,
    });
    for (const bad of [0, -1, 1.5, NaN, '4821' as unknown as number]) {
      expect(watchSessionFor(bad, deps)).toBe(false);
    }
    expect(fake.watchedPaths()).toEqual([]);
  });

  it('an explicit null reports not watching, even with nothing previously watched', () => {
    expect(watchSessionFor(null, NOOP)).toBe(false);
  });

  it('watches the claude live-session file at the validated pid, and pushes once immediately', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent, fake } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload,
    });
    expect(watchSessionFor(4821, deps)).toBe(true);
    expect(fake.watchedPaths()).toEqual([CLAUDE_PATH]);
    expect(sent).toEqual([payload]);
  });

  it('never opens a status-file watch for a non-claude process', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent, fake } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => payload,
    });
    expect(watchSessionFor(4821, deps)).toBe(true);
    expect(fake.watchedPaths()).toEqual([]);
    expect(sent).toEqual([payload]);
  });

  it('closes the previous watcher before starting a new one for a different pid', () => {
    const payload1: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const first = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload1 });
    expect(watchSessionFor(4821, first.deps)).toBe(true);
    expect(first.fake.watchedPaths()).toEqual([CLAUDE_PATH]);

    const payload2: SessionLivePayload = { version: 1, pid: 4822, sessionId: 's2', activity: 'idle', since: null, events: 2, prompt: null, context: null, mode: null };
    const second = makeDeps({ processes: [proc({ pid: 4822, provider: 'claude' })], buildPayload: () => payload2 });
    expect(watchSessionFor(4822, second.deps)).toBe(true);

    expect(first.fake.closedCount()).toBe(1);
    expect(first.fake.watchedPaths()).toEqual([]);
    expect(second.fake.watchedPaths()).toEqual([`${homedir()}/.claude/sessions/4822.json`]);
  });

  // Finding 3 (final review, 2026-09-17): the watcher used to be created
  // before watchState was assigned, and every teardown path (teardownWatch
  // itself, window close, before-quit) reaches the watcher only through
  // watchState -- so a throw between the two left the just-opened handle
  // referenced by nothing, unrecoverable for the life of the process.
  // watchState is now assigned right after the watcher is created, before
  // the call that can throw, so a subsequent teardown still reaches it.
  it('does not orphan the fs.watch handle when buildPayload throws', () => {
    const { deps, fake } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'claude' })],
      buildPayload: () => { throw new Error('database is closed'); },
    });
    expect(() => watchSessionFor(4821, deps)).toThrow('database is closed');
    // The watcher is still open right after the throw...
    expect(fake.watchedPaths()).toEqual([CLAUDE_PATH]);
    expect(fake.closedCount()).toBe(0);

    // ...and reachable through watchState, so an ordinary teardown (an
    // explicit stop, a window close, before-quit -- all reach the watcher
    // this same way) closes it rather than leaking it for good.
    expect(watchSessionFor(null, deps)).toBe(false);
    expect(fake.watchedPaths()).toEqual([]);
    expect(fake.closedCount()).toBe(1);
  });

  it('releases the watcher and timer on an explicit null', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, fake } = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);
    expect(watchSessionFor(null, deps)).toBe(false);
    expect(fake.watchedPaths()).toEqual([]);
    expect(fake.closedCount()).toBe(1);
  });

  it('falls back to the sweep when the watch reports an error, without dropping the watched session', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent, fake } = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.triggerError(CLAUDE_PATH, new Error('boom'));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    // The failed watcher closed itself and is no longer tracked...
    expect(fake.watchedPaths()).toEqual([]);
    expect(fake.closedCount()).toBe(1);

    // ...but the session itself is still the one being watched: a change
    // notification for it still coalesces into a push through the ordinary
    // sweep/notify path, exactly as it would for a Codex session that never
    // had a fs.watch at all.
    sent.length = 0;
    vi.useFakeTimers();
    notifySessionChanged(new Set(['s1']));
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([payload]);
  });

  // Finding 2 (final review, 2026-09-17): the watch was opened but nothing
  // ever subscribed to 'change', so the second of the spec's three triggers
  // (Claude's own status file flipping) delivered nothing -- a status flip
  // with no accompanying transcript write, most visibly Claude entering a
  // question or permission prompt, reached the pane only on the 5s sweep.
  it('pushes on a change to the watched claude status file, coalesced the same as any other trigger', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'waiting', since: null, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent, fake } = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);
    sent.length = 0; // clear the immediate push watchSessionFor itself sent

    vi.useFakeTimers();
    fake.triggerChange(CLAUDE_PATH);
    expect(sent).toEqual([]); // coalesced, not sent synchronously
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([payload]);
  });

  it('coalesces a change on the status file with an ordinary notifySessionChanged in the same window', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'waiting', since: null, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent, fake } = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);
    sent.length = 0;

    vi.useFakeTimers();
    fake.triggerChange(CLAUDE_PATH);
    notifySessionChanged(new Set(['s1']));
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(1);
  });

  // A change on a watcher that startClaudeWatch has already superseded (a
  // fast session switch) must never schedule a push for whatever pid is
  // watched now -- the same guard the 'error' handler already applies.
  it('ignores a change on a watcher that has since been replaced', () => {
    const payload1: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const first = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload1 });
    watchSessionFor(4821, first.deps);

    const payload2: SessionLivePayload = { version: 1, pid: 4822, sessionId: 's2', activity: 'idle', since: null, events: 2, prompt: null, context: null, mode: null };
    const second = makeDeps({ processes: [proc({ pid: 4822, provider: 'claude' })], buildPayload: () => payload2 });
    watchSessionFor(4822, second.deps);
    second.sent.length = 0;

    vi.useFakeTimers();
    first.fake.triggerChange(CLAUDE_PATH); // the now-closed watcher for 4821
    vi.advanceTimersByTime(250);
    expect(second.sent).toEqual([]);
  });

  it('pushes at most one payload per 250ms burst', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent } = makeDeps({ processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);
    sent.length = 0; // clear the immediate push watchSessionFor itself sent

    vi.useFakeTimers();
    notifySessionChanged(new Set(['s1']));
    notifySessionChanged(new Set(['s1']));
    notifySessionChanged(new Set(['s1']));
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(1);
  });

  it('ignores changes to other sessions', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent } = makeDeps({ processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);
    sent.length = 0;

    vi.useFakeTimers();
    notifySessionChanged(new Set(['s2']));
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(0);
  });

  it('releases the watch when pushSessionLive finds the watched pid has left the discovery cache', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    let gone = false;
    const { deps, fake } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'claude' })],
      buildPayload: () => (gone ? null : payload),
    });
    watchSessionFor(4821, deps);
    expect(fake.watchedPaths()).toEqual([CLAUDE_PATH]);

    gone = true;
    pushSessionLive();
    expect(fake.watchedPaths()).toEqual([]);
    expect(fake.closedCount()).toBe(1);
  });

  // Fix round 1 (review of d3d5010): watchSessionFor used to tear down
  // whatever was already watched BEFORE validating the new pid, so a
  // refusal arriving mid-session-switch silently killed the live-push
  // channel for the session that WAS working -- worse than "falls back to
  // the sweep", since pushSessionLive short-circuits on a null watchState
  // forever, not just for one push. Validate first, teardown only on the
  // success path.
  it('leaves an existing good watch running, and still pushing, when a new pid is refused', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => payload,
    });
    watchSessionFor(4821, deps);
    sent.length = 0; // clear the immediate push from watchSessionFor itself

    // Absent from `deps.processes()` above -- an ordinary discovery-cache
    // refusal, the exact case a session switch racing a sweep can produce.
    expect(watchSessionFor(999999, deps)).toBe(false);

    vi.useFakeTimers();
    notifySessionChanged(new Set(['s1']));
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([payload]);
  });

  it('an explicit null still tears down the watch, and no further changes push anything', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1, prompt: null, context: null, mode: null };
    const { deps, sent } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => payload,
    });
    watchSessionFor(4821, deps);
    expect(watchSessionFor(null, deps)).toBe(false);
    sent.length = 0;

    vi.useFakeTimers();
    notifySessionChanged(new Set(['s1']));
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([]);
  });
});

// Final review I1: Claude flips its status file to waiting 15-30 ms BEFORE
// the PermissionRequest hook is written, so the status-file push goes out
// with no prompt. The spool tick that later ingests the event must itself
// push the watched session, or the card waits for the 5 s sweep. Same
// composition as src/main/index.ts's spool tick: ingestSpool collects the
// touched session ids, notifySessionChanged pushes the watched one.
describe('spool ingest pushes the watched session', () => {
  const EVENTS = 'tests/fixtures/quick-answers/events';
  const SESSION = '319735a2-7eb7-445e-a620-bf9ab4fb12a1';
  const PID = 4830;
  // The event's own whole-second stamp is 21:40:14; the status flipped a
  // few ms into that same second, before the event was written.
  const WAITING_SINCE = Date.parse('2026-09-17T21:40:14.300Z');
  const NOW = WAITING_SINCE + 1_000;
  const NOOP: WatchDeps = { processes: () => [], buildPayload: () => null, send: () => {} };
  let spool: string;

  afterEach(() => {
    watchSessionFor(null, NOOP);
    vi.useRealTimers();
    clearPromptCache();
    rmSync(spool, { recursive: true, force: true });
  });

  it('a PermissionRequest ingested after the status is already waiting produces a session:live push carrying the prompt', () => {
    spool = mkdtempSync(join(tmpdir(), 'llmws-spool-'));
    const db = openDb(':memory:');
    const processes = [proc({
      pid: PID, provider: 'claude', cwd: '/repo/claude',
      liveSession: { sessionId: SESSION, cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting' },
    })];
    const read = (): LiveSessionRead => ({
      ok: true,
      file: {
        sessionId: SESSION, cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting',
        statusUpdatedAtMs: WAITING_SINCE, waitingFor: null,
      },
    });
    const sent: SessionLivePayload[] = [];
    const handle: WatchHandle = { on: () => {}, close: () => {} };
    vi.useFakeTimers();

    watchSessionFor(PID, {
      processes: () => processes,
      buildPayload: () => buildSessionLive(db, PID, processes, NOW, { read }),
      send: p => sent.push(p),
      watch: () => handle,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: SESSION, activity: 'waiting', prompt: null });

    const payload = JSON.parse(readFileSync(join(EVENTS, '1789706218.842-PermissionRequest-89928.json'), 'utf8'));
    writeFileSync(join(spool, 'pr-1.json'), JSON.stringify({
      event_id: 'pr-1', occurred_at: '2026-09-17T21:40:14.000Z', ppid: 1, payload,
    }));
    const touched = new Set<string>();
    expect(ingestSpool(db, spool, 'claude', touched)).toBe(1);
    expect([...touched]).toEqual([SESSION]);
    notifySessionChanged(touched);
    vi.advanceTimersByTime(250);

    expect(sent).toHaveLength(2);
    expect(sent[1]?.prompt).toMatchObject({ id: 'pr-1', kind: 'question' });
  });
});

// Hardening: the `ingestSpool` dependency itself (the shape wired in
// src/main/ipc.ts's session:watch handler) must call notifySessionChanged
// with the ids IT touched, the same way index.ts's 1 s spool tick already
// does -- not leave that to the caller, as the test above does by hand. A
// pane read that ran before the terminal had actually drawn the dialog (the
// push at PID2's first `pushSessionLive()` call below, with the event
// spooled but not yet ingested) must still get a follow-up push once the
// ingest lands, and that follow-up must not itself trigger another: the
// spooled file is deleted as it is read, so the follow-up's own ingest
// finds 0 files and calls notifySessionChanged for nobody.
describe('the ingestSpool dependency calls notifySessionChanged with the ids it touched', () => {
  const EVENTS = 'tests/fixtures/quick-answers/events';
  const SESSION = '319735a2-7eb7-445e-a620-bf9ab4fb12a1';
  const PID = 4833;
  const WAITING_SINCE = Date.parse('2026-09-17T21:40:14.300Z');
  const NOW = WAITING_SINCE + 1_000;
  const NOOP: WatchDeps = { processes: () => [], buildPayload: () => null, send: () => {} };
  let spool: string;

  afterEach(() => {
    watchSessionFor(null, NOOP);
    vi.useRealTimers();
    clearPromptCache();
    rmSync(spool, { recursive: true, force: true });
  });

  it('pushes a follow-up after the on-demand ingest, then stops once the spool is empty', () => {
    spool = mkdtempSync(join(tmpdir(), 'llmws-spool-'));
    const db = openDb(':memory:');
    const processes = [proc({
      pid: PID, provider: 'claude', cwd: '/repo/claude',
      liveSession: { sessionId: SESSION, cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting' },
    })];
    const read = (): LiveSessionRead => ({
      ok: true,
      file: {
        sessionId: SESSION, cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting',
        statusUpdatedAtMs: WAITING_SINCE, waitingFor: null,
      },
    });
    const sent: SessionLivePayload[] = [];
    const handle: WatchHandle = { on: () => {}, close: () => {} };
    const ingestCalls: number[] = [];
    // Exactly src/main/ipc.ts's session:watch shape: a fresh Set every call,
    // notifySessionChanged only when something was actually ingested.
    const ingestSpoolDep = () => {
      const touched = new Set<string>();
      const written = ingestSpool(db, spool, 'claude', touched);
      ingestCalls.push(written);
      if (written > 0) notifySessionChanged(touched);
    };
    vi.useFakeTimers();

    // Watch starts with the spool still empty -- no event ingested yet, so
    // no prompt, but this is what sets watchState.sessionId to SESSION
    // (notifySessionChanged is a no-op before that, by construction: see
    // its own doc comment). Mirrors the status-file push landing just
    // before the PermissionRequest is spooled.
    watchSessionFor(PID, {
      processes: () => processes,
      buildPayload: () => buildSessionLive(db, PID, processes, NOW, { read, ingestSpool: ingestSpoolDep }),
      send: p => sent.push(p),
      watch: () => handle,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: SESSION, prompt: null });

    // The PermissionRequest lands in the spool, then some other trigger
    // (the coalesced watcher/tick pushes this fixes -- pushSessionLive
    // itself, here standing in for one) causes the next push.
    const payload = JSON.parse(readFileSync(join(EVENTS, '1789706218.842-PermissionRequest-89928.json'), 'utf8'));
    writeFileSync(join(spool, 'pr-1.json'), JSON.stringify({
      event_id: 'pr-1', occurred_at: '2026-09-17T21:40:14.000Z', ppid: 1, payload,
    }));
    pushSessionLive();

    // This push already carries the prompt (ingest runs before the
    // promptEvent lookup), and its own ingest scheduled a follow-up because
    // watchState.sessionId is set by now.
    expect(sent).toHaveLength(2);
    expect(sent[1]?.prompt).toMatchObject({ id: 'pr-1', kind: 'question' });

    vi.advanceTimersByTime(250);
    // The follow-up push: proves a pane read that missed the dialog on the
    // push above still gets a second look.
    expect(sent).toHaveLength(3);
    expect(sent[2]?.prompt).toMatchObject({ id: 'pr-1', kind: 'question' });

    vi.advanceTimersByTime(250);
    // No third follow-up: the file was deleted on the first ingest, so this
    // ingest touched nothing and scheduled nothing further -- it does not loop.
    expect(sent).toHaveLength(3);
    expect(ingestCalls).toEqual([0, 1, 0]);
  });
});

// Task 6 (by eye): the fallback card flashed before the prompt card. The
// status-file push fires ~250 ms after the flip to waiting, while the
// PermissionRequest lands in the spool ~20 ms after it -- so a push for a
// waiting session ingests the spool first (the `ingestSpool` dependency,
// wired to the real spool in src/main/ipc.ts's session:watch) and carries
// the prompt at once instead of waiting for the 1 s tick.
describe('buildSessionLive -- ingests the spool before looking up a waiting prompt', () => {
  const EVENTS = 'tests/fixtures/quick-answers/events';
  const SESSION = '319735a2-7eb7-445e-a620-bf9ab4fb12a1';
  const PID = 4831;
  const WAITING_SINCE = Date.parse('2026-09-17T21:40:14.300Z');
  const NOW = WAITING_SINCE + 250;
  const processes = [proc({
    pid: PID, provider: 'claude', cwd: '/repo/claude',
    liveSession: { sessionId: SESSION, cwd: '/repo/claude', startedAtMs: STARTED, status: 'waiting' },
  })];
  const readAs = (status: 'waiting' | 'busy' | 'idle') => (): LiveSessionRead => ({
    ok: true,
    file: {
      sessionId: SESSION, cwd: '/repo/claude', startedAtMs: STARTED, status,
      statusUpdatedAtMs: WAITING_SINCE, waitingFor: null,
    },
  });
  let spool: string | null = null;

  afterEach(() => {
    clearPromptCache();
    vi.restoreAllMocks();
    if (spool) rmSync(spool, { recursive: true, force: true });
    spool = null;
  });

  function spoolWithPrompt(): string {
    spool = mkdtempSync(join(tmpdir(), 'llmws-spool-'));
    const payload = JSON.parse(readFileSync(join(EVENTS, '1789706218.842-PermissionRequest-89928.json'), 'utf8'));
    writeFileSync(join(spool, 'pr-1.json'), JSON.stringify({
      event_id: 'pr-1', occurred_at: '2026-09-17T21:40:14.000Z', ppid: 1, payload,
    }));
    return spool;
  }

  it('a waiting push ingests first, so the prompt written just after the flip is already in the payload', () => {
    const db = openDb(':memory:');
    const dir = spoolWithPrompt();
    const ingest = vi.fn(() => { ingestSpool(db, dir); });

    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('waiting'), ingestSpool: ingest });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({ activity: 'waiting', prompt: { id: 'pr-1', kind: 'question' } });
  });

  it('without the dependency the same push has no prompt yet (the flash this fixes)', () => {
    const db = openDb(':memory:');
    spoolWithPrompt();
    const p = buildSessionLive(db, PID, processes, NOW, { read: readAs('waiting') });
    expect(p).toMatchObject({ activity: 'waiting', prompt: null });
  });

  it.each(['busy', 'idle'] as const)('does not ingest when the live status is %s', (status) => {
    const db = openDb(':memory:');
    const ingest = vi.fn();
    buildSessionLive(db, PID, processes, NOW, { read: readAs(status), ingestSpool: ingest });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('an ingest that throws is logged and the payload still goes out, without the prompt', () => {
    const db = openDb(':memory:');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = buildSessionLive(db, PID, processes, NOW, {
      read: readAs('waiting'), ingestSpool: () => { throw new Error('EACCES: spool'); },
    });
    expect(p).toMatchObject({ activity: 'waiting', prompt: null });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('spool'), 'EACCES: spool');
  });
});

// Usage design, Part A: the conversation header's context, from the same
// source and rule as the cards (src/main/usage.ts). `context` is injected so
// nothing here reads the real ~/.llm-workspace.
describe('buildSessionLive -- context', () => {
  const ctx = { usedTokens: 462_000, windowTokens: 1_000_000, leftPct: 44 };

  it("carries the Claude session's context, asked for by its own session id and provider", () => {
    const db = openDb(':memory:');
    const processes = [proc({ pid: 4821, provider: 'claude', cwd: '/repo/claude' })];
    const cached = [{ pid: 4821, provider: 'claude', cwd: '/repo/claude', sessionId: 'claude-1' } as OpenSession];
    const asked: string[] = [];
    const p = buildSessionLive(db, 4821, processes, Date.now(), {
      cached, read: () => ({ ok: false, reason: 'missing' }) as LiveSessionRead,
      context: (id, provider) => { asked.push(`${provider}:${id}`); return ctx; },
    });
    expect(p?.context).toEqual(ctx);
    expect(asked).toEqual(['claude:claude-1']);
  });

  it("carries a Codex session's context the same way", () => {
    const db = openDb(':memory:');
    const processes = [proc({ pid: 4821, provider: 'codex', cwd: '/repo/codex' })];
    const cached = [{ pid: 4821, provider: 'codex', cwd: '/repo/codex', sessionId: 'codex-1' } as OpenSession];
    const asked: string[] = [];
    const p = buildSessionLive(db, 4821, processes, Date.now(), {
      cached, context: (id, provider) => { asked.push(`${provider}:${id}`); return ctx; },
    });
    expect(p?.context).toEqual(ctx);
    expect(asked).toEqual(['codex:codex-1']);
  });

  it('is null for a live process with no session', () => {
    const db = openDb(':memory:');
    const processes = [proc({ pid: 4821, provider: 'claude', cwd: '/repo/claude' })];
    const p = buildSessionLive(db, 4821, processes, Date.now(), {
      read: () => ({ ok: false, reason: 'missing' }) as LiveSessionRead, context: () => ctx,
      // Injected so this never runs a real tmux. The chip belongs to the
      // pane, not to a matched session, so it IS still built on this
      // branch -- see the buildSessionLive mode tests below.
      mode: () => null,
    });
    expect(p).toEqual({
      version: 1, pid: 4821, sessionId: null, activity: null, since: null, events: 0,
      prompt: null, context: null, mode: null,
    });
  });
});

// Mode-switcher design §2: the chip's state rides this same push, so it
// follows a mode changed in the terminal as well as one changed through
// session:mode:set. Everything tmux-facing is injected, the same way the
// context tests above inject `context` -- nothing here runs a real tmux.
describe('buildSessionLive -- the mode chip', () => {
  const claudeFooter = readFileSync('tests/fixtures/modes/claude-plan.txt', 'utf8');
  const codexFooter = readFileSync('tests/fixtures/modes/codex-default.txt', 'utf8');

  /** A fake pane that answers the copy-mode query and hands back one
   *  screen for every capture. */
  function pane(screen: string) {
    return (args: string[]) => args[0] === 'display-message'
      ? { ok: true as const, stdout: '0\n' }
      : { ok: true as const, stdout: screen };
  }

  afterEach(() => clearRegistry());

  it("carries the pane's mode, read with the process's own provider", () => {
    const db = openDb(':memory:');
    registerSession(4821, 'llmws-claude-live1');
    const processes = [proc({ pid: 4821, provider: 'claude', cwd: '/repo/claude' })];
    const cached = [{ pid: 4821, provider: 'claude', cwd: '/repo/claude', sessionId: 'claude-1' } as OpenSession];
    const p = buildSessionLive(db, 4821, processes, Date.now(), {
      cached, read: () => ({ ok: false, reason: 'missing' }) as LiveSessionRead,
      context: () => null, answer: { capture: pane(claudeFooter) },
      mode: pid => readModeFor(pid, {
        capture: pane(claudeFooter), has: () => true, provider: () => 'claude',
      }),
    });
    expect(p?.mode).toEqual({ provider: 'claude', mode: 'plan', blocked: null });
  });

  it("reads a Codex pane with Codex's own reader", () => {
    const db = openDb(':memory:');
    registerSession(4821, 'llmws-codex-live1');
    const processes = [proc({ pid: 4821, provider: 'codex', cwd: '/repo/codex' })];
    const cached = [{ pid: 4821, provider: 'codex', cwd: '/repo/codex', sessionId: 'codex-1' } as OpenSession];
    const p = buildSessionLive(db, 4821, processes, Date.now(), {
      cached, context: () => null,
      mode: pid => readModeFor(pid, {
        capture: pane(codexFooter), has: () => true, provider: () => 'codex',
      }),
    });
    expect(p?.mode).toEqual({ provider: 'codex', mode: 'default', blocked: null });
  });

  // The default closure is what production uses, and it must ask the
  // process's own provider -- not guess one. A pid the registry does not
  // know has no pane at all, so there is no mode and no capture.
  //
  // Converted 2026-09-22 from 'shows no chip at all ...': the payload now
  // carries the reason instead of a bare null, so the pane can draw a
  // disabled chip that says why rather than silently dropping the control.
  // The cost side is unchanged and still asserted: no capture-pane runs.
  it('reports not_tmux, and reads no pane, for a session this app did not launch', () => {
    const db = openDb(':memory:');
    const captures: string[][] = [];
    const processes = [proc({ pid: 4821, provider: 'claude', cwd: '/repo/claude' })];
    const p = buildSessionLive(db, 4821, processes, Date.now(), {
      read: () => ({ ok: false, reason: 'missing' }) as LiveSessionRead, context: () => null,
      mode: pid => readModeFor(pid, {
        capture: args => { captures.push(args); return pane(claudeFooter)(args); },
        has: () => true, provider: () => 'claude',
      }),
    });
    expect(p?.mode).toEqual({ provider: 'claude', mode: null, blocked: 'not_tmux' });
    expect(captures).toEqual([]);
  });
});
