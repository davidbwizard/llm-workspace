import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import { fleetState, openSessions, openSessionsLive, fleetStatePage } from '../../src/fleet/state.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';

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

  // Activity is decided by WHICH event happened last, not how long ago. An
  // agent mid-tool-call or mid-generation writes nothing for minutes; the old
  // rule (any event within 20s) reported one session working while five were.
  it('stays working while quiet, when the last event is not a turn boundary', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'tool.used', ts:at(8), payload:{ name:'Bash' }, contentHash:'b', subIndex:1 }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.lifecycle).toBe('active');
    expect(s!.activity).toBe('working');
  });

  it('is idle the moment the turn completes, however recent that was', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'tool.used', ts:at(1), payload:{ name:'Bash' }, contentHash:'b', subIndex:1 }),
      ev({ kind:'turn.completed', ts:at(0), payload:{}, contentHash:'c', subIndex:2 }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.lifecycle).toBe('active');
    expect(s!.activity).toBe('idle');
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
    expect(s!.alive).toBe(false);
    expect(s!.processAgeSeconds).toBeNull();
    expect(s!.processRssBytes).toBeNull();
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

  // Spec §9.5 is about worktree CONTENTION -- two sessions that could
  // actually clobber each other's work right now -- not "N sessions have
  // ever run in this directory" trivia. sharesWorktreeWith is restricted to
  // reachable (lifecycle 'active') sessions on both sides so it warns only
  // when contention is real.
  it('two concurrently-active sessions in one directory DO warn', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(1), payload:{ cwd:'/Users/me/live' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', ts:at(2), payload:{ cwd:'/Users/me/live' }, contentHash:'b' }),
    ]);
    const all = fleetState(db, { now: NOW });
    const byId = new Map(all.map(s => [s.sessionId, s]));
    expect(byId.get('s1')!.lifecycle).toBe('active');
    expect(byId.get('s2')!.lifecycle).toBe('active');
    expect(byId.get('s1')!.sharesWorktreeWith).toEqual(['s2']);
    expect(byId.get('s2')!.sharesWorktreeWith).toEqual(['s1']);
  });

  it('a hundred historical sessions in the same directory do NOT warn', () => {
    const db = openDb(':memory:');
    const historical = Array.from({ length: 100 }, (_, i) =>
      ev({
        sessionId: `old-${i}`, kind: 'session.started', ts: at(60 * 24 * 30),
        payload: { cwd: '/Users/me/graveyard' }, contentHash: `h${i}`,
      }));
    insertEvents(db, historical);
    const all = fleetState(db, { now: NOW });
    expect(all).toHaveLength(100);
    expect(all.every(s => s.lifecycle === 'disconnected')).toBe(true);
    expect(all.every(s => s.sharesWorktreeWith.length === 0)).toBe(true);
  });

  it('an active session does not warn about disconnected sessions sharing its directory, and vice versa', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(1), payload:{ cwd:'/Users/me/mixed' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', ts:at(60 * 24), payload:{ cwd:'/Users/me/mixed' }, contentHash:'b' }),
    ]);
    const all = fleetState(db, { now: NOW });
    const byId = new Map(all.map(s => [s.sessionId, s]));
    expect(byId.get('s1')!.lifecycle).toBe('active');
    expect(byId.get('s2')!.lifecycle).toBe('disconnected');
    expect(byId.get('s1')!.sharesWorktreeWith).toEqual([]);
    expect(byId.get('s2')!.sharesWorktreeWith).toEqual([]);
  });

  // The next three tests pin down defects found while implementing this
  // fold; see task-4-report.md for the full write-up of each.

  it('reports the cwd of the most recent session.started, not an arbitrary one', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      // An older session.started row, from an earlier transcript file, at
      // a stale cwd. Without an ORDER BY on the correlated subquery this
      // is the row SQLite happens to return first (a plain table scan
      // visits rows in storage order), which would silently report a
      // cwd this session left behind.
      ev({ kind:'session.started', ts:at(50), payload:{ cwd:'/old/path' }, contentHash:'a', sourceFile:'/old.jsonl' }),
      ev({ kind:'session.started', ts:at(1), payload:{ cwd:'/new/path' }, contentHash:'b', subIndex:1, sourceFile:'/new.jsonl' }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.cwd).toBe('/new/path');
  });

  it('reports the run_id of the most recently active run, not the lexicographically largest', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      // 'zzz-early' sorts after 'aaa-late' as a string, so MAX(run_id)
      // would pick the OLDER run purely because its opaque hash-like id
      // happens to be lexicographically larger. run_id is not an ordered
      // sequence (deriveRunId is a truncated sha256), so a plain MAX()
      // over it is meaningless.
      ev({ kind:'session.started', ts:at(50), runId:'zzz-early', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prompt.submitted', ts:at(1), runId:'aaa-late', payload:{}, contentHash:'b', subIndex:1 }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.runId).toBe('aaa-late');
  });

  it('reports liveAgents by recency -- only the agent with a fresh event counts', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(5), payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'agent.spawned', ts:at(5), agentId:'ag1', payload:{ name:'task-1' }, contentHash:'b' }),
      ev({ kind:'agent.spawned', ts:at(5), agentId:'ag2', payload:{ name:'task-2' }, contentHash:'c' }),
      // ag1 produced something recently -- still working.
      ev({ kind:'tool.used', ts:at(0.1), agentId:'ag1', payload:{ name:'Bash' }, contentHash:'d' }),
      // ag2's last event was its own spawn, 5 minutes ago -- stale.
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.agents).toBe(2);       // ever spawned
    expect(s!.liveAgents).toBe(1);   // ag1 only
  });

  it('a spawned agent and a later event carrying the same bare id resolve to one agent', () => {
    // Pins the join that was broken end to end. findSubagents
    // (src/providers/claude/subagents.ts) now emits the BARE agent id for
    // agent.spawned, not the `agent-`-prefixed on-disk filename stem --
    // specifically so this correlates. Before that fix, this agentId would
    // have been 'agent-task-8-magiclink-abc123' while a record from that
    // subagent's own transcript (parsed independently) would still carry
    // the bare id below, and the two would never join: agents would count
    // 2 mismatched ids instead of 1, and the real one would never show as
    // live no matter how recent its activity.
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(5), payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'agent.spawned', ts:at(5), agentId:'task-8-magiclink-abc123',
           payload:{ name:'task-8-magiclink' }, contentHash:'b' }),
      // A record from that subagent's own transcript, same bare id.
      ev({ kind:'tool.used', ts:at(0.1), agentId:'task-8-magiclink-abc123',
           payload:{ name:'Edit' }, contentHash:'c' }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.agents).toBe(1);       // one agent, not two mismatched ids
    expect(s!.liveAgents).toBe(1);   // its own recent event marks it live
  });

  it('reports 0 live agents for an idle session, even with agents spawned long ago', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(400), payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'agent.spawned', ts:at(400), agentId:'ag1', payload:{ name:'task-1' }, contentHash:'b' }),
      ev({ kind:'agent.spawned', ts:at(400), agentId:'ag2', payload:{ name:'task-2' }, contentHash:'c' }),
    ]);
    const [s] = fleetState(db, { now: NOW });
    expect(s!.activity).toBe('idle');
    expect(s!.agents).toBe(2);
    expect(s!.liveAgents).toBe(0);
  });

  function proc(o: Partial<LiveProcess> & { pid: number }): LiveProcess {
    return { provider: 'claude', tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null, ...o };
  }

  describe('process liveness (Phase 3 tiers)', () => {
    it('a unique match yields exactly one candidate, not a duplicate', () => {
      // Regression pin: classifyMatch's `unique` result sets BOTH
      // m.sessionId and m.candidates = [that same session id] -- a loop
      // that processes both, once per branch, double-inserts the pid.
      // fleetState now iterates `candidates` alone, which already covers
      // the unique case, so this must come back as a one-element array.
      const db = openDb(':memory:');
      insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' })]);
      const [s] = fleetState(db, { now: NOW, processes: [proc({ pid:555, cwd:'/repo/live' })] });
      expect(s!.match).toBe('unique');
      expect(s!.candidates).toEqual([555]);
    });

    it('marks a session alive, with age and memory, when a live process matches it', () => {
      const db = openDb(':memory:');
      insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' })]);
      const [s] = fleetState(db, {
        now: NOW,
        processes: [proc({ pid:555, cwd:'/repo/live', ageSeconds:777_600, rssBytes:216_006_656 })],
      });
      expect(s!.alive).toBe(true);
      expect(s!.processAgeSeconds).toBe(777_600);
      expect(s!.processRssBytes).toBe(216_006_656);
    });

    it('when several processes match one session, reports age and memory from the oldest', () => {
      const db = openDb(':memory:');
      insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'a' })]);
      const [s] = fleetState(db, {
        now: NOW,
        processes: [
          proc({ pid:101, cwd:'/repo/shared', ageSeconds:100, rssBytes:1_000 }),
          proc({ pid:102, cwd:'/repo/shared', ageSeconds:500, rssBytes:5_000 }),
        ],
      });
      expect(new Set(s!.candidates)).toEqual(new Set([101, 102]));
      expect(s!.processAgeSeconds).toBe(500);
      expect(s!.processRssBytes).toBe(5_000);
    });

    // The core of Task 3: activity currently a working session had killed
    // mid-turn (no turn boundary event) used to read as `working` forever.
    // A session whose process discovery can positively account for but
    // finds NOT running -- while discovery is otherwise functioning, i.e.
    // it found a live process somewhere else -- can never be `working`.
    it('a dead session can never be working, even mid-turn, when discovery is functioning', () => {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', payload:{ cwd:'/repo/dead' }, contentHash:'a' }),
        ev({ kind:'tool.used', ts:at(8), payload:{ name:'Bash' }, contentHash:'b', subIndex:1 }),
      ]);
      // Discovery ran and found a real process -- just not for this
      // session's cwd, so `hasLiveSignal` is true and `alive` is false.
      const [s] = fleetState(db, { now: NOW, processes: [proc({ pid:9, cwd:'/repo/elsewhere' })] });
      expect(s!.lifecycle).toBe('active');
      expect(s!.alive).toBe(false);
      expect(s!.activity).toBe('idle');
    });

    it('a live, matched session mid-turn is working', () => {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' }),
        ev({ kind:'tool.used', ts:at(8), payload:{ name:'Bash' }, contentHash:'b', subIndex:1 }),
      ]);
      const [s] = fleetState(db, { now: NOW, processes: [proc({ pid:9, cwd:'/repo/live' })] });
      expect(s!.alive).toBe(true);
      expect(s!.activity).toBe('working');
    });

    // Spec 7.1a: discovery is enrichment, never a filter. A sweep that
    // found NOTHING at all (pgrep missing, or discovery otherwise broken)
    // must not be able to empty the working group -- that would be a worse
    // failure than the stuck-mid-turn bug this task fixes. Falls back to
    // the prior turn-boundary-only rule when there is no live signal at all.
    it('an active session mid-turn stays working when discovery finds nothing at all, anywhere', () => {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', payload:{ cwd:'/repo/whatever' }, contentHash:'a' }),
        ev({ kind:'tool.used', ts:at(8), payload:{ name:'Bash' }, contentHash:'b', subIndex:1 }),
      ]);
      const [s] = fleetState(db, { now: NOW, processes: [] });
      expect(s!.alive).toBe(false);
      expect(s!.activity).toBe('working');
    });
  });

  // Phase 3 tier fix: `cwd` resolves to a directory, not a specific
  // session, so two sessions sharing a repo make any process matched to
  // that cwd ambiguous -- there is no way to tell which of them it belongs
  // to. Printing that process's age/memory (or `alive: true`) on both
  // sessions would attribute one process's facts to a session it might not
  // be, which is the exact bug this fix removes (see the fleet-wide report:
  // one live process in a shared repo used to mark 111 unrelated sessions
  // alive, all showing that one process's age and memory).
  describe('ambiguous matches are not attributed to any one session (Phase 3 tier fix)', () => {
    it('reports alive false with no age or memory for every session sharing an ambiguously-matched cwd', () => {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
        ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'b' }),
      ]);
      const all = fleetState(db, {
        now: NOW,
        processes: [proc({ pid:9, cwd:'/repo/shared', ageSeconds:777_600, rssBytes:216_006_656 })],
      });
      expect(all).toHaveLength(2);
      expect(all.every(s => s.match === 'ambiguous')).toBe(true);
      expect(all.every(s => s.alive === false)).toBe(true);
      expect(all.every(s => s.processAgeSeconds === null)).toBe(true);
      expect(all.every(s => s.processRssBytes === null)).toBe(true);
    });

    // The mid-turn-kill check (see the `activity` computation's comment in
    // src/fleet/state.ts) only needs to know A process exists at this cwd,
    // not which session it belongs to -- requiring unique attribution here
    // would wrongly demote a genuinely-working session to idle whenever its
    // cwd is shared, which is the common case on a real workspace.
    it('a mid-turn session with only an ambiguous match still reads as working', () => {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
        ev({ kind:'tool.used', ts:at(8), payload:{ name:'Bash' }, contentHash:'b', subIndex:1 }),
        ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'c' }),
      ]);
      const all = fleetState(db, { now: NOW, processes: [proc({ pid:9, cwd:'/repo/shared' })] });
      const s1 = all.find(s => s.sessionId === 's1')!;
      expect(s1.match).toBe('ambiguous');
      expect(s1.alive).toBe(false);
      expect(s1.activity).toBe('working');
    });
  });

  // `lifecycle`'s ACTIVE_MS boundary itself (still governs `stale` and the
  // sharesWorktreeWith contention check, spec S9.5, independent of
  // whatever a process is doing) -- 25 minutes since the last transcript
  // event is still Active/reachable; 2 days is not.
  describe('the lifecycle boundary (ACTIVE_MS)', () => {
    it('a session active 25 minutes ago is still Active', () => {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', ts:at(25), payload:{ cwd:'/r' }, contentHash:'a' }),
        ev({ kind:'turn.completed', ts:at(25), payload:{}, contentHash:'b', subIndex:1 }),
      ]);
      const [s] = fleetState(db, { now: NOW });
      expect(s!.lifecycle).toBe('active');
    });

    it('a session last active 2 days ago is disconnected', () => {
      const db = openDb(':memory:');
      insertEvents(db, [
        ev({ kind:'session.started', ts:at(2 * 24 * 60), payload:{ cwd:'/r' }, contentHash:'a' }),
        ev({ kind:'turn.completed', ts:at(2 * 24 * 60), payload:{}, contentHash:'b', subIndex:1 }),
      ]);
      const [s] = fleetState(db, { now: NOW });
      expect(s!.lifecycle).toBe('disconnected');
    });
  });
});

