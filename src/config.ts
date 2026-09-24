import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import type { NormalizedEvent } from './core/types.ts';
import type { Db } from './store/db.ts';
import type { LiveProcess } from './discovery/parse.ts';
import { classifyMatch, type SessionRef } from './discovery/match.ts';
import { isOwnedHookCommand } from './hooks/install.ts';

export interface Paths {
  claudeProjects: string;
  claudeSettings: string;
  claudeLiveSessions: string;
  codexSessions: string;
  codexStateDb: string;
  codexHistoryDb: string;
  /** codex-cli's own hook config, the Codex counterpart of
   *  `claudeSettings`. Same `{hooks: {Event: [...]}}` shape, its own file
   *  rather than a key inside a larger settings file. */
  codexHooks: string;
  spool: string;
  appearance: string;
  /** What the person has agreed to let this app write into files they own
   *  (src/hooks/consent.ts). Design §6: ask once, and take no for an answer. */
  consent: string;
  /** "Usage and context": the status line snapshots (src/hooks/statusline.sh). */
  statusLineDir: string;
  db: string;
}

export function resolvePaths(home: string): Paths {
  return {
    claudeProjects: join(home, '.claude/projects'),
    claudeSettings: join(home, '.claude/settings.json'),
    claudeLiveSessions: join(home, '.claude/sessions'),
    codexSessions: join(home, '.codex/sessions'),
    codexStateDb: join(home, '.codex/state_5.sqlite'),
    codexHistoryDb: join(home, '.codex/thread_history_1.sqlite'),
    codexHooks: join(home, '.codex/hooks.json'),
    spool: join(home, '.llm-workspace/spool'),
    appearance: join(home, '.llm-workspace/appearance.json'),
    consent: join(home, '.llm-workspace/consent.json'),
    statusLineDir: join(home, '.llm-workspace/statusline'),
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

/** Whether settings.json's hooks contain a fragment this app installed.
 *  Installed fragments carry only the documented schema fields (type,
 *  command, timeout) -- no private marker, no on-disk manifest to compare
 *  against -- so ownership is recognized the same way planInstall and
 *  uninstall recognize it: by the shape of the command string itself
 *  (isOwnedHookCommand), not by a marker task 12 deliberately stopped
 *  writing. */
function hasOwnedHooks(settings: any): boolean {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks).some((entries: any) =>
    Array.isArray(entries) && entries.some((entry: any) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => isOwnedHookCommand(h?.command))));
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
    hooksInstalled = existsSync(paths.claudeSettings) && hasOwnedHooks(
      JSON.parse(readFileSync(paths.claudeSettings, 'utf8')),
    );
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
  if (e.kind === 'agent.spawned') return `${time}  + spawned ${text(p.name)} (depth ${text(p.depth)})`;
  if (e.kind === 'unparsed') return `${time}  ! unparsed: ${text(p.reason)} ${text(p.recordType ?? '')}`;
  if (NOISY.has(e.kind)) return `${time}    * ${e.kind}`;
  return `${time}  ${e.kind}`;
}

// --- sessions -----------------------------------------------------------
//
// Spec §7.1a: transcript activity determines which sessions exist; process
// discovery is enrichment, not the source of truth. So the `sessions`
// command enumerates sessions from the store (sessionRefs, below) and
// annotates each with a live process where one is found
// (annotateSessionsWithProcesses), rather than enumerating processes and
// treating a session as invisible when none matches.

/** A session with no event newer than this is treated as ended, not a live
 *  candidate for cwd matching. Without this, `sessions` matches a running
 *  process against every session that ever used that directory -- on a
 *  machine with months of history that is 6 to 199 "candidates" for every
 *  single live process, which is ambiguity in name only: it is not a
 *  genuine collision, just the caller feeding classifyMatch a candidate
 *  pool it was never meant to see. 30 minutes is generous enough that an
 *  idle-but-still-open session is not falsely dropped. */
export const SESSION_RECENCY_WINDOW_MS = 30 * 60 * 1000;

/** Candidate sessions for matching: every session_id whose most recent
 *  event (of any kind, not just session.started) falls within
 *  SESSION_RECENCY_WINDOW_MS of `now`, paired with the cwd its
 *  session.started event recorded. Requires `ingest` to have run at least
 *  once — this reads whatever is already in the store, it does not ingest
 *  on the caller's behalf.
 *
 *  `now` is injectable (defaults to `Date.now()`) so tests can pin it
 *  instead of racing the wall clock.
 *
 *  Ordered most-recent-first, so that when a candidate list still gets
 *  truncated for display (a genuine, still-live collision can itself run
 *  to several entries), the ones shown are the most likely to matter. */
export function sessionRefs(db: Db, now: number = Date.now()): SessionRef[] {
  const startedRows = db.prepare(
    `SELECT session_id as sessionId, payload FROM events
     WHERE kind = 'session.started' ORDER BY id DESC`,
  ).all() as { sessionId: string; payload: string }[];
  const cwdBySession = new Map<string, string | null>();
  for (const r of startedRows) {
    if (cwdBySession.has(r.sessionId)) continue; // keep the most recent row per session
    let cwd: string | null = null;
    try { cwd = JSON.parse(r.payload)?.cwd ?? null; } catch { cwd = null; }
    cwdBySession.set(r.sessionId, cwd);
  }

  const lastSeenRows = db.prepare(
    `SELECT session_id as sessionId, MAX(ts) as lastTs FROM events
     GROUP BY session_id ORDER BY lastTs DESC`,
  ).all() as { sessionId: string; lastTs: string }[];

  const cutoff = now - SESSION_RECENCY_WINDOW_MS;
  const out: SessionRef[] = [];
  for (const row of lastSeenRows) {
    const cwd = cwdBySession.get(row.sessionId);
    if (cwd === undefined) continue; // no session.started event -- cwd unknown, cannot match on it
    const lastMs = Date.parse(row.lastTs);
    if (!Number.isFinite(lastMs) || lastMs < cutoff) continue; // ended, or timestamp unparseable
    out.push({ sessionId: row.sessionId, cwd });
  }
  return out;
}

