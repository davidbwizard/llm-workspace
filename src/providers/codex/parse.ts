import { hashRecord } from '../../core/identity.ts';
import type { NormalizedEvent, ParseResumeContext } from '../../core/types.ts';
import type { TailLine } from '../claude/tail.ts';

export const CODEX_PARSER_VERSION = 1;

/** Codex separates prose from tool calls explicitly, so this mapping is
 *  exact rather than heuristic — contrast the Claude parser's isHumanPrompt
 *  heuristic. Spec §5.5, §8.3. */
const KNOWN_EVENT_MSG = new Set([
  'task_started', 'task_complete', 'user_message', 'agent_message',
  'token_count', 'agent_reasoning', 'error',
  // Spec §5.6: the item_completed envelope, and a settings record that is
  // known but not mapped in v1.
  'item_completed', 'thread_settings_applied',
]);
const KNOWN_RESPONSE_ITEM = new Set([
  'message', 'function_call', 'function_call_output', 'reasoning',
  // Spec §5.6: known but not mapped — custom_tool_call is the request half
  // of a tool call whose completion is already counted via item_completed
  // (see the comment where response_item is handled below); mapping it too
  // double-counts every tool invocation.
  'custom_tool_call', 'custom_tool_call_output',
]);

/** Top-level record types, sibling to session_meta/event_msg/response_item,
 *  that Codex writes but this parser does not map in v1. Recognised so they
 *  do not flood the unparsed channel (spec §5.6). */
const KNOWN_TOP_LEVEL_UNMAPPED = new Set(['turn_context', 'world_state', 'compacted']);

/** Text blocks inside an `item_completed` item's `content[]`. Measured on
 *  real transcripts: AgentMessage blocks carry `{type:"Text", ...}`,
 *  UserMessage blocks carry `{type:"text", ...}` — same field, inconsistent
 *  case — so this matches case-insensitively rather than trusting one spelling. */
function itemText(item: any): string {
  const content = item?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && typeof b.text === 'string' && typeof b.type === 'string'
      && b.type.toLowerCase() === 'text')
    .map((b: any) => b.text)
    .join('\n');
}

