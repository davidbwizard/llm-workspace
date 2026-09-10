import { hashRecord } from '../../core/identity.ts';
import type { NormalizedEvent } from '../../core/types.ts';
import type { TailLine } from '../claude/tail.ts';

export const CODEX_PARSER_VERSION = 1;

/** Codex separates prose from tool calls explicitly, so this mapping is
 *  exact rather than heuristic — contrast the Claude parser's isHumanPrompt
 *  heuristic. Spec §5.5, §8.3. */
const KNOWN_EVENT_MSG = new Set([
  'task_started', 'task_complete', 'user_message', 'agent_message',
  'token_count', 'agent_reasoning', 'error',
]);
const KNOWN_RESPONSE_ITEM = new Set([
  'message', 'function_call', 'function_call_output', 'reasoning',
]);

export function parseCodexLines(lines: TailLine[], sourceFile: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  let sessionId = 'unknown';

  // Codex has no per-record agentId field the way Claude does. A subagent
  // thread is a whole separate rollout file whose own session_meta names
  // its thread id; every event in that file belongs to that agent until
  // (if ever) a later session_meta says otherwise. Spec §6.4: agent-scoped
  // kinds use NULL for the root/director, so a root thread's events keep
  // agentId null and only a genuine subagent thread sets it.
  let threadAgentId: string | null = null;

  // sub_index disambiguates sibling events emitted from the same source
  // line (same offset and content hash) — see schema.ts events_identity.
  // `base` is given the current ordinal and bumps it for the next call.
  let subIndex = 0;
  const base = (line: TailLine, kind: NormalizedEvent['kind'],
                payload: Record<string, unknown>, ts: string,
                agentId: string | null, nativeId: string | null): NormalizedEvent => ({
    provider: 'codex', sessionId, runId: null, agentId, ts, kind, payload,
    nativeId, sourceFile, sourceOffset: line.offset,
    contentHash: hashRecord(line.text), subIndex: subIndex++,
    parserVersion: CODEX_PARSER_VERSION,
  });

  for (const line of lines) {
    subIndex = 0;
    let rec: any;
    try {
      rec = JSON.parse(line.text);
    } catch {
      out.push(base(line, 'unparsed', { reason: 'invalid-json', raw: line.text.slice(0, 500) },
        new Date(0).toISOString(), threadAgentId, null));
      continue;
    }

    const ts = typeof rec?.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString();
    const p = rec?.payload ?? {};

    if (rec?.type === 'session_meta') {
      sessionId = typeof p.session_id === 'string' ? p.session_id : sessionId;
      const threadId = typeof p.id === 'string' ? p.id : sessionId;

      // Spec §5.5: parent_thread_id + source.subagent give the spawn tree.
      // A thread that names itself as its own parent is a root session,
      // not a child of itself.
      const isSubagent = typeof p.parent_thread_id === 'string' && p.parent_thread_id !== threadId;
      threadAgentId = isSubagent ? threadId : null;

      out.push(base(line, 'session.started', {
        provider: 'codex', cwd: p.cwd ?? null, originator: p.originator ?? null,
        cliVersion: p.cli_version ?? null, model: p.model ?? null,
        threadSource: p.thread_source ?? null,
      }, ts, null, threadId));

      if (isSubagent) {
        const roleObj = p.source?.subagent;
        const role = roleObj && typeof roleObj === 'object'
          ? String(Object.values(roleObj)[0] ?? 'subagent')
          : 'subagent';
        out.push(base(line, 'agent.spawned', {
          name: role, type: p.thread_source ?? null, model: p.model ?? null,
          color: null, depth: 1, parentAgentId: p.parent_thread_id,
        }, ts, threadAgentId, threadId));
      }
      continue;
    }

    if (rec?.type === 'event_msg') {
      if (!KNOWN_EVENT_MSG.has(p.type)) {
        out.push(base(line, 'unparsed',
          { reason: 'unknown-event-msg', recordType: p.type }, ts, threadAgentId, null));
        continue;
      }
      switch (p.type) {
        case 'user_message':
          // Do not also emit this from response_item `message` records
          // below: event_msg/user_message is the single source of truth
          // for a submitted prompt, or every human turn double-counts.
          out.push(base(line, 'prompt.submitted', { text: p.message ?? '' },
            ts, threadAgentId, null));
          break;
        case 'agent_message':
          out.push(base(line, 'prose', { text: p.message ?? '', role: 'assistant' },
            ts, threadAgentId, null));
          break;
        case 'task_complete': {
          const started = typeof p.started_at === 'number' ? p.started_at : null;
          const done = typeof p.completed_at === 'number' ? p.completed_at : null;
          out.push(base(line, 'turn.completed', {
            durationMs: started && done ? (done - started) * 1000 : null,
            turnId: p.turn_id ?? null,
          }, ts, threadAgentId, p.turn_id ?? null));
          break;
        }
        default:
          break; // task_started, token_count, agent_reasoning, error: known, not mapped in v1
      }
      continue;
    }

    if (rec?.type === 'response_item') {
      if (!KNOWN_RESPONSE_ITEM.has(p.type)) {
        out.push(base(line, 'unparsed',
          { reason: 'unknown-response-item', recordType: p.type }, ts, threadAgentId, null));
        continue;
      }
      if (p.type === 'function_call') {
        out.push(base(line, 'tool.used', {
          name: p.name ?? null, target: p.arguments ?? null, isError: false,
          toolUseId: p.call_id ?? null,
        }, ts, threadAgentId, p.call_id ?? null));
      }
      // `message` is intentionally skipped: event_msg/user_message and
      // event_msg/agent_message already carry the human and assistant
      // text, so emitting this too would double-count every turn.
      continue;
    }

    out.push(base(line, 'unparsed', { reason: 'unknown-record-type', recordType: rec?.type },
      ts, threadAgentId, null));
  }

  return out;
}
