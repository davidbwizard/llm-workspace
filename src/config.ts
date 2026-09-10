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

// Matches a complete CSI sequence: ESC '[', then parameter bytes (0x30-0x3F),
// then intermediate bytes (0x20-0x2F), then one final byte (0x40-0x7E).
// Covers cursor moves and erase-line/erase-display among others.
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Matches a complete OSC sequence: ESC ']', any bytes, terminated by either
// BEL (the classic terminator) or ST (ESC '\', the more "correct" one).
// Covers window-title (OSC 0/2) and clipboard-write (OSC 52) among others.
const OSC_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// C0 controls (0x00-0x1F, including any ESC that survived the two regexes
// above -- e.g. a truncated sequence with no terminator at all) and DEL
// (0x7F). `stream` prints one line per event, so an embedded newline or tab
// is itself unwanted -- none of these are kept.
const C0_AND_DEL = /[\x00-\x1f\x7f]/g;
// C1 controls (0x80-0x9F) -- the 8-bit single-byte equivalents of ESC-prefixed
// sequences (e.g. 0x9B is an alternate encoding of CSI).
const C1_CONTROLS = /[\x80-\x9f]/g;

/** Strip control characters and terminal escape sequences from untrusted
 *  provider text before it reaches a terminal (or, later, a UI that renders
 *  it raw). Transcript text embeds raw tool output -- literal file contents,
 *  command output, anything a tool returned -- so a crafted file read by an
 *  agent can carry a CSI erase-line, an OSC clipboard write or title
 *  set, or a deliberately truncated escape sequence meant to leave the
 *  terminal in a pending state. Order matters: complete CSI/OSC sequences
 *  are removed first, while their leading ESC is still there to anchor the
 *  match; only what's left over (including any ESC that was never part of
 *  a complete sequence) is caught by the blanket C0/DEL/C1 strip. */
export function sanitizeForTerminal(s: string): string {
  return s
    .replace(CSI_SEQUENCE, '')
    .replace(OSC_SEQUENCE, '')
    .replace(C0_AND_DEL, '')
    .replace(C1_CONTROLS, '');
}

/** The phase-1 preview of §8.3: prose reads as prose, tool calls compress to
 *  one dim line. This is the CLI's whole reason to exist — proving the
 *  signal/noise split works before any UI depends on it. */
export function formatEventLine(e: Pick<NormalizedEvent, 'ts' | 'kind' | 'agentId' | 'payload'>): string {
  const time = e.ts.slice(11, 19);
  const text = (v: unknown) => sanitizeForTerminal(String(v ?? ''));
  const agent = e.agentId
    ? ` [${text(e.agentId.replace(/^agent-/, '').replace(/-[0-9a-f]{8,}$/, ''))}]`
    : '';
  const p = e.payload as Record<string, any>;

  if (e.kind === 'prose') return `${time}${agent}  ${text(p.text)}`;
  if (e.kind === 'prompt.submitted') return `${time}${agent}  > ${text(p.text)}`;
  if (e.kind === 'tool.used') {
    const target = p.target != null ? text(p.target).slice(0, 60) : '';
    return `${time}${agent}    * ${text(p.name)}${target ? ' ' + target : ''}`;
  }
  if (e.kind === 'agent.spawned') return `${time}  + spawned ${text(p.name)} (depth ${p.depth})`;
  if (e.kind === 'unparsed') return `${time}  ! unparsed: ${text(p.reason)} ${text(p.recordType ?? '')}`;
  if (NOISY.has(e.kind)) return `${time}    * ${e.kind}`;
  return `${time}  ${e.kind}`;
}
