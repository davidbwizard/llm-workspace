import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexLines } from '../../../src/providers/codex/parse.ts';
import type { TailLine } from '../../../src/providers/claude/tail.ts';

function linesOf(fixture: string): TailLine[] {
  const raw = readFileSync(join('tests/fixtures/codex', fixture), 'utf8');
  const out: TailLine[] = [];
  let offset = 0;
  for (const text of raw.split('\n')) {
    if (text.trim()) out.push({ text, offset });
    offset += Buffer.byteLength(text, 'utf8') + 1;
  }
  return out;
}

describe('parseCodexLines', () => {
  const events = parseCodexLines(linesOf('rollout-basic.jsonl'), '/r.jsonl');

  it('emits session.started from session_meta with cwd and host', () => {
    const s = events.filter(e => e.kind === 'session.started');
    expect(s).toHaveLength(1);
    expect(s[0]!.payload).toMatchObject({
      provider: 'codex', cwd: '/repo', originator: 'Codex Desktop', cliVersion: '0.152.1',
    });
    expect(s[0]!.sessionId).toBe('01a0835e-cda1');
  });

  it('maps user_message to prompt.submitted', () => {
    const p = events.filter(e => e.kind === 'prompt.submitted');
    expect(p).toHaveLength(1);
    expect(p[0]!.payload.text).toBe('Review this change for security vulnerabilities.');
  });

  it('maps agent_message to prose — the noise-free narration stream', () => {
    const p = events.filter(e => e.kind === 'prose');
    expect(p).toHaveLength(1);
    expect(p[0]!.payload.text).toBe('Tracing user-controlled inputs to sinks.');
  });

  it('maps function_call to tool.used', () => {
    const t = events.filter(e => e.kind === 'tool.used');
    expect(t).toHaveLength(1);
    expect(t[0]!.payload).toMatchObject({ name: 'shell' });
  });

  it('maps task_complete to turn.completed', () => {
    const t = events.filter(e => e.kind === 'turn.completed');
    expect(t).toHaveLength(1);
  });

  it('does NOT emit prompt.submitted for response_item message records (no double count)', () => {
    const prompts = events.filter(e => e.kind === 'prompt.submitted');
    expect(prompts).toHaveLength(1);
  });

  it('reads parent_thread_id and subagent role as agent.spawned', () => {
    const evs = parseCodexLines(linesOf('rollout-subagent.jsonl'), '/r2.jsonl');
    const spawned = evs.filter(e => e.kind === 'agent.spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.payload).toMatchObject({
      parentAgentId: '01a043c5-f268', name: 'guardian', depth: 1,
    });
  });

  it('stores an unknown payload type as unparsed', () => {
    const evs = parseCodexLines([{
      text: '{"timestamp":"t","type":"event_msg","payload":{"type":"brand_new_thing"}}',
      offset: 0,
    }], '/r.jsonl');
    expect(evs.filter(e => e.kind === 'unparsed')).toHaveLength(1);
  });

  it('assigns a distinct subIndex per event sharing a source line', () => {
    const pairs = events.map(e => `${e.sourceOffset}:${e.subIndex}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('restarts subIndex at 0 for each new source line', () => {
    const byOffset = new Map<number, number[]>();
    for (const e of events) {
      const list = byOffset.get(e.sourceOffset) ?? [];
      list.push(e.subIndex);
      byOffset.set(e.sourceOffset, list);
    }
    for (const subIndices of byOffset.values()) {
      expect(subIndices[0]).toBe(0);
      expect(subIndices).toEqual(subIndices.map((_, i) => i));
    }
  });

  it('a session_meta line for a subagent emits TWO events (session.started, agent.spawned) with subIndex 0 and 1', () => {
    const evs = parseCodexLines(linesOf('rollout-subagent.jsonl'), '/r2.jsonl');
    const fromMeta = evs.filter(e => e.sourceOffset === 0);
    expect(fromMeta.map(e => e.kind)).toEqual(['session.started', 'agent.spawned']);
    expect(fromMeta.map(e => e.subIndex)).toEqual([0, 1]);
  });

  // Defect found while implementing: the brief's draft hardcoded agentId to
  // null for every event_msg/response_item-derived event, even inside a
  // subagent thread's own rollout file. Codex carries no per-record agentId
  // field (unlike Claude's rec.agentId), so without this a subagent's prose
  // and tool calls would be indistinguishable from the root/director's own
  // events once ingested (spec §6.4: agent-scoped kinds, NULL = root only).
  // sessionId still points at the shared root session id (spec §6.3: one
  // session spans its subagent threads) while agentId identifies the thread.
  it('attributes events after a subagent session_meta to that agent, not the root', () => {
    const evs = parseCodexLines(linesOf('rollout-subagent.jsonl'), '/r2.jsonl');
    const prose = evs.find(e => e.kind === 'prose');
    expect(prose).toBeDefined();
    expect(prose!.agentId).toBe('01a043c7-0799');
    expect(prose!.sessionId).toBe('01a043c5-f268');
  });

  it('leaves agentId null for events in a root thread file (no parent_thread_id)', () => {
    for (const e of events) {
      if (e.kind === 'session.started') continue;
      expect(e.agentId).toBeNull();
    }
  });
});
