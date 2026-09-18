import { describe, it, expect } from 'vitest';
import { classifyMatch, applyExactMatches, rolloutSessionIds, type RolloutThread } from '../../src/discovery/match.ts';
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
    expect(out[1]).toMatchObject({ quality: 'ambiguous', sessionId: null, candidates: ['s2'] });
  });

  it("drops a neighbour to unknown when its only candidate is claimed", () => {
    const single = [{ sessionId: 's1', cwd: '/r' }];
    const procs = [p(1, '/r', 's1'), p(2, '/r')];
    const out = applyExactMatches(procs, classifyMatch(procs, single));
    expect(out[1]).toMatchObject({ quality: 'unknown', sessionId: null, candidates: [] });
  });

  it('keeps a neighbour ambiguous when more than one candidate remains', () => {
    const three = [...refs, { sessionId: 's3', cwd: '/r' }];
    const procs = [p(1, '/r', 's1'), p(2, '/r')];
    expect(applyExactMatches(procs, classifyMatch(procs, three))[1]).toMatchObject({ quality: 'ambiguous', sessionId: null });
  });
});

// Codex exact identity from the rollouts a process holds open (measured
// 2026-09-18: a Codex CLI whose folder was moved mid-session keeps the OLD
// cwd in its session_meta, so cwd matching can never find it).
describe('rolloutSessionIds', () => {
  const codex = (pid: number, openRollouts?: string[]): LiveProcess => ({
    pid, provider: 'codex', tty: null, cwd: '/new/place', host: 'unknown', ageSeconds: 10, rssBytes: null,
    ...(openRollouts ? { openRollouts } : {}),
  });
  const threads = new Map<string, RolloutThread>([
    ['/s/rollout-root.jsonl', { sessionId: 'S', root: true }],
    ['/s/rollout-sub1.jsonl', { sessionId: 'S', root: false }],
    ['/s/rollout-sub2.jsonl', { sessionId: 'S', root: false }],
    ['/s/rollout-other-root.jsonl', { sessionId: 'T', root: true }],
    ['/s/rollout-other-sub.jsonl', { sessionId: 'T', root: false }],
    ['/s/rollout-resumed-root.jsonl', { sessionId: 'S', root: true }],
  ]);

  it('picks the root thread among several subagent rollouts open alongside it', () => {
    const got = rolloutSessionIds([codex(1, ['/s/rollout-sub1.jsonl', '/s/rollout-root.jsonl', '/s/rollout-sub2.jsonl'])], threads);
    expect(got).toEqual(new Map([[1, 'S']]));
  });

  it('never takes a session from a subagent rollout alone', () => {
    expect(rolloutSessionIds([codex(1, ['/s/rollout-other-sub.jsonl'])], threads)).toEqual(new Map());
  });

  it('ignores a rollout the index does not know', () => {
    expect(rolloutSessionIds([codex(1, ['/s/rollout-unknown.jsonl'])], threads)).toEqual(new Map());
    expect(rolloutSessionIds([codex(1, ['/s/rollout-unknown.jsonl', '/s/rollout-root.jsonl'])], threads))
      .toEqual(new Map([[1, 'S']]));
  });

  it('gives no answer when the open root rollouts name two different sessions', () => {
    expect(rolloutSessionIds([codex(1, ['/s/rollout-root.jsonl', '/s/rollout-other-root.jsonl'])], threads)).toEqual(new Map());
  });

  it('still answers when two open root rollouts name the same session', () => {
    expect(rolloutSessionIds([codex(1, ['/s/rollout-root.jsonl', '/s/rollout-resumed-root.jsonl'])], threads))
      .toEqual(new Map([[1, 'S']]));
  });

  it('answers per process, and skips processes with no open rollouts or that are not Codex', () => {
    const claude: LiveProcess = { ...codex(3, ['/s/rollout-root.jsonl']), provider: 'claude' };
    expect(rolloutSessionIds([codex(1, ['/s/rollout-other-root.jsonl']), codex(2), claude], threads))
      .toEqual(new Map([[1, 'T']]));
  });
});

describe('applyExactMatches with open-rollout identity', () => {
  const codex = (pid: number, cwd: string): LiveProcess => ({
    pid, provider: 'codex', tty: null, cwd, host: 'unknown', ageSeconds: 10, rssBytes: null,
  });

  it('matches a process whose cwd differs from its session cwd (the moved-folder case)', () => {
    const procs = [codex(1, '/Users/me/Education/farm')];
    const refs = [{ sessionId: 'S', cwd: '/Users/me/David/farm' }];
    const out = applyExactMatches(procs, classifyMatch(procs, refs), new Map([[1, 'S']]));
    expect(out[0]).toMatchObject({ pid: 1, quality: 'unique', sessionId: 'S', candidates: ['S'] });
  });

  it('beats a cwd match that names a different session', () => {
    const procs = [codex(1, '/new')];
    const refs = [{ sessionId: 'other', cwd: '/new' }];
    expect(applyExactMatches(procs, classifyMatch(procs, refs), new Map([[1, 'S']]))[0])
      .toMatchObject({ quality: 'unique', sessionId: 'S' });
  });

  it("narrows a neighbour's candidates exactly as a live session file does", () => {
    const procs = [codex(1, '/r'), codex(2, '/r')];
    const refs = [{ sessionId: 's1', cwd: '/r' }, { sessionId: 's2', cwd: '/r' }, { sessionId: 's3', cwd: '/r' }];
    const out = applyExactMatches(procs, classifyMatch(procs, refs), new Map([[1, 's1']]));
    expect(out[1]).toMatchObject({ quality: 'ambiguous', sessionId: null, candidates: ['s2', 's3'] });
  });

  it('changes nothing when no process has an identity', () => {
    const procs = [codex(1, '/r')];
    const before = classifyMatch(procs, [{ sessionId: 's1', cwd: '/r' }]);
    expect(applyExactMatches(procs, before, new Map())).toEqual(before);
  });
});
