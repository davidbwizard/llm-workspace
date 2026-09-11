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
