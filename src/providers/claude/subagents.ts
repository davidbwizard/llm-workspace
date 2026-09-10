import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashRecord } from '../../core/identity.ts';
import type { NormalizedEvent } from '../../core/types.ts';
import { CLAUDE_PARSER_VERSION } from './parse.ts';

export interface SubagentRef {
  agentId: string;
  transcriptPath: string;
  metaPath: string;
}

/** Spec §6.5. Subagents live at
 *  <project>/<session-id>/subagents/agent-<name>-<hash>.jsonl(+.meta.json).
 *  A meta file with no transcript is ignored: there is nothing to read. */
export function findSubagents(sessionDir: string): SubagentRef[] {
  const dir = join(sessionDir, 'subagents');
  if (!existsSync(dir)) return [];

  // Claude Code deletes its own transcripts once it decides it no longer
  // needs them, and this app watches these directories continuously, so
  // the directory can vanish between the existsSync check above and this
  // read. That race is not a format error — treat it like "no subagents".
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const transcripts = new Set(
    entries.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length)),
  );

  const out: SubagentRef[] = [];
  for (const agentId of transcripts) {
    const metaPath = join(dir, `${agentId}.meta.json`);
    if (!existsSync(metaPath)) continue;
    out.push({ agentId, transcriptPath: join(dir, `${agentId}.jsonl`), metaPath });
  }
  return out.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** Spec §6.4: agent.spawned carries the graph's node attributes.
 *  `parentAgentId` is null for Claude today — every observed agent has
 *  spawnDepth 0 and no recorded parent beyond the session root — but the
 *  field exists because §8.2 supports multiple depths from day one. */
export function parseAgentMeta(
  meta: any,
  sourceFile: string,
  sessionId: string,
  agentId: string,
  ts: string,
): NormalizedEvent {
  return {
    provider: 'claude', sessionId, runId: null, agentId, ts,
    kind: 'agent.spawned',
    payload: {
      name: meta?.name ?? agentId,
      type: meta?.agentType ?? null,
      model: meta?.model ?? null,
      color: meta?.color ?? null,
      depth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : 0,
      taskKind: meta?.taskKind ?? null,
      teamName: meta?.teamName ?? null,
      parentAgentId: null,
    },
    nativeId: agentId,
    sourceFile,
    sourceOffset: 0,
    contentHash: hashRecord(JSON.stringify(meta ?? {})),
    // Each .meta.json file produces exactly one agent.spawned event, so
    // it is the only event emitted from this source record: the ordinal
    // within that record is always 0.
    subIndex: 0,
    parserVersion: CLAUDE_PARSER_VERSION,
  };
}