export const MAX_CANDIDATES_SHOWN = 5;

/** Truncates a long candidate list to MAX_CANDIDATES_SHOWN entries plus a
 *  count, for terminal readability -- a cwd with months of history can
 *  otherwise dump hundreds of ids on one line. */
export function formatCandidates(candidates: string[]): string {
  if (candidates.length <= MAX_CANDIDATES_SHOWN) return candidates.join(', ');
  const shown = candidates.slice(0, MAX_CANDIDATES_SHOWN).join(', ');
  return `${shown}, and ${candidates.length - MAX_CANDIDATES_SHOWN} more`;
}

export interface ProcessChainHop { ppid: number; comm: string }

/** Parse one hop of `ps -o ppid=,comm= -p <pid>` output: the parent pid and
 *  this process's own command name. Returns null when the process no longer
 *  exists (empty output, e.g. it exited between discovery and inspection)
 *  or the output isn't in the expected shape. */
export function parseProcessChainHop(raw: string): ProcessChainHop | null {
  const line = raw.trim();
  const m = line.match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  return { ppid: Number(m[1]), comm: m[2]!.trim() };
}

/** Walk the parent chain, one hop per call to `hop(pid)`, so classifyHost
 *  gets `[self, parent, grandparent, ...]` (chain[0] is the process being
 *  classified, not an ancestor). `hop` is injected — cli.ts passes a real
 *  `ps` invocation; tests pass a canned sequence, so this walk (the depth
 *  cap, the stop conditions, the basename normalization) is verifiable
 *  without shelling out.
 *
 *  `comm` from `ps -o comm=` on macOS is often a full executable path
 *  rather than a bare name (e.g. ".../iTerm.app/Contents/MacOS/iTerm2");
 *  classifyHost's fixtures use bare names ('iTerm2', 'Code Helper', '-zsh'),
 *  so each hop is basename()'d to match. */
export function buildProcessChain(pid: number, hop: (pid: number) => string, maxDepth = 12): string[] {
  const chain: string[] = [];
  let cur: number | null = pid;
  let depth = 0;
  while (cur !== null && depth < maxDepth) {
    const step = parseProcessChainHop(hop(cur));
    if (!step) break;
    chain.push(basename(step.comm));
    if (step.ppid <= 1) break;
    cur = step.ppid;
    depth++;
  }
  return chain;
}

export type SessionMatchQuality = 'unique' | 'ambiguous' | 'unknown';

export interface SessionMatch {
  sessionId: string;
  cwd: string | null;
  quality: SessionMatchQuality;
  /** Populated only when quality is 'unique'. */
  process: { pid: number; tty: string | null; host: LiveProcess['host'] } | null;
  /** Populated only when quality is 'ambiguous': the live pids whose cwd
   *  could plausibly be this session (more than one process at that cwd,
   *  or the one process there is itself ambiguous among several sessions). */
  candidatePids: number[];
}

/** Enumerates SESSIONS (already recency-scoped by the caller via
 *  sessionRefs) and annotates each with a live process where exactly one
 *  unambiguously matches — rather than enumerating processes and letting a
 *  session with no matching OS process go invisible, which is the model
 *  spec §7.1a supersedes (prompted directly by a real finding: 5 sessions
 *  active in the store shared one cwd here while `pgrep` saw 0 processes at
 *  that cwd at all — a process-keyed view would have shown nothing).
 *
 *  Reuses classifyMatch (Task 11, process-keyed) unchanged and inverts its
 *  output rather than duplicating its cwd-matching logic: a session is
 *  `unique` when exactly one live process names it as a candidate AND that
 *  process itself considers it their only candidate (both sides agree,
 *  one-to-one); anything looser — more than one process pointing at this
 *  session, or the one that does is itself ambiguous among several sessions
 *  sharing its cwd — is `ambiguous`; no live process pointing here at all
 *  is `unknown`. */
export function annotateSessionsWithProcesses(sessions: SessionRef[], procs: LiveProcess[]): SessionMatch[] {
  const matches = classifyMatch(procs, sessions);
  const matchByPid = new Map(matches.map(m => [m.pid, m]));
  const procByPid = new Map(procs.map(p => [p.pid, p]));

  const pidsBySession = new Map<string, number[]>();
  for (const m of matches) {
    for (const sessionId of m.candidates) {
      const list = pidsBySession.get(sessionId) ?? [];
      list.push(m.pid);
      pidsBySession.set(sessionId, list);
    }
  }

  return sessions.map((s): SessionMatch => {
    const pids = pidsBySession.get(s.sessionId) ?? [];

    if (pids.length === 1) {
      const m = matchByPid.get(pids[0]!);
      if (m && m.quality === 'unique') {
        const p = procByPid.get(pids[0]!)!;
        return {
          sessionId: s.sessionId, cwd: s.cwd, quality: 'unique',
          process: { pid: p.pid, tty: p.tty, host: p.host }, candidatePids: [],
        };
      }
    }

    if (pids.length === 0) {
      return { sessionId: s.sessionId, cwd: s.cwd, quality: 'unknown', process: null, candidatePids: [] };
    }

    return { sessionId: s.sessionId, cwd: s.cwd, quality: 'ambiguous', process: null, candidatePids: pids };
  });
}
