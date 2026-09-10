import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { openDb } from '../src/store/db.ts';
import { insertEvents } from '../src/store/ingest.ts';
import type { NormalizedEvent } from '../src/core/types.ts';
import type { LiveProcess } from '../src/discovery/parse.ts';
import {
  resolvePaths, probeCapabilities, formatEventLine, sanitizeForTerminal,
  sessionRefs, formatCandidates, MAX_CANDIDATES_SHOWN,
  parseProcessChainHop, buildProcessChain, annotateSessionsWithProcesses,
} from '../src/config.ts';

describe('resolvePaths', () => {
  it('points at the provider directories the spec names', () => {
    const p = resolvePaths('/home/me');
    expect(p.claudeProjects).toBe('/home/me/.claude/projects');
    expect(p.codexSessions).toBe('/home/me/.codex/sessions');
    expect(p.codexStateDb).toBe('/home/me/.codex/state_5.sqlite');
    expect(p.spool).toBe('/home/me/.llm-workspace/spool');
    expect(p.db).toBe('/home/me/.llm-workspace/index.sqlite');
  });
});

describe('probeCapabilities', () => {
  it('reports what is actually present rather than assuming', () => {
    const caps = probeCapabilities(resolvePaths(process.env.HOME!));
    expect(typeof caps.claudeTranscripts).toBe('boolean');
    expect(typeof caps.codexRollouts).toBe('boolean');
    expect(typeof caps.codexStateDb).toBe('boolean');
    expect(typeof caps.tmux).toBe('boolean');
    expect(typeof caps.hooksInstalled).toBe('boolean');
  });

  it('agrees with the filesystem about Claude transcripts', () => {
    const paths = resolvePaths(process.env.HOME!);
    const caps = probeCapabilities(paths);
    expect(caps.claudeTranscripts).toBe(existsSync(paths.claudeProjects));
  });
});

describe('formatEventLine', () => {
  it('renders prose prominently and tool noise compactly', () => {
    const prose = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: null,
      payload: { text: 'The magic link has no expiry.' },
    } as any);
    expect(prose).toContain('The magic link has no expiry.');

    const tool = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'tool.used', agentId: null,
      payload: { name: 'Bash', target: 'npm test' },
    } as any);
    expect(tool).toContain('Bash');
    expect(tool).toContain('npm test');
  });

  it('tags events with their agent when one is present', () => {
    const line = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: 'agent-task-8-magiclink-abc',
      payload: { text: 'done' },
    } as any);
    expect(line).toContain('task-8-magiclink');
  });

  it('sanitizes escape sequences embedded in provider text before printing', () => {
    const line = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: null,
      payload: { text: 'safe\x1b]0;evil title\x07text' },
    } as any);
    expect(line).not.toMatch(/\x1b/);
    expect(line).toContain('safetext');
  });
});

// Transcript text is untrusted: it embeds raw tool output (file contents,
// command output), so a crafted file read by an agent can carry a terminal
// escape sequence. `stream` prints this text directly to stdout, so anything
// left unstripped reaches the user's real terminal.
describe('sanitizeForTerminal', () => {
  it('strips an OSC 52 clipboard-write sequence', () => {
    expect(sanitizeForTerminal('before\x1b]52;c;aGVsbG8=\x07after')).toBe('beforeafter');
  });

  it('strips an OSC 0 window-title sequence', () => {
    expect(sanitizeForTerminal('before\x1b]0;pwned\x07after')).toBe('beforeafter');
  });

  it('strips an OSC sequence terminated by ST (ESC \\) instead of BEL', () => {
    expect(sanitizeForTerminal('before\x1b]0;pwned\x1b\\after')).toBe('beforeafter');
  });

  it('strips a CSI erase-line sequence', () => {
    expect(sanitizeForTerminal('before\x1b[2Kafter')).toBe('beforeafter');
  });

  it('strips a bare ESC with no terminator, without eating the rest of the string', () => {
    expect(sanitizeForTerminal('before\x1bafter')).toBe('beforeafter');
  });

  it('strips a C1 control character', () => {
    expect(sanitizeForTerminal('before\x9bafter')).toBe('beforeafter');
  });

  it('strips C0 controls and DEL, including embedded newlines and tabs', () => {
    expect(sanitizeForTerminal('a\nb\tc\x7fd')).toBe('abcd');
  });

  it('passes ordinary punctuation and non-ASCII text through unchanged', () => {
    const plain = 'Reusing the "existing" JWT helper -> café, 日本語, ↑↓, boxes: ┌─┐';
    expect(sanitizeForTerminal(plain)).toBe(plain);
  });
});

