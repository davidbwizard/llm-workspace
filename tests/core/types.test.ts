import { describe, it, expect } from 'vitest';
import { EVENT_KINDS, isEventKind } from '../../src/core/types.ts';

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