// openSessions enumerates from live PROCESSES, not from transcripts -- the
// model correction: "ALL OPEN SESSIONS should show. And the source. So I
// can close if they are actually dead." A session opened nine days ago and
// never touched since is still open; transcript recency (fleetState's
// `lifecycle`) cannot tell that apart from one that is truly gone. This is
// deliberately a separate exported function, tested independently of
// fleetState, because it consumes `SessionState[]` + `LiveProcess[]` as
// plain inputs rather than a db -- it is pure and does not query.
describe('openSessions', () => {
  function proc(o: Partial<LiveProcess> & { pid: number }): LiveProcess {
    return { provider: 'claude', tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null, ...o };
  }

  it('lists one card per live process, regardless of transcript recency', () => {
    const db = openDb(':memory:');
    // A session touched nine days ago -- History under the old design,
    // invisible under any recency filter. Its process is still open.
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(9 * 24 * 60), payload:{ cwd:'/repo/nine-days' }, contentHash:'a' }),
      ev({ kind:'turn.completed', ts:at(9 * 24 * 60), payload:{}, contentHash:'b', subIndex:1 }),
    ]);
    const sessions = fleetState(db, { now: NOW });
    expect(sessions[0]!.lifecycle).toBe('disconnected'); // sanity: genuinely old by transcript recency

    const open = openSessions(sessions, [proc({ pid:1, cwd:'/repo/nine-days', ageSeconds:9 * 86_400 })]);
    expect(open).toHaveLength(1);
    expect(open[0]!.pid).toBe(1);
    expect(open[0]!.match).toBe('unique');
  });

  it('shows pid, provider, host, cwd, project, age and memory for a process with no transcript match at all', () => {
    const open = openSessions([], [proc({
      pid:42, provider:'codex', cwd:'/Users/me/orphan', host:'iterm2', ageSeconds:120, rssBytes:50_000_000,
    })]);
    expect(open).toEqual([{
      pid:42, provider:'codex', host:'iterm2', cwd:'/Users/me/orphan', project:'orphan',
      ageSeconds:120, rssBytes:50_000_000, match:'unknown',
      sessionId:null, lastProse:null, events:null, activity:null, tmux:false,
    }]);
  });

  // provider is not enrichment: it is the one field discovery already knows
  // with certainty for every process (which `pgrep -x <bin>` found it),
  // independent of any transcript match -- see the openSessions doc
  // comment. A process discovered as 'codex' reports 'codex' even when it
  // matches a 'claude' session's cwd, because provider answers "which CLI
  // is this process", not "which session does this belong to".
  it("reports provider from the process's own discovery, not from a matched session of a different provider", () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', provider:'claude', payload:{ cwd:'/repo/live' }, contentHash:'a' })]);
    const sessions = fleetState(db, { now: NOW });
    const open = openSessions(sessions, [proc({ pid:9, provider:'codex', cwd:'/repo/live' })]);
    expect(open[0]!.match).toBe('unique');
    expect(open[0]!.sessionId).toBe('s1');
    expect(open[0]!.provider).toBe('codex');
  });

  it('enriches a uniquely-matched card with last prose, events and activity', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:'Reused the JWT helper.' }, contentHash:'b', subIndex:1 }),
    ]);
    const sessions = fleetState(db, { now: NOW });
    const open = openSessions(sessions, [proc({
      pid:9, cwd:'/repo/live', host:'vscode', ageSeconds:600, rssBytes:100_000_000,
    })]);
    expect(open[0]).toMatchObject({
      match:'unique', sessionId:'s1',
      lastProse:'Reused the JWT helper.', activity:'working',
    });
    expect(open[0]!.events).toBeGreaterThan(0);
  });

  // PREMISE CHANGE from the version of this test predating the provider
  // fix: it used to assert `provider` was null on an ambiguous match,
  // grouped with the other borrowed-from-a-session fields. That was
  // correct under the old design, where provider WAS session-derived
  // enrichment -- it is no longer: provider now comes straight from the
  // process (LiveProcess.provider, known at discovery time), so it stays
  // populated regardless of match quality, same as pid/host/age/memory.
  // The redesign's attribution discipline still applies to everything that
  // genuinely IS session-derived: sessionId/lastProse/events/activity.
  it('renders an ambiguous match without borrowing another session\'s words or activity, while provider stays attributable', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'b' }),
    ]);
    const sessions = fleetState(db, { now: NOW });
    const open = openSessions(sessions, [proc({
      pid:7, provider:'codex', cwd:'/repo/shared', host:'terminal', ageSeconds:300, rssBytes:1_000_000,
    })]);
    expect(open).toHaveLength(1);
    expect(open[0]!.match).toBe('ambiguous');
    expect(open[0]!.sessionId).toBeNull();
    expect(open[0]!.lastProse).toBeNull();
    expect(open[0]!.events).toBeNull();
    expect(open[0]!.activity).toBeNull();
    // Still attributable: these come from the process itself, not from a
    // matched session.
    expect(open[0]!.pid).toBe(7);
    expect(open[0]!.provider).toBe('codex');
    expect(open[0]!.host).toBe('terminal');
    expect(open[0]!.ageSeconds).toBe(300);
    expect(open[0]!.rssBytes).toBe(1_000_000);
  });

  it('does not filter open cards against sessions -- a process with a cwd no session has ever used still gets a card', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/unrelated' }, contentHash:'a' })]);
    const sessions = fleetState(db, { now: NOW });
    const open = openSessions(sessions, [proc({ pid:3, cwd:'/nowhere/tracked' })]);
    expect(open).toHaveLength(1);
    expect(open[0]!.match).toBe('unknown');
    expect(open[0]!.sessionId).toBeNull();
  });

  it('orders by process age ascending (newest first), unknown age last, pid breaking ties', () => {
    const open = openSessions([], [
      proc({ pid:3, ageSeconds:500 }),
      proc({ pid:1, ageSeconds:null }),
      proc({ pid:2, ageSeconds:100 }),
      proc({ pid:4, ageSeconds:100 }),
    ]);
    expect(open.map(o => o.pid)).toEqual([2, 4, 3, 1]);
  });

  // A temp-dir cwd is not a project -- the card's title used to render as
  // the bare last path segment (e.g. "T" for a macOS
  // /var/folders/xx/yy/T tmpdir), which is meaningless. It gets a
  // description instead, and sorts after every real project even though
  // it is the NEWEST process here (ageSeconds:1) -- proving the junk
  // tiebreak actually overrides age, not just coincides with it.
  it('gives a temp-dir session an honest title and sorts it after every real project despite being newest', () => {
    const open = openSessions([], [
      proc({ pid:1, cwd:`${tmpdir()}/xyz/T`, ageSeconds:1 }),
      proc({ pid:2, cwd:'/repo/real', ageSeconds:1000 }),
    ]);
    expect(open.map(o => o.pid)).toEqual([2, 1]);
    expect(open.find(o => o.pid === 1)!.project).toBe('temp folder');
  });

  // Same as above for the filesystem root -- a session with no real cwd
  // context used to render its title as the literal "/".
  it('gives a root-cwd session an honest title and sorts it after every real project despite being newest', () => {
    const open = openSessions([], [
      proc({ pid:1, cwd:'/', ageSeconds:1 }),
      proc({ pid:2, cwd:'/repo/real', ageSeconds:1000 }),
    ]);
    expect(open.map(o => o.pid)).toEqual([2, 1]);
    expect(open.find(o => o.pid === 1)!.project).toBe('filesystem root');
  });

  // The naive fix (matching the last path segment against the literal
  // string "T" or "tmp") would also catch a real project directory that
  // happens to be named that -- this is the assertion that stops it: both
  // stay real projects, keeping their own name as the title and their
  // place in the age-ordered sort, not shoved to the end.
  it('does not treat a real project directory literally named "T" or "tmp" as junk', () => {
    const open = openSessions([], [
      proc({ pid:1, cwd:'/Users/me/projects/T', ageSeconds:5 }),
      proc({ pid:2, cwd:'/Users/me/projects/tmp', ageSeconds:1 }),
    ]);
    expect(open.find(o => o.pid === 1)!.project).toBe('T');
    expect(open.find(o => o.pid === 2)!.project).toBe('tmp');
    // Ordered by age like any other real project -- not pushed to the end.
    expect(open.map(o => o.pid)).toEqual([2, 1]);
  });

  // The junk tiebreak must be exactly that -- a tiebreak -- and never a
  // second, competing sort: mixing one junk card in among several real
  // ones must not disturb the real ones' relative order (still plain
  // ageSeconds-ascending, pid-breaking-ties, same as the "orders by
  // process age" test above), only append the junk card past all of them.
  it('keeps ordering among real sessions unchanged when a junk card is mixed in', () => {
    const open = openSessions([], [
      proc({ pid:3, cwd:'/repo/c', ageSeconds:500 }),
      proc({ pid:9, cwd:tmpdir(), ageSeconds:1 }), // junk, newest -- must still sort last
      proc({ pid:1, cwd:'/repo/a', ageSeconds:null }),
      proc({ pid:2, cwd:'/repo/b', ageSeconds:100 }),
    ]);
    expect(open.map(o => o.pid)).toEqual([2, 3, 1, 9]);
  });

  // tmux defaults false with no dependency at all (this module has no tmux
  // registry access of its own -- see OpenSession's own doc comment), but a
  // caller that DOES supply one (src/main/ipc.ts) must have it actually
  // drive the field, per-pid, not just default every card the same way.
  it('reports tmux per pid from the injected isTmux, defaulting false with none given', () => {
    const withoutDeps = openSessions([], [proc({ pid:1 }), proc({ pid:2 })]);
    expect(withoutDeps.map(o => o.tmux)).toEqual([false, false]);

    const withDeps = openSessions([], [proc({ pid:1 }), proc({ pid:2 })], { isTmux: pid => pid === 2 });
    expect(withDeps.find(o => o.pid === 1)!.tmux).toBe(false);
    expect(withDeps.find(o => o.pid === 2)!.tmux).toBe(true);
  });
});

