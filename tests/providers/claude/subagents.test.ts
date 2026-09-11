import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSubagents, parseAgentMeta } from '../../../src/providers/claude/subagents.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sub-'));
  const dir = join(root, 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-task-8-magiclink-abc.jsonl'), '');
  writeFileSync(join(dir, 'agent-task-8-magiclink-abc.meta.json'), JSON.stringify({
    agentType: 'task-8-magiclink', description: 'Wire magic link', name: 'task-8-magiclink',
    spawnDepth: 0, model: 'opus', taskKind: 'in_process_teammate',
    teamName: 'session-f3f59130', color: 'yellow',
  }));
  writeFileSync(join(dir, 'orphan.meta.json'), '{"name":"orphan","spawnDepth":0}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findSubagents', () => {
  it('pairs each transcript with its meta file', () => {
    const found = findSubagents(join(root, 'session-1'));
    expect(found).toHaveLength(1);
    expect(found[0]!.agentId).toBe('agent-task-8-magiclink-abc');
    expect(found[0]!.metaPath).toContain('agent-task-8-magiclink-abc.meta.json');
  });

  it('ignores a meta file with no matching transcript', () => {
    const found = findSubagents(join(root, 'session-1'));
    expect(found.map(f => f.agentId)).not.toContain('orphan');
  });

  it('returns empty for a session with no subagents directory', () => {
    expect(findSubagents(join(root, 'no-such-session'))).toEqual([]);
  });
});

describe('parseAgentMeta', () => {
  it('produces an agent.spawned event carrying the graph fields', () => {
    const meta = {
      agentType: 'final-review', name: 'final-review', spawnDepth: 0,
      model: 'opus', color: 'blue', taskKind: 'in_process_teammate',
      teamName: 'session-f3f59130',
    };
    const e = parseAgentMeta(meta, '/m.meta.json', 's1', 'agent-final-review-x',
      '2026-09-10T00:00:00Z');
    expect(e.kind).toBe('agent.spawned');
    expect(e.agentId).toBe('agent-final-review-x');
    expect(e.payload).toMatchObject({
      name: 'final-review', type: 'final-review', model: 'opus',
      color: 'blue', depth: 0, parentAgentId: null,
    });
    // Runtime check, not just a type-level one: this field's absence was
    // the worst defect in this plan (colliding identity keys, silently
    // dropped events).
    expect(e.subIndex).toBe(0);
  });

  it('defaults depth to 0 when spawnDepth is absent', () => {
    const e = parseAgentMeta({ name: 'x' }, '/m.meta.json', 's1', 'a1', 'ts');
    expect(e.payload.depth).toBe(0);
  });
});
