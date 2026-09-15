import { describe, it, expect } from 'vitest';
import { classifyMatch, applyExactMatches } from '../../src/discovery/match.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';

const sessions = [
  { sessionId: 'a', cwd: '/Users/me/Chocabloc' },
  { sessionId: 'b', cwd: '/Users/me/Chocabloc' },
  { sessionId: 'c', cwd: '/Users/me/trip-planner' },
];

describe('classifyMatch', () => {
  // provider:'claude' throughout -- classifyMatch reads only pid/cwd from
  // a LiveProcess (see src/discovery/match.ts), never provider. Present
  // purely because LiveProcess now requires it.
  it('marks a single-session directory as unique', () => {
    const m = classifyMatch(
      [{ pid: 1, provider:'claude', tty: 'ttys016', cwd: '/Users/me/trip-planner', host: 'iterm2' }], sessions)[0]!;
    expect(m).toMatchObject({ pid: 1, quality: 'unique', sessionId: 'c' });
  });

  it('marks two sessions in one repo as ambiguous — the real Chocabloc case', () => {
    const m = classifyMatch(
      [{ pid: 12014, provider:'claude', tty: 'ttys009', cwd: '/Users/me/Chocabloc', host: 'iterm2' }], sessions)[0]!;
    expect(m.quality).toBe('ambiguous');
    expect(m.sessionId).toBeNull();
    expect(m.candidates).toEqual(['a', 'b']);
  });

  it('marks a process whose cwd matches no session as unknown', () => {
    const m = classifyMatch(
      [{ pid: 9, provider:'claude', tty: 'ttys001', cwd: '/Users/me/elsewhere', host: 'vscode' }], sessions)[0]!;
    expect(m.quality).toBe('unknown');
    expect(m.candidates).toEqual([]);
  });

  it('marks a process with no cwd as unknown', () => {
    const m = classifyMatch(
      [{ pid: 9, provider:'claude', tty: null, cwd: null, host: 'unknown' }], sessions)[0]!;
    expect(m.quality).toBe('unknown');
  });
});

describe('applyExactMatches', () => {
  const p = (pid: number, cwd: string, sessionId?: string): LiveProcess => ({
    pid, provider: 'claude', tty: null, cwd, host: 'unknown', ageSeconds: 10, rssBytes: null,
    ...(sessionId ? { liveSession: { sessionId, cwd, startedAtMs: 0, status: null } } : {}),
  });
  const refs = [{ sessionId: 's1', cwd: '/r' }, { sessionId: 's2', cwd: '/r' }];

  it('resolves each process with a live session file to its own session', () => {
    const procs = [p(1, '/r', 's1'), p(2, '/r', 's2')];
    const out = applyExactMatches(procs, classifyMatch(procs, refs));
    expect(out.map(m => [m.pid, m.quality, m.sessionId])).toEqual([[1, 'unique', 's1'], [2, 'unique', 's2']]);
  });

  it('leaves matching untouched when no process has a file', () => {
    const procs = [p(1, '/r'), p(2, '/r')];
    const before = classifyMatch(procs, refs);
    expect(applyExactMatches(procs, before)).toEqual(before);
  });

  it('resolves to a session id the index has never seen', () => {
    const procs = [p(1, '/r', 'brand-new')];
    expect(applyExactMatches(procs, classifyMatch(procs, refs))[0]).toMatchObject({ quality: 'unique', sessionId: 'brand-new' });
  });

  it("removes a claimed id from a neighbour's candidates", () => {
    const procs = [p(1, '/r', 's1'), p(2, '/r')];
    const out = applyExactMatches(procs, classifyMatch(procs, refs));
    expect(out[1]).toMatchObject({ quality: 'unique', sessionId: 's2', candidates: ['s2'] });
  });

  it('keeps a neighbour ambiguous when more than one candidate remains', () => {
    const three = [...refs, { sessionId: 's3', cwd: '/r' }];
    const procs = [p(1, '/r', 's1'), p(2, '/r')];
    expect(applyExactMatches(procs, classifyMatch(procs, three))[1]).toMatchObject({ quality: 'ambiguous', sessionId: null });
  });
});
