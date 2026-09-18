import { describe, it, expect } from 'vitest';
import { codexBusyFromTail, isCodexBusy, rolloutPathFor, ROLLOUT_TAIL_BYTES } from '../../src/main/codexBusy.ts';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

const line = (type: string, turn = 't1') =>
  JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turn } });

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return { provider:'claude', sessionId:'s1', runId:null, agentId:null,
    ts:'2026-09-17T04:00:00.000Z', kind:'prose', payload:{}, nativeId:null,
    sourceFile:'/tmp/test.jsonl', sourceOffset:0, contentHash:'h1', subIndex:0,
    parserVersion:3, ...o } as NormalizedEvent;
}

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

  it('tracks state across multiple turns, returning the state of the last boundary event', () => {
    const tail = [
      line('task_started'),
      line('task_complete'),
      line('task_started'),
      line('token_count'),
    ].join('\n');
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
    insertEvents(db, [ev({
      sessionId: 's1', provider: 'codex', ts: '2026-09-17T04:00:00.000Z',
      kind: 'prompt.submitted', payload: { text: 'hi' }, sourceFile: '/tmp/gone.jsonl',
      sourceOffset: 0, contentHash: 'h1', subIndex: 0, parserVersion: 3, agentId: null,
    })]);
    expect(isCodexBusy(db, 's1', () => { throw new Error('ENOENT'); })).toBe(null);
  });

  it('resolves to the root thread rollout path, not a subagent thread that shares the session id', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({
        sessionId: 's1', agentId: null, sourceFile: '/root.jsonl',
        ts: '2026-09-17T04:00:00.000Z', contentHash: 'h1',
      }),
      ev({
        sessionId: 's1', agentId: 'agent-thread-1', sourceFile: '/subagent.jsonl',
        ts: '2026-09-17T04:00:01.000Z', contentHash: 'h2',
      }),
    ]);
    expect(rolloutPathFor(db, 's1')).toBe('/root.jsonl');
  });
});
