import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { buildSessionLive } from '../../src/main/sessionLive.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';
import type { OpenSession } from '../../src/fleet/state.ts';
import type { LiveSessionRead } from '../../src/providers/claude/liveSession.ts';

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

  // The other of the "both waiting kinds" the brief's title covers:
  // waiting_permission, from an open PermissionRequest blocker rather than
  // the live status file. deriveActivity gives the blocker priority over
  // liveStatus (src/fleet/state.ts), so an idle status alongside an open
  // blocker must still read as waiting here, not idle.
  it('maps an open permission blocker to waiting', () => {
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
    expect(p?.activity).toBe('waiting');
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
