import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { latestSignals, openBlockers } from '../../src/store/signals.ts';

// Relative to "now" rather than a fixed calendar date: openBlockers bounds
// its scan to a trailing window (default 24h), so fixtures pinned to a
// literal date would silently fall outside that window and start failing
// the moment the wall clock moves past it.
const at = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();

function drop(db: any, o: Partial<Record<string, unknown>>) {
  db.prepare(`INSERT INTO signal_events
    (event_id, occurred_at, ingested_at, provider, session_id, prompt_id, tool_use_id, kind, payload)
    VALUES (@event_id,@occurred_at,@ingested_at,@provider,@session_id,@prompt_id,@tool_use_id,@kind,@payload)`)
    .run({ event_id:'e', occurred_at: at(0), ingested_at: at(0),
           provider:'claude', session_id:'s1', prompt_id:null, tool_use_id:null,
           kind:'Stop', payload:'{}', ...o });
}

describe('latestSignals', () => {
  it('orders by when the hook fired, not when we ingested it', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'a', occurred_at: at(5), ingested_at: at(600) });
    drop(db, { event_id:'b', occurred_at: at(9), ingested_at: at(300) });
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
    drop(db, { event_id:'p2', kind:'PostToolUse', tool_use_id:'t1', occurred_at: at(30) });
    expect(openBlockers(db)).toHaveLength(0);
  });

  it('does NOT clear a blocker on an unrelated later signal', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'p1', kind:'PermissionRequest', tool_use_id:'t1' });
    drop(db, { event_id:'x', kind:'Stop', tool_use_id:null, occurred_at: at(30) });
    expect(openBlockers(db)).toHaveLength(1);
  });

  it('treats idle_prompt as idle, never as a blocker', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'n1', kind:'Notification',
               payload: JSON.stringify({ notificationType:'idle_prompt' }) });
    expect(openBlockers(db)).toHaveLength(0);
  });

  it('excludes a signal older than the window, keeps one inside it', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'old', kind:'PermissionRequest', tool_use_id:'t-old', occurred_at: at(-5) });
    drop(db, { event_id:'fresh', kind:'PermissionRequest', tool_use_id:'t-fresh', occurred_at: at(0) });
    const ids = openBlockers(db, 1000).map(b => b.toolUseId);
    expect(ids).toEqual(['t-fresh']);
  });

  it('clears every blocker in a session on SessionEnd, regardless of tool_use_id', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'p1', kind:'PermissionRequest', tool_use_id:'t1' });
    drop(db, { event_id:'se1', kind:'SessionEnd', tool_use_id:null, occurred_at: at(30) });
    expect(openBlockers(db)).toHaveLength(0);
  });

  it('does NOT clear a blocker when SessionEnd belongs to a different session', () => {
    const db = openDb(':memory:');
    drop(db, { event_id:'p1', kind:'PermissionRequest', tool_use_id:'t1', session_id:'s1' });
    drop(db, { event_id:'se1', kind:'SessionEnd', tool_use_id:null, session_id:'s2', occurred_at: at(30) });
    expect(openBlockers(db)).toHaveLength(1);
  });
});
