import { hashRecord } from '../../core/identity.ts';
import type { NormalizedEvent } from '../../core/types.ts';
import type { TailLine } from './tail.ts';

export const CLAUDE_PARSER_VERSION = 1;

/** Record types this parser understands. Anything else becomes `unparsed`
 *  so format drift surfaces instead of vanishing (spec §6.2). */
const KNOWN_TYPES = new Set(['user', 'assistant', 'ai-title', 'last-prompt', 'summary']);

/** Spec §8.3. Claude records TOOL RESULTS as `type: "user"` messages.
 *  Measured on a real transcript: 58 of 73 `user` records were tool_result.
 *  Bounding beats on any `user` record produced ~73 beats where there were
 *  ~15 human turns. A record is a human prompt only if its content is a
 *  plain string, or an array containing NO tool_result block. */
export function isHumanPrompt(record: any): boolean {
  const c = record?.message?.content;
  if (typeof c === 'string') return true;
  if (!Array.isArray(c)) return false;
  return !c.some((b: any) => b && b.type === 'tool_result');
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

function toolTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const k of ['file_path', 'path', 'command', 'pattern', 'notebook_path']) {
    if (typeof i[k] === 'string') return i[k] as string;
  }
  return null;
}

export function parseClaudeLines(lines: TailLine[], sourceFile: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  let sessionId = 'unknown';
  let sessionStartEmitted = false;

  const base = (line: TailLine, kind: NormalizedEvent['kind'],
                payload: Record<string, unknown>, agentId: string | null,
                ts: string, nativeId: string | null): NormalizedEvent => ({
    provider: 'claude', sessionId, runId: null, agentId, ts, kind, payload,
    nativeId, sourceFile, sourceOffset: line.offset,
    contentHash: hashRecord(line.text), parserVersion: CLAUDE_PARSER_VERSION,
  });

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line.text);
    } catch {
      out.push(base(line, 'unparsed', { reason: 'invalid-json', raw: line.text.slice(0, 500) },
        null, new Date(0).toISOString(), null));
      continue;
    }
    if (!rec || typeof rec !== 'object') {
      out.push(base(line, 'unparsed', { reason: 'not-an-object' }, null,
        new Date(0).toISOString(), null));
      continue;
    }

    if (typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString();
    const agentId = typeof rec.agentId === 'string' ? rec.agentId : null;

    if (!KNOWN_TYPES.has(rec.type)) {
      out.push(base(line, 'unparsed', { reason: 'unknown-record-type', recordType: rec.type },
        agentId, ts, typeof rec.uuid === 'string' ? rec.uuid : null));
      continue;
    }

    if (!sessionStartEmitted && typeof rec.cwd === 'string') {
      out.push(base(line, 'session.started', {
        provider: 'claude', cwd: rec.cwd,
        gitBranch: rec.gitBranch ?? null, cliVersion: rec.version ?? null,
      }, null, ts, null));
      sessionStartEmitted = true;
    }

    if (rec.type === 'user') {
      if (isHumanPrompt(rec)) {
        out.push(base(line, 'prompt.submitted',
          { text: textFromContent(rec.message.content) || String(rec.message.content) },
          agentId, ts, rec.uuid ?? null));
      }
      continue;
    }

    if (rec.type === 'assistant') {
      const content = rec.message?.content;
      const text = textFromContent(content);
      if (text) out.push(base(line, 'prose', { text, role: 'assistant' }, agentId, ts, rec.uuid ?? null));

      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_use') {
            out.push(base(line, 'tool.used', {
              name: b.name ?? null, target: toolTarget(b.input), isError: false,
              toolUseId: b.id ?? null,
            }, agentId, ts, b.id ?? null));
          }
        }
      }

      const u = rec.message?.usage;
      if (u) {
        out.push(base(line, 'turn.completed', {
          inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          model: rec.message?.model ?? null,
        }, agentId, ts, rec.uuid ?? null));
      }
    }
  }

  return out;
}
