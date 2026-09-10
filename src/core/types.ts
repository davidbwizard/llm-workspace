/** The normalized event vocabulary. Spec §6.4.
 *  `session.ended` is deliberately absent: a run ends, a session usually
 *  does not (spec §6.3). `unparsed` carries records whose shape we do not
 *  recognize, so drift surfaces instead of vanishing (spec §6.2). */
export const EVENT_KINDS = [
  'session.started', 'run.started', 'run.ended', 'context.compacted',
  'control.attached', 'control.detached', 'prompt.submitted',
  'turn.completed', 'agent.spawned', 'agent.ended', 'prose',
  'tool.used', 'cwd.changed', 'state.changed', 'unparsed',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(v: string): v is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(v);
}

export type Provider = 'claude' | 'codex';

/** One row destined for the derived `events` table. Spec §6.1. */
export interface NormalizedEvent {
  provider: Provider;
  sessionId: string;
  runId: string | null;
  agentId: string | null;
  ts: string;                 // ISO 8601, from the source record
  kind: EventKind;
  payload: Record<string, unknown>;
  nativeId: string | null;
  sourceFile: string;
  sourceOffset: number;       // byte offset of the record's first byte
  contentHash: string;
  subIndex: number;           // ordinal within the source record's events, from 0
  parserVersion: number;
}

/** Optional parser state to resume from, supplied by the caller when tailing
 *  a file from a nonzero offset rather than parsing it from byte 0. Parsers
 *  are pure and never query the database themselves (spec §11) -- a tail
 *  chunk on its own carries no session_meta (Codex) or first-record cwd
 *  (Claude), so without this, a resumed Codex chunk parses to sessionId
 *  "unknown" and a resumed Claude chunk re-emits a duplicate session.started
 *  every pass. The caller (ingestFileOnce) looks up what a prior ingest of
 *  this same file already established and passes it back in here. */
export interface ParseResumeContext {
  sessionId?: string;
  sessionStartEmitted: boolean;
  agentId?: string;
}
