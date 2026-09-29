import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedEvent } from '../core/types.ts';
import { shellQuote as q } from '../main/launch.ts';
import { readTail } from '../providers/claude/tail.ts';
import { parseClaudeLines } from '../providers/claude/parse.ts';
import { parseCodexLines } from '../providers/codex/parse.ts';
import { writeFileAtomic, type Sender, type Verdict } from './files.ts';

// A specialist is a live session David can watch and continue. Fleet opens
// it read-only, hands it each pass as a file, and reads the reply back from
// the session's own transcript -- never from the screen.

export const VERDICT_RULE = 'End your reply with exactly one line on its own: VERDICT: approved, or VERDICT: changes_requested.';

export interface SessionSpec {
  runsOn: Sender;
  project: string;
  loopId: string;
  name: string;
  /** Claude: a UUID Fleet chooses. Codex: its rollout's UUID, '' until found. */
  sessionId: string;
  letterDir: string;
  codexMcpOff: string[];
}

export type Reply = { verdict: Verdict; review: string };

/** What the post office needs from Fleet to run a specialist session.
 *  Methods returning `string | null` return null on success, else why not. */
export interface SessionDriver {
  open(runsOn: Sender, project: string, command: string, tmux: string): string | null;
  alive(tmux: string): boolean;
  /** Pastes one line and submits it; `queue` sends Tab instead of Enter (a busy Codex). */
  typeLine(tmux: string, line: string, queue: boolean): string | null;
  /** Whether a Codex rollout's last turn is still running. */
  codexBusy(file: string): boolean;
  claudeTranscript(project: string, sessionId: string): string;
  findCodexRollout(marker: string, sinceMs: number): string | null;
  /** 0 when the file does not exist yet. */
  size(file: string): number;
  readReply(runsOn: Sender, file: string, fromOffset: number): Reply | null;
}

/** The subject is agent text: no control, zero-width or direction-changing
 *  characters, bounded length. */
export const sessionName = (to: string, subject: string): string =>
  `Mail · ${to} · ${subject}`.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 80);

export const passFile = (letterDir: string, pass: number): string => join(letterDir, `pass-${pass}.md`);

export function writePassFile(letterDir: string, pass: number, content: string): string {
  const file = passFile(letterDir, pass);
  writeFileAtomic(file, content);
  return file;
}

export const firstMessage = (file: string): string => `You are a Fleet Mail specialist. Read ${file} and do what it says.`;
export const passLine = (pass: number, file: string): string => `Pass ${pass}: read ${file} and do what it says.`;

const env = (s: SessionSpec): string => `env FLEET_MAIL_SPECIALIST=${q(s.loopId)}`;
// Variadic --tools goes last so it cannot swallow anything after it.
const claudeFlags = (s: SessionSpec): string =>
  `--permission-mode dontAsk --strict-mcp-config --add-dir ${q(s.letterDir)} --tools Read Grep Glob`;
// Any override makes Codex run standalone instead of joining the shared
// daemon, so these settings hold. Plugins (context7, cua_repl, ...) go off
// as features; a per-name override for a plugin server breaks Codex's config
// load. Configured servers go off by name. (Probed 2026-09-28/29.)
const codexFlags = (s: SessionSpec): string => [
  '--sandbox read-only -a never --disable plugins --disable computer_use',
  `-c ${q('check_for_update_on_startup=false')}`,
  ...s.codexMcpOff.map(n => `-c ${q(`mcp_servers.${n}.enabled=false`)}`),
  `-C ${q(s.project)}`,
].join(' ');

/** One shell string for tmux. Every value is quoted. */
export function openCommand(s: SessionSpec, message: string): string {
  return s.runsOn === 'claude'
    ? `${env(s)} claude ${q(message)} --session-id ${q(s.sessionId)} -n ${q(s.name)} ${claudeFlags(s)}`
    : `${env(s)} codex ${codexFlags(s)} ${q(message)}`;
}

export function resumeCommand(s: SessionSpec, message: string): string {
  return s.runsOn === 'claude'
    ? `${env(s)} claude --resume ${q(s.sessionId)} ${q(message)} ${claudeFlags(s)}`
    : `${env(s)} codex resume ${codexFlags(s)} ${q(s.sessionId)} ${q(message)}`;
}

// Tolerates what models add around it: a quote or list marker, bold, a full stop.
const VERDICT = /^\s*(?:[>-]\s*)?[*_`]*\s*VERDICT\s*:\s*[*_`]*\s*(approved|changes_requested)\s*[*_`]*\s*[.!]?\s*[*_`]*\s*$/i;

export function splitVerdict(text: string): Reply | null {
  const lines = text.trimEnd().split('\n');
  const m = VERDICT.exec(lines[lines.length - 1] ?? '');
  return m ? { verdict: m[1]!.toLowerCase() as Verdict, review: lines.slice(0, -1).join('\n').trim() } : null;
}

/** The first assistant message ending in a VERDICT line. When that message
 *  is only the VERDICT line, the review is the assistant message before it. */
export function findReply(events: NormalizedEvent[]): Reply | null {
  let previous = '';
  for (const e of events) {
    if (e.kind !== 'prose' || e.payload.role !== 'assistant' || e.payload.note === true || typeof e.payload.text !== 'string') continue;
    const reply = splitVerdict(e.payload.text);
    if (reply) return reply.review ? reply : { ...reply, review: previous.trim() };
    previous = e.payload.text;
  }
  return null;
}

export function readReply(runsOn: Sender, file: string, fromOffset: number): Reply | null {
  let lines;
  try {
    lines = readTail(file, fromOffset, null).lines;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return findReply((runsOn === 'claude' ? parseClaudeLines : parseCodexLines)(lines, file));
}

const HEAD_BYTES = 256_000;
const pad = (n: number): string => String(n).padStart(2, '0');
const dayDir = (root: string, t: number): string => {
  const d = new Date(t);
  return join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
};

function head(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** The newest Codex rollout written since `sinceMs` whose opening mentions
 *  `marker` -- the pass file's absolute path, which only the specialist's
 *  first prompt contains (a Codex sender's own rollout holds the letter id). */
export function findCodexRollout(root: string, marker: string, sinceMs: number, nowMs: number): string | null {
  let best: { file: string; mtime: number } | null = null;
  for (const dir of new Set([dayDir(root, sinceMs), dayDir(root, nowMs)])) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (isMissing(e)) continue;
      throw e;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      try {
        const mtime = statSync(file).mtimeMs;
        if (mtime >= sinceMs && (!best || mtime > best.mtime) && head(file).includes(marker)) best = { file, mtime };
      } catch (e) {
        if (!isMissing(e)) throw e;   // removed between listing and reading
      }
    }
  }
  return best?.file ?? null;
}

export const codexSessionId = (rollout: string): string | null =>
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(rollout)?.[1] ?? null;
