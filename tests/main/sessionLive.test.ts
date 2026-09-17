import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import {
  buildSessionLive, watchSessionFor, notifySessionChanged, pushSessionLive,
  type SessionLivePayload, type WatchDeps, type WatchHandle,
} from '../../src/main/sessionLive.ts';
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

describe('watchSessionFor / notifySessionChanged / pushSessionLive', () => {
  const CLAUDE_PATH = `${homedir()}/.claude/sessions/4821.json`;

  // A fake fs.watch: records every path it is asked to watch and lets a
  // test fire that path's own registered 'error' handler, or close it,
  // without ever touching the real filesystem or leaving a real watcher
  // running past the test.
  function fakeWatch() {
    const errorHandlers = new Map<string, (err: Error) => void>();
    const active = new Set<string>();
    let closedCount = 0;
    const watch = (path: string): WatchHandle => {
      active.add(path);
      return {
        on: (event, cb) => { if (event === 'error') errorHandlers.set(path, cb); },
        close: () => { active.delete(path); closedCount += 1; },
      };
    };
    return {
      watch,
      watchedPaths: () => [...active],
      closedCount: () => closedCount,
      triggerError: (path: string, err: Error) => errorHandlers.get(path)?.(err),
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
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
    const { deps, sent, fake } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload,
    });
    expect(watchSessionFor(4821, deps)).toBe(true);
    expect(fake.watchedPaths()).toEqual([CLAUDE_PATH]);
    expect(sent).toEqual([payload]);
  });

  it('never opens a status-file watch for a non-claude process', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
    const { deps, sent, fake } = makeDeps({
      processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => payload,
    });
    expect(watchSessionFor(4821, deps)).toBe(true);
    expect(fake.watchedPaths()).toEqual([]);
    expect(sent).toEqual([payload]);
  });

  it('closes the previous watcher before starting a new one for a different pid', () => {
    const payload1: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
    const first = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload1 });
    expect(watchSessionFor(4821, first.deps)).toBe(true);
    expect(first.fake.watchedPaths()).toEqual([CLAUDE_PATH]);

    const payload2: SessionLivePayload = { version: 1, pid: 4822, sessionId: 's2', activity: 'idle', since: null, events: 2 };
    const second = makeDeps({ processes: [proc({ pid: 4822, provider: 'claude' })], buildPayload: () => payload2 });
    expect(watchSessionFor(4822, second.deps)).toBe(true);

    expect(first.fake.closedCount()).toBe(1);
    expect(first.fake.watchedPaths()).toEqual([]);
    expect(second.fake.watchedPaths()).toEqual([`${homedir()}/.claude/sessions/4822.json`]);
  });

  it('releases the watcher and timer on an explicit null', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
    const { deps, fake } = makeDeps({ processes: [proc({ pid: 4821, provider: 'claude' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);
    expect(watchSessionFor(null, deps)).toBe(false);
    expect(fake.watchedPaths()).toEqual([]);
    expect(fake.closedCount()).toBe(1);
  });

  it('falls back to the sweep when the watch reports an error, without dropping the watched session', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
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

  it('pushes at most one payload per 250ms burst', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
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
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
    const { deps, sent } = makeDeps({ processes: [proc({ pid: 4821, provider: 'codex' })], buildPayload: () => payload });
    watchSessionFor(4821, deps);
    sent.length = 0;

    vi.useFakeTimers();
    notifySessionChanged(new Set(['s2']));
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(0);
  });

  it('releases the watch when pushSessionLive finds the watched pid has left the discovery cache', () => {
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
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
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
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
    const payload: SessionLivePayload = { version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: 1, events: 1 };
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
