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
});
