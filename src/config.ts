import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { NormalizedEvent } from './core/types.ts';

export interface Paths {
  claudeProjects: string;
  claudeSettings: string;
  codexSessions: string;
  codexStateDb: string;
  codexHistoryDb: string;
  spool: string;
  db: string;
}

export function resolvePaths(home: string): Paths {
  return {
    claudeProjects: join(home, '.claude/projects'),
    claudeSettings: join(home, '.claude/settings.json'),
    codexSessions: join(home, '.codex/sessions'),
    codexStateDb: join(home, '.codex/state_5.sqlite'),
    codexHistoryDb: join(home, '.codex/thread_history_1.sqlite'),
    spool: join(home, '.llm-workspace/spool'),
    db: join(home, '.llm-workspace/index.sqlite'),
  };
}

export interface Capabilities {
  claudeTranscripts: boolean;
  codexRollouts: boolean;
  codexStateDb: boolean;
  tmux: boolean;
  hooksInstalled: boolean;
}

/** Spec §4.1: capabilities are PROBED, never hardcoded. A capability that is
 *  absent is a fact to report, not an error. */
export function probeCapabilities(paths: Paths): Capabilities {
  let tmux = false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    tmux = true;
  } catch { tmux = false; }

  let hooksInstalled = false;
  try {
    hooksInstalled = existsSync(paths.claudeSettings)
      && /_llmws/.test(readFileSync(paths.claudeSettings, 'utf8'));
  } catch { hooksInstalled = false; }

  return {
    claudeTranscripts: existsSync(paths.claudeProjects),
    codexRollouts: existsSync(paths.codexSessions),
    codexStateDb: existsSync(paths.codexStateDb),
    tmux,
    hooksInstalled,
  };
}

const NOISY = new Set(['tool.used', 'turn.completed']);

/** The phase-1 preview of §8.3: prose reads as prose, tool calls compress to
 *  one dim line. This is the CLI's whole reason to exist — proving the
 *  signal/noise split works before any UI depends on it. */
export function formatEventLine(e: Pick<NormalizedEvent, 'ts' | 'kind' | 'agentId' | 'payload'>): string {
  const time = e.ts.slice(11, 19);
  const agent = e.agentId ? ` [${e.agentId.replace(/^agent-/, '').replace(/-[0-9a-f]{8,}$/, '')}]` : '';
  const p = e.payload as Record<string, any>;

  if (e.kind === 'prose') return `${time}${agent}  ${p.text}`;
  if (e.kind === 'prompt.submitted') return `${time}${agent}  > ${p.text}`;
  if (e.kind === 'tool.used') return `${time}${agent}    * ${p.name}${p.target ? ' ' + String(p.target).slice(0, 60) : ''}`;
  if (e.kind === 'agent.spawned') return `${time}  + spawned ${p.name} (depth ${p.depth})`;
  if (e.kind === 'unparsed') return `${time}  ! unparsed: ${p.reason} ${p.recordType ?? ''}`;
  if (NOISY.has(e.kind)) return `${time}    * ${e.kind}`;
  return `${time}  ${e.kind}`;
}