// The targeted alternative to openSessions(fleetState(db, ...), ...):
// same output contract (same fixtures, same expectations as the
// openSessions block above, largely mirrored test for test), but built
// from two SQL passes bounded by live-process cwds/ids rather than by
// fleetState's full per-session computation -- see openSessionsLive's own
// doc comment in src/fleet/state.ts for why that bound is the point. This
// is what pushFleet (src/main/ipc.ts) calls now instead of fleetState.
describe('openSessionsLive', () => {
  function proc(o: Partial<LiveProcess> & { pid: number }): LiveProcess {
    return { provider: 'claude', tty: null, cwd: null, host: 'unknown', ageSeconds: null, rssBytes: null, ...o };
  }

  it('lists one card per live process, regardless of transcript recency', () => {
    const db = openDb(':memory:');
    // A session touched nine days ago -- History under the old design,
    // invisible under any recency filter. Its process is still open.
    insertEvents(db, [
      ev({ kind:'session.started', ts:at(9 * 24 * 60), payload:{ cwd:'/repo/nine-days' }, contentHash:'a' }),
      ev({ kind:'turn.completed', ts:at(9 * 24 * 60), payload:{}, contentHash:'b', subIndex:1 }),
    ]);
    const open = openSessionsLive(db, [proc({ pid:1, cwd:'/repo/nine-days', ageSeconds:9 * 86_400 })], NOW);
    expect(open).toHaveLength(1);
    expect(open[0]!.pid).toBe(1);
    expect(open[0]!.match).toBe('unique');
  });

  it('shows pid, provider, host, cwd, project, age and memory for a process with no transcript match at all', () => {
    const db = openDb(':memory:');
    const open = openSessionsLive(db, [proc({
      pid:42, provider:'codex', cwd:'/Users/me/orphan', host:'iterm2', ageSeconds:120, rssBytes:50_000_000,
    })], NOW);
    expect(open).toEqual([{
      pid:42, provider:'codex', host:'iterm2', cwd:'/Users/me/orphan', project:'orphan',
      ageSeconds:120, rssBytes:50_000_000, match:'unknown',
      sessionId:null, lastProse:null, events:null, activity:null, tmux:false,
    }]);
  });

  it("reports provider from the process's own discovery, not from a matched session of a different provider", () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', provider:'claude', payload:{ cwd:'/repo/live' }, contentHash:'a' })]);
    const open = openSessionsLive(db, [proc({ pid:9, provider:'codex', cwd:'/repo/live' })], NOW);
    expect(open[0]!.match).toBe('unique');
    expect(open[0]!.sessionId).toBe('s1');
    expect(open[0]!.provider).toBe('codex');
  });

  it('enriches a uniquely-matched card with last prose, events and activity', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:'Reused the JWT helper.' }, contentHash:'b', subIndex:1 }),
    ]);
    const open = openSessionsLive(db, [proc({
      pid:9, cwd:'/repo/live', host:'vscode', ageSeconds:600, rssBytes:100_000_000,
    })], NOW);
    expect(open[0]).toMatchObject({
      match:'unique', sessionId:'s1',
      lastProse:'Reused the JWT helper.', activity:'working',
    });
    expect(open[0]!.events).toBeGreaterThan(0);
  });

  // The feature this whole path exists for: a card whose session has an
  // open permission request must show 'waiting_permission', the exact
  // signal FleetView's "needs you" chip counts. Proves deriveActivity's
  // blocker branch reaches this path identically to fleetState's own.
  it('reports waiting_permission for a uniquely-matched session with an open blocker', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/blocked' }, contentHash:'a' })]);
    db.prepare(`INSERT INTO signal_events
      (event_id, occurred_at, ingested_at, provider, session_id, tool_use_id, kind, payload)
      VALUES (?,?,?,?,?,?,?,?)`).run('e1', at(3), at(3), 'claude', 's1', 't1',
        'PermissionRequest', JSON.stringify({ tool_name:'Bash', tool_input:{ command:'rm -rf /tmp/x' } }));
    const open = openSessionsLive(db, [proc({ pid:9, cwd:'/repo/blocked' })], NOW);
    expect(open[0]!.match).toBe('unique');
    expect(open[0]!.activity).toBe('waiting_permission');
  });

  it('renders an ambiguous match without borrowing another session\'s words or activity, while provider stays attributable', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'b' }),
    ]);
    const open = openSessionsLive(db, [proc({
      pid:7, provider:'codex', cwd:'/repo/shared', host:'terminal', ageSeconds:300, rssBytes:1_000_000,
    })], NOW);
    expect(open).toHaveLength(1);
    expect(open[0]!.match).toBe('ambiguous');
    expect(open[0]!.sessionId).toBeNull();
    expect(open[0]!.lastProse).toBeNull();
    expect(open[0]!.events).toBeNull();
    expect(open[0]!.activity).toBeNull();
    expect(open[0]!.pid).toBe(7);
    expect(open[0]!.provider).toBe('codex');
    expect(open[0]!.host).toBe('terminal');
    expect(open[0]!.ageSeconds).toBe(300);
    expect(open[0]!.rssBytes).toBe(1_000_000);
  });

  it('does not filter open cards against sessions -- a process with a cwd no session has ever used still gets a card', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/unrelated' }, contentHash:'a' })]);
    const open = openSessionsLive(db, [proc({ pid:3, cwd:'/nowhere/tracked' })], NOW);
    expect(open).toHaveLength(1);
    expect(open[0]!.match).toBe('unknown');
    expect(open[0]!.sessionId).toBeNull();
  });

  it('orders by process age ascending (newest first), unknown age last, pid breaking ties', () => {
    const db = openDb(':memory:');
    const open = openSessionsLive(db, [
      proc({ pid:3, ageSeconds:500 }),
      proc({ pid:1, ageSeconds:null }),
      proc({ pid:2, ageSeconds:100 }),
      proc({ pid:4, ageSeconds:100 }),
    ], NOW);
    expect(open.map(o => o.pid)).toEqual([2, 4, 3, 1]);
  });

  // Mirrors the openSessions block's own junk-cwd tests above: this path
  // shares projectName/byProcessAge with openSessions (see state.ts), so
  // the same title-and-sort behaviour must hold here too -- this is what
  // actually feeds the rail/grid on the fleet:update push path (see
  // openSessionsLive's own doc comment), not openSessions.
  it('gives a temp-dir session an honest title and sorts it after every real project despite being newest', () => {
    const db = openDb(':memory:');
    const open = openSessionsLive(db, [
      proc({ pid:1, cwd:`${tmpdir()}/xyz/T`, ageSeconds:1 }),
      proc({ pid:2, cwd:'/repo/real', ageSeconds:1000 }),
    ], NOW);
    expect(open.map(o => o.pid)).toEqual([2, 1]);
    expect(open.find(o => o.pid === 1)!.project).toBe('temp folder');
  });

  it('gives a root-cwd session an honest title and sorts it after every real project despite being newest', () => {
    const db = openDb(':memory:');
    const open = openSessionsLive(db, [
      proc({ pid:1, cwd:'/', ageSeconds:1 }),
      proc({ pid:2, cwd:'/repo/real', ageSeconds:1000 }),
    ], NOW);
    expect(open.map(o => o.pid)).toEqual([2, 1]);
    expect(open.find(o => o.pid === 1)!.project).toBe('filesystem root');
  });

  it('does not treat a real project directory literally named "T" or "tmp" as junk', () => {
    const db = openDb(':memory:');
    const open = openSessionsLive(db, [
      proc({ pid:1, cwd:'/Users/me/projects/T', ageSeconds:5 }),
      proc({ pid:2, cwd:'/Users/me/projects/tmp', ageSeconds:1 }),
    ], NOW);
    expect(open.find(o => o.pid === 1)!.project).toBe('T');
    expect(open.find(o => o.pid === 2)!.project).toBe('tmp');
    expect(open.map(o => o.pid)).toEqual([2, 1]);
  });

  it('reports tmux per pid from the injected isTmux, defaulting false with none given', () => {
    const db = openDb(':memory:');
    const withoutDeps = openSessionsLive(db, [proc({ pid:1 }), proc({ pid:2 })], NOW);
    expect(withoutDeps.map(o => o.tmux)).toEqual([false, false]);

    const withDeps = openSessionsLive(db, [proc({ pid:1 }), proc({ pid:2 })], NOW, { isTmux: pid => pid === 2 });
    expect(withDeps.find(o => o.pid === 1)!.tmux).toBe(false);
    expect(withDeps.find(o => o.pid === 2)!.tmux).toBe(true);
  });

  it('returns an empty array, without querying, when there are no live processes', () => {
    const db = openDb(':memory:');
    const prepareSpy = vi.spyOn(db, 'prepare');
    expect(openSessionsLive(db, [], NOW)).toEqual([]);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  // The property that actually matters (per the team lead's mandate): cost
  // is bounded by the number of LIVE PROCESSES, not by how many sessions
  // are in the index. Proven the same way as fleetStatePage's own
  // single-query proof above: spy on db.prepare and count how many times
  // the candidate-cwd query and the per-session enrichment query each run
  // -- exactly once apiece, never once per session and never once per
  // candidate.
  it('runs exactly one candidate-cwd query and one enrichment query, regardless of matched session count', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', payload:{ cwd:'/repo/a' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/repo/b' }, contentHash:'b' }),
      ev({ sessionId:'s3', kind:'session.started', payload:{ cwd:'/repo/c' }, contentHash:'c' }),
    ]);
    const prepareSpy = vi.spyOn(db, 'prepare');
    openSessionsLive(db, [
      proc({ pid:1, cwd:'/repo/a' }), proc({ pid:2, cwd:'/repo/b' }), proc({ pid:3, cwd:'/repo/c' }),
    ], NOW);
    const candidateQueries = prepareSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("kind = 'session.started'") && sql.includes('IN ('));
    const enrichmentQueries = prepareSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('COUNT(*) events'));
    expect(candidateQueries).toHaveLength(1);
    expect(enrichmentQueries).toHaveLength(1);
  });

  // The enrichment query must be scoped to ONLY the uniquely-matched
  // session(s) -- bounded by live-process count -- not to every session
  // sharing a live cwd, which an ambiguous match (deliberately) never
  // gets attribution from anyway (see the ambiguous-match test above), but
  // COULD still leak into the enrichment query's own scope/cost on a
  // plausible copy-paste bug (passing the full candidate set instead of
  // just the unique ids). Two candidates share one cwd (ambiguous, no
  // enrichment target); a third session is uniquely matched elsewhere.
  it("scopes the enrichment query to exactly the uniquely-matched session, excluding an ambiguous candidate's id", () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'amb1', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
      ev({ sessionId:'amb2', kind:'session.started', payload:{ cwd:'/repo/shared' }, contentHash:'b' }),
      ev({ sessionId:'solo', kind:'session.started', payload:{ cwd:'/repo/solo' }, contentHash:'c' }),
    ]);
    const prepareSpy = vi.spyOn(db, 'prepare');
    openSessionsLive(db, [
      proc({ pid:1, cwd:'/repo/shared' }), proc({ pid:2, cwd:'/repo/solo' }),
    ], NOW);
    const enrichmentCall = prepareSpy.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('COUNT(*) events'));
    expect(enrichmentCall).toBeDefined();
    const idCount = (enrichmentCall![0] as string).match(/\?/g)?.length ?? 0;
    expect(idCount).toBe(1); // only 'solo' -- not amb1/amb2, which never resolve to a single id
  });

  // Multiple live processes, each uniquely matched to a DIFFERENT session
  // -- proves the enrichment query's IN-list handles more than one id
  // correctly, not just the single-match case every test above exercises.
  it('enriches every uniquely-matched process independently when there is more than one', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', payload:{ cwd:'/repo/a' }, contentHash:'a' }),
      ev({ sessionId:'s1', kind:'prose', payload:{ text:'working on a' }, contentHash:'a2', subIndex:1 }),
      ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/repo/b' }, contentHash:'b' }),
      ev({ sessionId:'s2', kind:'prose', payload:{ text:'working on b' }, contentHash:'b2', subIndex:1 }),
    ]);
    const open = openSessionsLive(db, [
      proc({ pid:1, cwd:'/repo/a' }), proc({ pid:2, cwd:'/repo/b' }),
    ], NOW);
    const byPid = new Map(open.map(o => [o.pid, o]));
    expect(byPid.get(1)!.sessionId).toBe('s1');
    expect(byPid.get(1)!.lastProse).toBe('working on a');
    expect(byPid.get(2)!.sessionId).toBe('s2');
    expect(byPid.get(2)!.lastProse).toBe('working on b');
  });

  // Same "most recent session.started wins" rule fleetState's own cwd
  // subquery uses -- a resumed session that moved directories should match
  // on its CURRENT cwd, not a stale one from an earlier transcript file.
  // Both cwds are live-process cwds here (unlike a single-process version
  // of this test, which the candidate query's own WHERE clause would
  // reduce to only ever returning the live cwd's row, never exercising
  // the dedup/ordering at all): s1 moved from /repo/old-path to
  // /repo/new-path, and a DIFFERENT live process now sits at old-path.
  // Getting the "most recent wins" rule wrong would match s1 to the WRONG
  // process (old-path) instead of the right one (new-path).
  it('matches on the most recent cwd when a session has moved directories', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', payload:{ cwd:'/repo/old-path' }, contentHash:'a', ts:at(20) }),
      ev({ sessionId:'s1', kind:'session.started', payload:{ cwd:'/repo/new-path' }, contentHash:'b', ts:at(5) }),
    ]);
    const open = openSessionsLive(db, [
      proc({ pid:1, cwd:'/repo/new-path' }),
      proc({ pid:2, cwd:'/repo/old-path' }),
    ], NOW);
    const byPid = new Map(open.map(o => [o.pid, o]));
    expect(byPid.get(1)!.match).toBe('unique');
    expect(byPid.get(1)!.sessionId).toBe('s1');
    // old-path is s1's STALE cwd -- no session currently claims it.
    expect(byPid.get(2)!.match).toBe('unknown');
    expect(byPid.get(2)!.sessionId).toBeNull();
  });

  // Bug 2: when the app itself launched a pid, an otherwise-ambiguous cwd
  // match resolves to a unique sessionId, using the launch timestamp
  // (src/main/sessions.ts's launchedAtForPid) to pick out the ONE candidate
  // whose earliest event lands at or after the launch -- a session that
  // predates the launch cannot be the one this pid just started. A second,
  // unlaunched pid sharing the exact same cwd must still report ambiguous:
  // this is not "cwd disambiguates now," only "a launched pid's OWN match
  // does."
  it("resolves a launched pid's ambiguous match to the one session started at or after its launch, while an unlaunched pid at the same cwd stays ambiguous", () => {
    const db = openDb(':memory:');
    const launchedAt = Date.parse(at(5)); // launched 5 minutes ago
    insertEvents(db, [
      // s1 already existed before this app-launched pid ever started.
      ev({ sessionId:'s1', kind:'session.started', ts:at(30), payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
      // s2 is the session the app actually launched -- its first event
      // lands after `launchedAt`.
      ev({ sessionId:'s2', kind:'session.started', ts:at(2), payload:{ cwd:'/repo/shared' }, contentHash:'b' }),
    ]);
    const open = openSessionsLive(db, [
      proc({ pid:100, cwd:'/repo/shared' }), // the app's own launched process
      proc({ pid:200, cwd:'/repo/shared' }), // some other, unlaunched process at the same cwd
    ], NOW, { launchedAtForPid: pid => (pid === 100 ? launchedAt : null) });

    const byPid = new Map(open.map(o => [o.pid, o]));
    expect(byPid.get(100)!.match).toBe('unique');
    expect(byPid.get(100)!.sessionId).toBe('s2');
    expect(byPid.get(200)!.match).toBe('ambiguous');
    expect(byPid.get(200)!.sessionId).toBeNull();
  });

  // Guards the "exactly one qualifying candidate" rule: if TWO sessions
  // both started at/after the launch (e.g. two launches back to back at
  // nearly the same moment), there is no way to tell them apart from the
  // launch timestamp alone -- this must stay ambiguous, not guess the
  // first one it finds.
  it('leaves the match ambiguous when the launch time fails to narrow it to exactly one candidate', () => {
    const db = openDb(':memory:');
    const launchedAt = Date.parse(at(10));
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', ts:at(5), payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', ts:at(2), payload:{ cwd:'/repo/shared' }, contentHash:'b' }),
    ]);
    const open = openSessionsLive(db, [
      proc({ pid:100, cwd:'/repo/shared' }),
    ], NOW, { launchedAtForPid: pid => (pid === 100 ? launchedAt : null) });

    expect(open[0]!.match).toBe('ambiguous');
    expect(open[0]!.sessionId).toBeNull();
  });

  // Bug 1: the general fallback for a pid this app did NOT launch (no
  // launchedAtForPid entry at all) -- an adopted session, or one started
  // in iTerm. Mirrors the real measurement that motivated this: a cwd
  // commonly has several recorded sessions but exactly one live process,
  // and `/clear` starts a new session id INSIDE that same process -- so
  // one process legitimately owns several ids across its life, and the
  // live one is simply the most recently active of the ones that began
  // at/after the process itself started. Three candidates: one predates
  // the process entirely (excluded outright), and two postdate it but
  // differ clearly in their own last activity -- proving the "most
  // recently active of the survivors" half of the rule, not just the
  // start-time filter.
  it("resolves an unlaunched pid's ambiguous match to the most recently active session that began at or after it started", () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      // Predates the process (started 10 min ago) by a wide margin --
      // excluded regardless of how active it later was.
      ev({ sessionId:'s_before', kind:'session.started', ts:at(30), payload:{ cwd:'/repo/live' }, contentHash:'a' }),
      // Started after the process (8 min ago), but its last activity is
      // older than the other survivor's.
      ev({ sessionId:'s_after_1', kind:'session.started', ts:at(8), payload:{ cwd:'/repo/live' }, contentHash:'b' }),
      ev({ sessionId:'s_after_1', kind:'turn.completed', ts:at(6), payload:{}, contentHash:'c', subIndex:1 }),
      // Started after the process too (4 min ago) -- and is the live
      // conversation right now, proven by being the more recently active
      // of the two survivors.
      ev({ sessionId:'s_after_2', kind:'session.started', ts:at(4), payload:{ cwd:'/repo/live' }, contentHash:'d' }),
      ev({ sessionId:'s_after_2', kind:'turn.completed', ts:at(1), payload:{}, contentHash:'e', subIndex:1 }),
    ]);
    const open = openSessionsLive(db, [proc({ pid:50, cwd:'/repo/live', ageSeconds:10 * 60 })], NOW);
    expect(open[0]!.match).toBe('unique');
    expect(open[0]!.sessionId).toBe('s_after_2');
  });

  // Rule 1: a SECOND live process at the same cwd must keep BOTH pids
  // ambiguous, even though one candidate clearly started after both --
  // with two live processes sharing a cwd there is no signal here that
  // tells the two apart, so guessing is refused. This is what actually
  // distinguishes the fallback from "cwd disambiguates once there's a
  // clear timing winner": the winner-picking logic above never even runs.
  it('stays ambiguous for both pids when a second live process shares the exact same cwd', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', ts:at(20), payload:{ cwd:'/repo/shared2' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', ts:at(2), payload:{ cwd:'/repo/shared2' }, contentHash:'b' }),
    ]);
    const open = openSessionsLive(db, [
      proc({ pid:60, cwd:'/repo/shared2', ageSeconds:5 * 60 }),
      proc({ pid:61, cwd:'/repo/shared2', ageSeconds:3 * 60 }),
    ], NOW);
    const byPid = new Map(open.map(o => [o.pid, o]));
    expect(byPid.get(60)!.match).toBe('ambiguous');
    expect(byPid.get(60)!.sessionId).toBeNull();
    expect(byPid.get(61)!.match).toBe('ambiguous');
    expect(byPid.get(61)!.sessionId).toBeNull();
  });

  // Isolates the start-time exclusion itself (rule 3), rather than just
  // asserting a final answer the "most recent survivor" logic (rule 2)
  // could produce on its own: s_predates started long before the process
  // AND is the more recently active of the two candidates by last event --
  // so picking by recency alone, without excluding it first, would name
  // s_predates. Only the exclusion filter running gets this right.
  it('excludes a candidate whose earliest event predates the process, even though it is the more recently active of the two', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      // Predates the process by a wide margin, but is still being used --
      // its own last activity is the most recent event in this fixture.
      ev({ sessionId:'s_predates', kind:'session.started', ts:at(30), payload:{ cwd:'/repo/excl' }, contentHash:'a' }),
      ev({ sessionId:'s_predates', kind:'turn.completed', ts:at(1), payload:{}, contentHash:'b', subIndex:1 }),
      // Started after the process (3 min ago, process started 5 min ago),
      // but its own last activity is older than s_predates' -- so it can
      // only win once s_predates is excluded on start time.
      ev({ sessionId:'s_after', kind:'session.started', ts:at(3), payload:{ cwd:'/repo/excl' }, contentHash:'c' }),
    ]);
    const open = openSessionsLive(db, [proc({ pid:70, cwd:'/repo/excl', ageSeconds:5 * 60 })], NOW);
    expect(open[0]!.match).toBe('unique');
    expect(open[0]!.sessionId).toBe('s_after');
  });

  // Rule 4: every candidate predates the process, so nothing survives the
  // filter -- this must fall back to the existing ambiguous result rather
  // than inventing an answer among candidates that cannot actually be it.
  it('falls back to ambiguous, rather than guessing, when every candidate predates the process', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', ts:at(40), payload:{ cwd:'/repo/stale' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', ts:at(35), payload:{ cwd:'/repo/stale' }, contentHash:'b' }),
    ]);
    const open = openSessionsLive(db, [proc({ pid:80, cwd:'/repo/stale', ageSeconds:5 * 60 })], NOW);
    expect(open[0]!.match).toBe('ambiguous');
    expect(open[0]!.sessionId).toBeNull();
  });

  // Rule 3: with no process age at all (ps failed to report elapsed time),
  // there is no start time to compare against -- must never guess one.
  it('leaves the match ambiguous when the process age itself is unknown, never treating a missing age as "started now"', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s_old', kind:'session.started', ts:at(20), payload:{ cwd:'/repo/noage' }, contentHash:'a' }),
      // Recorded essentially "now" -- if a missing ageSeconds were ever
      // treated as "the process started now" instead of "unknown", this
      // would wrongly look like the one candidate that qualifies.
      ev({ sessionId:'s_recent', kind:'session.started', ts:at(0), payload:{ cwd:'/repo/noage' }, contentHash:'b' }),
    ]);
    const open = openSessionsLive(db, [proc({ pid:90, cwd:'/repo/noage', ageSeconds:null })], NOW);
    expect(open[0]!.match).toBe('ambiguous');
    expect(open[0]!.sessionId).toBeNull();
  });

  // Rule 3's tolerance: `ps` reports elapsed time as whole, rounded
  // seconds while event timestamps carry millisecond precision, so a
  // candidate that actually belongs to this process can appear to have
  // started a couple of seconds "before" it. A clearly-stale second
  // candidate keeps this ambiguous at the classifyMatch level (so the
  // fallback actually runs), and only resolves to the near-edge one if
  // the tolerance correctly keeps it in.
  it('tolerates a few seconds of clock/rounding skew between the process start and a candidate\'s earliest event', () => {
    const db = openDb(':memory:');
    const nominalStart = NOW - 120_000; // ageSeconds:120 -> process started ~2 min ago
    insertEvents(db, [
      ev({
        sessionId:'s_old', kind:'session.started',
        ts:new Date(nominalStart - 60_000).toISOString(), payload:{ cwd:'/repo/skew' }, contentHash:'a',
      }),
      // 3s "before" the process's own rounded start -- within the 5s
      // tolerance this fallback allows for `ps`-vs-event skew.
      ev({
        sessionId:'s_edge', kind:'session.started',
        ts:new Date(nominalStart - 3_000).toISOString(), payload:{ cwd:'/repo/skew' }, contentHash:'b',
      }),
    ]);
    const open = openSessionsLive(db, [proc({ pid:95, cwd:'/repo/skew', ageSeconds:120 })], NOW);
    expect(open[0]!.match).toBe('unique');
    expect(open[0]!.sessionId).toBe('s_edge');
  });
});

