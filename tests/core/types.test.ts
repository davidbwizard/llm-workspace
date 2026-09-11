import { describe, it, expect } from 'vitest';
import { EVENT_KINDS, isEventKind, type TailLine, type RunRef } from '../../src/core/types.ts';

describe('event kinds', () => {
  it('includes every kind the spec defines', () => {
    expect(EVENT_KINDS).toEqual([
      'session.started', 'run.started', 'run.ended', 'context.compacted',
      'control.attached', 'control.detached', 'prompt.submitted',
      'turn.completed', 'agent.spawned', 'agent.ended', 'prose',
      'tool.used', 'cwd.changed', 'state.changed', 'unparsed',
    ]);
  });

  it('rejects a kind that is not in the vocabulary', () => {
    expect(isEventKind('session.ended')).toBe(false);
    expect(isEventKind('run.ended')).toBe(true);
  });
});

describe('shared types', () => {
  it('exposes TailLine from core, not from a provider module', () => {
    const line: TailLine = { text: '{}', offset: 0 };
    expect(line).toEqual({ text: '{}', offset: 0 });
  });

  it('models a run as its own identity', () => {
    const run: RunRef = {
      runId: 'r1', sessionId: 's1', startedAt: '2026-09-10T00:00:00Z',
      endedAt: null, source: 'startup', endReason: null,
    };
    expect(run.sessionId).toBe('s1');
    expect(run.endedAt).toBeNull();
  });
});