// sessionRefs, formatCandidates, buildProcessChain and
// annotateSessionsWithProcesses back the `sessions` command. `now` on
// sessionRefs is injectable so these don't race the wall clock.
describe('sessionRefs', () => {
  const NOW = Date.parse('2026-09-10T23:00:00.000Z');
  const MIN = 60_000;

  function ev(sessionId: string, kind: NormalizedEvent['kind'], ts: string, offset: number,
              payload: Record<string, unknown> = {}): NormalizedEvent {
    return {
      provider: 'claude', sessionId, runId: null, agentId: null, ts, kind, payload,
      nativeId: null, sourceFile: `/f-${sessionId}.jsonl`, sourceOffset: offset,
      contentHash: `h-${sessionId}-${offset}`, subIndex: 0, parserVersion: 1,
    };
  }

  it('includes a session whose most recent event is inside the recency window', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev('s1', 'session.started', new Date(NOW - 20 * MIN).toISOString(), 0, { cwd: '/repo/a' }),
      ev('s1', 'prose', new Date(NOW - 5 * MIN).toISOString(), 1),
    ]);
    expect(sessionRefs(db, NOW)).toEqual([{ sessionId: 's1', cwd: '/repo/a' }]);
  });

  it('excludes a session whose most recent event is older than the window', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev('s1', 'session.started', new Date(NOW - 2 * 24 * 60 * MIN).toISOString(), 0, { cwd: '/repo/a' }),
      ev('s1', 'prose', new Date(NOW - 2 * 24 * 60 * MIN).toISOString(), 1),
    ]);
    expect(sessionRefs(db, NOW)).toEqual([]);
  });

  it('excludes a session with recent activity but no session.started event -- cwd is unknowable', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev('s1', 'prose', new Date(NOW - MIN).toISOString(), 0)]);
    expect(sessionRefs(db, NOW)).toEqual([]);
  });

  it('keeps two co-recent sessions sharing one cwd -- a genuine collision is not collapsed', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev('s1', 'session.started', new Date(NOW - 25 * MIN).toISOString(), 0, { cwd: '/repo/shared' }),
      ev('s1', 'prose', new Date(NOW - 20 * MIN).toISOString(), 1),
      ev('s2', 'session.started', new Date(NOW - 15 * MIN).toISOString(), 0, { cwd: '/repo/shared' }),
      ev('s2', 'prose', new Date(NOW - 2 * MIN).toISOString(), 1),
    ]);
    const ids = sessionRefs(db, NOW).map(s => s.sessionId).sort();
    expect(ids).toEqual(['s1', 's2']);
  });
});

describe('formatCandidates', () => {
  it('joins a short list as-is', () => {
    expect(formatCandidates(['a', 'b'])).toBe('a, b');
  });

  it('truncates a list past MAX_CANDIDATES_SHOWN with a trailing count', () => {
    const ids = Array.from({ length: MAX_CANDIDATES_SHOWN + 3 }, (_, i) => `id${i}`);
    const out = formatCandidates(ids);
    expect(out).toBe(`id0, id1, id2, id3, id4, and 3 more`);
  });
});