describe('fleetState — sessionIds filter', () => {
  it('returns only the requested sessions when sessionIds is given', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', contentHash:'a' }),
      ev({ sessionId:'s2', contentHash:'b' }),
      ev({ sessionId:'s3', contentHash:'c' }),
    ]);
    const ids = fleetState(db, { now: NOW, sessionIds:['s1', 's3'] }).map(s => s.sessionId).sort();
    expect(ids).toEqual(['s1', 's3']);
  });

  it('returns nothing for an empty sessionIds array, without erroring', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ sessionId:'s1', contentHash:'a' })]);
    expect(fleetState(db, { now: NOW, sessionIds:[] })).toEqual([]);
  });

  // The property this whole option exists to preserve: worktree-sharing is
  // global (spec S9.5 is about real contention, which does not care
  // whether the OTHER session sharing a directory happens to be on this
  // page), so restricting the expensive per-row work to one session must
  // not blind that session to a sharer that got excluded.
  it('still reports sharesWorktreeWith from a session excluded by sessionIds', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', payload:{ cwd:'/shared' }, contentHash:'a', ts:at(1) }),
      ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/shared' }, contentHash:'b', ts:at(1) }),
    ]);
    // Only s1 requested -- s2 (the sharer) is deliberately excluded.
    const [s1] = fleetState(db, { now: NOW, sessionIds:['s1'] });
    expect(s1!.sharesWorktreeWith).toEqual(['s2']);
  });

  // Same property, for process matching: a live process's cwd is shared by
  // two sessions, only one of which is requested -- the match must still
  // come back 'ambiguous', not a false 'unique', because the excluded
  // sibling still exists and classifyMatch has to know about it.
  it('still reports an ambiguous match caused by a session excluded by sessionIds', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'s1', kind:'session.started', payload:{ cwd:'/shared' }, contentHash:'a' }),
      ev({ sessionId:'s2', kind:'session.started', payload:{ cwd:'/shared' }, contentHash:'b' }),
    ]);
    const proc = { pid:9, provider:'claude' as const, tty:null, cwd:'/shared', host:'unknown' as const, ageSeconds:null, rssBytes:null };
    const [s1] = fleetState(db, { now: NOW, sessionIds:['s1'], processes:[proc] });
    expect(s1!.match).toBe('ambiguous');
    expect(s1!.alive).toBe(false);
  });
});

