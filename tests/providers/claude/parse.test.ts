import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeLines, isHumanPrompt } from '../../../src/providers/claude/parse.ts';
import type { TailLine } from '../../../src/providers/claude/tail.ts';

function linesOf(fixture: string): TailLine[] {
  const raw = readFileSync(join('tests/fixtures/claude', fixture), 'utf8');
  const out: TailLine[] = [];
  let offset = 0;
  for (const text of raw.split('\n')) {
    if (text.trim()) out.push({ text, offset });
    offset += Buffer.byteLength(text, 'utf8') + 1;
  }
  return out;
}

describe('isHumanPrompt', () => {
  it('accepts a plain string content', () => {
    expect(isHumanPrompt({ message: { content: 'hello' } })).toBe(true);
  });

  it('REJECTS a tool_result — the revision-1 bug', () => {
    expect(isHumanPrompt({ message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }))
      .toBe(false);
  });

  it('accepts a text block array', () => {
    expect(isHumanPrompt({ message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(true);
  });

  it('accepts an image plus text array', () => {
    expect(isHumanPrompt({ message: { content: [
      { type: 'image', source: {} }, { type: 'text', text: 'look' },
    ] } })).toBe(true);
  });

  it('rejects a mixed array containing any tool_result', () => {
    expect(isHumanPrompt({ message: { content: [
      { type: 'text', text: 'hi' }, { type: 'tool_result', tool_use_id: 't' },
    ] } })).toBe(false);
  });
});

describe('parseClaudeLines', () => {
  const events = parseClaudeLines(linesOf('basic.jsonl'), '/f.jsonl');

  it('emits exactly two prompt.submitted events, not five', () => {
    const prompts = events.filter(e => e.kind === 'prompt.submitted');
    expect(prompts).toHaveLength(2);
    expect(prompts.map(p => p.payload.text)).toEqual([
      'Wire up magic-link auth.', 'Set it to 15 minutes.',
    ]);
  });

  it('emits session.started once, from the first record carrying cwd', () => {
    const started = events.filter(e => e.kind === 'session.started');
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ provider: 'claude', cwd: '/repo' });
  });

  it('emits prose for assistant text blocks', () => {
    const prose = events.filter(e => e.kind === 'prose');
    expect(prose.map(p => p.payload.text)).toEqual([
      'Reusing the existing JWT helper.', 'The magic link has no expiry.',
    ]);
  });

  it('emits tool.used with name and target', () => {
    const tools = events.filter(e => e.kind === 'tool.used');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.payload).toMatchObject({ name: 'Read', target: '/repo/src/auth.js' });
  });

  it('emits turn.completed with token counts', () => {
    const turns = events.filter(e => e.kind === 'turn.completed');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.payload).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('carries the source offset and content hash on every event', () => {
    for (const e of events) {
      expect(e.sourceFile).toBe('/f.jsonl');
      expect(e.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.sourceOffset).toBe('number');
    }
  });

  it('stores an unknown record type as unparsed rather than dropping it', () => {
    const evs = parseClaudeLines(linesOf('unknown-record.jsonl'), '/f.jsonl');
    const unparsed = evs.filter(e => e.kind === 'unparsed');
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]!.payload).toMatchObject({ recordType: 'telemetry-v9' });
  });

  it('silences a known-but-unmapped record type -- no event at all, not even unparsed', () => {
    const evs = parseClaudeLines(
      [{ text: JSON.stringify({ type: 'attachment', sessionId: 's1', timestamp: '2026-09-10T00:00:00.000Z' }), offset: 0 }],
      '/f.jsonl',
    );
    expect(evs).toHaveLength(0);
  });

  it('still reports a genuinely unrecognized type as unparsed -- recognising the known-unmapped set does not blunt the drift signal', () => {
    const evs = parseClaudeLines(linesOf('unknown-record.jsonl'), '/f.jsonl');
    const unparsed = evs.filter(e => e.kind === 'unparsed');
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]!.payload).toMatchObject({ recordType: 'telemetry-v9' });
  });

  it('stores a corrupt line as unparsed rather than throwing', () => {
    const evs = parseClaudeLines([{ text: 'not json at all', offset: 0 }], '/f.jsonl');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.kind).toBe('unparsed');
  });

  it('emits 8 events from basic.jsonl, each with a distinct (sourceOffset, subIndex) pair', () => {
    expect(events).toHaveLength(8);
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
});