describe('parseProcessChainHop', () => {
  it('parses a ppid and comm pair', () => {
    expect(parseProcessChainHop('12345 /Applications/iTerm.app/Contents/MacOS/iTerm2'))
      .toEqual({ ppid: 12345, comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2' });
  });

  it('returns null for empty output -- the process no longer exists', () => {
    expect(parseProcessChainHop('')).toBeNull();
  });

  it('returns null for output that is not the expected shape', () => {
    expect(parseProcessChainHop('not a valid ps line')).toBeNull();
  });
});

describe('buildProcessChain', () => {
  it('walks hops via the injected function until ppid <= 1, basenaming each comm', () => {
    const hops: Record<number, string> = {
      100: '1 claude',
      1: '0 launchd',
    };
    const chain = buildProcessChain(100, pid => hops[pid] ?? '');
    expect(chain).toEqual(['claude']);
  });

  it('basenames a full executable path to match classifyHost bare-name fixtures', () => {
    const hops: Record<number, string> = {
      100: '200 claude',
      200: '1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
    };
    const chain = buildProcessChain(100, pid => hops[pid] ?? '');
    expect(chain).toEqual(['claude', 'iTerm2']);
  });

  it('stops when hop() returns unparseable output instead of looping', () => {
    const chain = buildProcessChain(100, () => '');
    expect(chain).toEqual([]);
  });

  it('stops at maxDepth even if every hop reports a live parent', () => {
    const chain = buildProcessChain(1000, pid => `${pid - 1} proc${pid}`, 3);
    expect(chain).toHaveLength(3);
  });
});

describe('annotateSessionsWithProcesses', () => {
  const proc = (pid: number, cwd: string | null, host: LiveProcess['host'] = 'iterm2'): LiveProcess =>
    ({ pid, tty: `ttys${pid}`, cwd, host });

  it('marks a session unique when exactly one process shares its cwd, one-to-one', () => {
    const sessions = [{ sessionId: 's1', cwd: '/repo/a' }];
    const procs = [proc(100, '/repo/a')];
    expect(annotateSessionsWithProcesses(sessions, procs)).toEqual([
      { sessionId: 's1', cwd: '/repo/a', quality: 'unique',
        process: { pid: 100, tty: 'ttys100', host: 'iterm2' }, candidatePids: [] },
    ]);
  });

  it('marks a session unknown when no live process shares its cwd', () => {
    const sessions = [{ sessionId: 's1', cwd: '/repo/a' }];
    const procs = [proc(100, '/repo/elsewhere')];
    expect(annotateSessionsWithProcesses(sessions, procs)).toEqual([
      { sessionId: 's1', cwd: '/repo/a', quality: 'unknown', process: null, candidatePids: [] },
    ]);
  });

  it('marks both sessions ambiguous when two sessions share a cwd with one live process -- not falsely unique', () => {
    const sessions = [
      { sessionId: 's1', cwd: '/repo/shared' },
      { sessionId: 's2', cwd: '/repo/shared' },
    ];
    const procs = [proc(100, '/repo/shared')];
    const result = annotateSessionsWithProcesses(sessions, procs);
    expect(result).toEqual([
      { sessionId: 's1', cwd: '/repo/shared', quality: 'ambiguous', process: null, candidatePids: [100] },
      { sessionId: 's2', cwd: '/repo/shared', quality: 'ambiguous', process: null, candidatePids: [100] },
    ]);
  });

  it('marks a session ambiguous when two live processes share its cwd', () => {
    const sessions = [{ sessionId: 's1', cwd: '/repo/a' }];
    const procs = [proc(100, '/repo/a'), proc(101, '/repo/a', 'vscode')];
    const result = annotateSessionsWithProcesses(sessions, procs);
    expect(result).toHaveLength(1);
    expect(result[0]!.quality).toBe('ambiguous');
    expect(result[0]!.process).toBeNull();
    expect(result[0]!.candidatePids.slice().sort()).toEqual([100, 101]);
  });

  it('lists a session with no process at all -- the model this replaces would have made it invisible', () => {
    const sessions = [{ sessionId: 's1', cwd: '/repo/a' }, { sessionId: 's2', cwd: '/repo/b' }];
    const procs: LiveProcess[] = [];
    const result = annotateSessionsWithProcesses(sessions, procs);
    expect(result.map(r => r.sessionId)).toEqual(['s1', 's2']);
    expect(result.every(r => r.quality === 'unknown')).toBe(true);
  });
});