describe('fleetStatePage', () => {
  // Measured against the real index: sessionSummaries costs ~130ms.
  // fleetStatePage needs it once to rank the page; fleetState (called
  // internally with sessionIds set) needs the same global context again
  // for matching/worktree-sharing -- without precomputedSummaries
  // threading the first result through, that is the same ~130ms query run
  // TWICE per page fetch for no new information. This spies on db.prepare
  // to prove it runs exactly once, not by guessing from timing (which is
  // too noisy on :memory: to assert on directly).
  it('runs the sessionSummaries query exactly once per page, not twice', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ sessionId:'s1', contentHash:'a' })]);
    const prepareSpy = vi.spyOn(db, 'prepare');
    fleetStatePage(db, 0, 10, { now: NOW });
    const summaryQueries = prepareSpy.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('MAX(ts) last_ts') && sql.includes("kind='session.started'")
      && !sql.includes('COUNT(*)'));
    expect(summaryQueries).toHaveLength(1);
    prepareSpy.mockRestore();
  });

  it('returns a page ordered newest-first, with the total session count', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'old', contentHash:'a', ts:at(30) }),
      ev({ sessionId:'mid', contentHash:'b', ts:at(20) }),
      ev({ sessionId:'new', contentHash:'c', ts:at(10) }),
    ]);
    const page = fleetStatePage(db, 0, 2, { now: NOW });
    expect(page.sessions.map(s => s.sessionId)).toEqual(['new', 'mid']);
    expect(page.total).toBe(3);
  });

  it('the next page picks up where the previous one left off, not from the start', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'old', contentHash:'a', ts:at(30) }),
      ev({ sessionId:'mid', contentHash:'b', ts:at(20) }),
      ev({ sessionId:'new', contentHash:'c', ts:at(10) }),
    ]);
    const page2 = fleetStatePage(db, 2, 2, { now: NOW });
    expect(page2.sessions.map(s => s.sessionId)).toEqual(['old']);
    expect(page2.total).toBe(3);
  });

  it('returns an empty page (not an error) once offset is past the end, with the real total', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ sessionId:'s1', contentHash:'a' })]);
    const page = fleetStatePage(db, 10, 5, { now: NOW });
    expect(page.sessions).toEqual([]);
    expect(page.total).toBe(1);
  });

  // The global-context property (see the fleetState describe block above),
  // proven end to end through the pagination entry point: two sessions
  // share a directory but a page of size 1 can only ever return one of
  // them -- the one it does return must still know about its sharer.
  it('a session on one page still reports sharing a directory with a session on another page', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'newer', kind:'session.started', payload:{ cwd:'/shared' }, contentHash:'a', ts:at(5) }),
      ev({ sessionId:'older', kind:'session.started', payload:{ cwd:'/shared' }, contentHash:'b', ts:at(10) }),
    ]);
    const page = fleetStatePage(db, 0, 1, { now: NOW });
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]!.sessionId).toBe('newer');
    expect(page.sessions[0]!.sharesWorktreeWith).toEqual(['older']);
    expect(page.total).toBe(2);
  });

  // The assertion that actually catches an unstable sort: with an ORDER BY
  // that isn't a total order (recency alone, with no tiebreaker), two
  // sessions sharing the exact same timestamp -- provider timestamps are
  // not guaranteed unique to the millisecond -- have no defined relative
  // order across the SEPARATE calls to sessionSummaries that page N and
  // page N+1 each make; whichever way that tie happens to fall can drop a
  // row (missing from both pages) or duplicate one (present in both).
  // Five sessions, all sharing one timestamp, split across three pages of
  // two: the union of every page must be exactly the five ids, no more, no
  // fewer, each exactly once.
  it('the union of consecutive pages has no duplicate and no gap, even when every timestamp ties', () => {
    const db = openDb(':memory:');
    const tied = at(1); // identical for every session below
    insertEvents(db, ['a', 'b', 'c', 'd', 'e'].map(id =>
      ev({ sessionId: id, contentHash: id, ts: tied })));

    const page1 = fleetStatePage(db, 0, 2, { now: NOW });
    const page2 = fleetStatePage(db, 2, 2, { now: NOW });
    const page3 = fleetStatePage(db, 4, 2, { now: NOW });
    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page3.total).toBe(5);

    const seen = [...page1.sessions, ...page2.sessions, ...page3.sessions].map(s => s.sessionId);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Not just the right set -- each exactly once (a set comparison alone
    // would not catch 'a' appearing on two pages while 'e' appears on none).
    expect(seen).toHaveLength(5);

    // Same ranking, called twice independently, agrees with itself --
    // the direct proof that the ordering is deterministic, not merely
    // "happened to work" for this particular set of three page calls.
    const rePage1 = fleetStatePage(db, 0, 2, { now: NOW });
    expect(rePage1.sessions.map(s => s.sessionId)).toEqual(page1.sessions.map(s => s.sessionId));
  });

  // The test above proves pagination is correct AGAINST THIS SQLite
  // engine, which -- checked empirically while building this -- happens to
  // return the exact same row order on repeated, unchanged queries against
  // unchanged :memory: data, tiebreaker or not. SQL makes no such
  // guarantee absent an ORDER BY, so that is an implementation detail, not
  // something this codebase controls or should rely on. This test forces
  // the actual failure mode directly: it makes the underlying query return
  // the tied pair in one order for the first page call and the reverse
  // order for the second, exactly what a real engine would be free to do,
  // and checks the tiebreaker (session_id) still resolves both calls to
  // the same total order.
  it('resolves ties to the same order even if the underlying query returns them differently between calls', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ sessionId:'a', contentHash:'a', ts: at(1) }),
      ev({ sessionId:'b', contentHash:'b', ts: at(1) }), // tied with 'a'
    ]);

    const isSummaryQuery = (sql: string) =>
      sql.includes('MAX(ts) last_ts') && sql.includes("kind='session.started'") && !sql.includes('COUNT(*)');
    const realPrepare = db.prepare.bind(db);
    let summaryCalls = 0;
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (!isSummaryQuery(sql)) return stmt;
      summaryCalls++;
      const callNumber = summaryCalls;
      return { ...stmt, all: (...args: unknown[]) => {
        const rows = stmt.all(...args) as unknown[];
        // Second call sees the tied pair in the opposite order from the
        // first -- simulating exactly what "no ORDER BY guarantee" allows.
        return callNumber === 2 ? [...rows].reverse() : rows;
      } } as unknown as ReturnType<typeof db.prepare>;
    }) as typeof db.prepare);

    const page1 = fleetStatePage(db, 0, 1, { now: NOW }); // first summary call: natural order
    const page2 = fleetStatePage(db, 1, 1, { now: NOW }); // second summary call: reversed
    vi.restoreAllMocks();

    // Without the tiebreaker, the reversed second call would rank 'b'
    // ahead of 'a', making page2 return 'a' again (a duplicate) instead
    // of the id page1 didn't already return.
    const ids = [page1.sessions[0]!.sessionId, page2.sessions[0]!.sessionId];
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