export function parseCodexLines(
  lines: TailLine[], sourceFile: string, resume?: ParseResumeContext,
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  // B2: session_meta -- the only source of sessionId -- occurs once, at
  // byte 0. A tail chunk resumed mid-file never sees it again, so without
  // seeding from the resume context every event in that chunk parsed to
  // sessionId "unknown". Falls back to 'unknown' exactly as before when
  // `resume` is undefined (a from-zero parse).
  let sessionId = resume?.sessionId ?? 'unknown';

  // Codex has no per-record agentId field the way Claude does. A subagent
  // thread is a whole separate rollout file whose own session_meta names
  // its thread id; every event in that file belongs to that agent until
  // (if ever) a later session_meta says otherwise. Spec §6.4: agent-scoped
  // kinds use NULL for the root/director, so a root thread's events keep
  // agentId null and only a genuine subagent thread sets it.
  //
  // Resumed the same way as sessionId, and for the same reason: a
  // subagent's own rollout file sets this once from its own session_meta,
  // at byte 0 -- a tail chunk that never sees that line again must not
  // fall back to null and misattribute the rest of the file to the root.
  let threadAgentId: string | null = resume?.agentId ?? null;

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

  // Spec §5.6: item_completed wraps a typed `item`; dispatch on item.type.
  // Defined here (not module scope) so it can push through `base` and share
  // sub_index with every other event on this line.
  const pushFromItem = (item: any, payload: any, line: TailLine, ts: string,
                         agentId: string | null): void => {
    const type = item?.type;
    switch (type) {
      case 'AgentMessage':
        out.push(base(line, 'prose', { text: itemText(item), role: 'assistant' },
          ts, agentId, item.id ?? null));
        break;
      case 'UserMessage':
        out.push(base(line, 'prompt.submitted', { text: itemText(item) },
          ts, agentId, item.id ?? null));
        break;
      case 'CommandExecution': {
        const command = Array.isArray(item.command) ? item.command : null;
        // item_completed carries no explicit tool-name field for this item
        // type (unlike the flat envelope's function_call.name). Hardcoding
        // 'shell' — rather than deriving something from the command itself
        // — keeps tool-name aggregation consistent across both envelopes,
        // since both represent the same underlying "run a shell command"
        // action.
        out.push(base(line, 'tool.used', {
          name: 'shell', target: command ? command.join(' ') : null, command,
          isError: item.status === 'failed'
            || (typeof item.exit_code === 'number' && item.exit_code !== 0),
          toolUseId: item.id ?? null,
        }, ts, agentId, item.id ?? null));
        break;
      }
      case 'Extension':
        out.push(base(line, 'tool.used', {
          name: item.kind ?? 'Extension', target: item.query ?? null, isError: false,
          toolUseId: item.id ?? null,
        }, ts, agentId, item.id ?? null));
        break;
      case 'FileChange': {
        const paths = item.changes && typeof item.changes === 'object'
          ? Object.keys(item.changes) : [];
        out.push(base(line, 'tool.used', {
          name: 'FileChange', target: paths.length ? paths.join(', ') : null,
          isError: item.status === 'failed', toolUseId: item.id ?? null,
        }, ts, agentId, item.id ?? null));
        break;
      }
      case 'ContextCompaction': {
        // started_at_ms/completed_at_ms sit on the item_completed payload,
        // as siblings of `item`, not on the item itself. Measured on a real
        // transcript.
        const started = typeof payload?.started_at_ms === 'number' ? payload.started_at_ms : null;
        const done = typeof payload?.completed_at_ms === 'number' ? payload.completed_at_ms : null;
        out.push(base(line, 'context.compacted', {
          trigger: null, durationMs: started !== null && done !== null ? done - started : null,
        }, ts, agentId, item.id ?? null));
        break;
      }
      case 'Reasoning':
        break; // known, not mapped in v1
      default:
        out.push(base(line, 'unparsed', { reason: 'unknown-item-type', itemType: type },
          ts, agentId, null));
    }
  };

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

    // Known top-level record types (siblings of session_meta/event_msg/
    // response_item) that are not mapped in v1. Spec §5.6.
    if (KNOWN_TOP_LEVEL_UNMAPPED.has(rec?.type)) {
      continue;
    }

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
        case 'item_completed':
          // Spec §5.6: the alternative envelope some rollout files use
          // instead of flat agent_message/user_message/task_complete
          // records. The two envelopes are mutually exclusive per file, so
          // handling both here cannot double-count.
          pushFromItem(p.item, p, line, ts, threadAgentId);
          break;
        default:
          break; // task_started, token_count, agent_reasoning, error,
                 // thread_settings_applied: known, not mapped in v1
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
      //
      // `custom_tool_call` is deliberately NOT mapped, despite having the
      // same fields as function_call. Measured on the real corpus:
      // custom_tool_call and item_completed/CommandExecution|Extension|
      // FileChange are the REQUEST and COMPLETION halves of the same tool
      // invocation, not two separate activities — every one of the 158
      // custom_tool_call records lives in a file whose item_completed tool
      // items already total 180, and same-file/same-command pairs (e.g. the
      // same `sed -n '1,240p' ...` appearing as both a CommandExecution
      // item and a custom_tool_call input) confirm it. Mapping this too
      // double-counted every Codex tool call and inflated agent-graph node
      // sizes. Do not re-add this mapping on a "half the tool activity is
      // hidden" argument without re-checking for this pairing first.
      //
      // `custom_tool_call_output` stays unmapped for the same reason as
      // `function_call_output`: neither envelope emits events for tool
      // *results*, only for the calls.
      continue;
    }

    out.push(base(line, 'unparsed', { reason: 'unknown-record-type', recordType: rec?.type },
      ts, threadAgentId, null));
  }

  return out;
}
