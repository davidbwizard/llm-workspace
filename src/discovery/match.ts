import type { LiveProcess } from './parse.ts';

export type MatchQuality = 'unique' | 'ambiguous' | 'unknown';

export interface SessionRef { sessionId: string; cwd: string | null }

export interface MatchResult {
  pid: number;
  tty: string | null;
  host: LiveProcess['host'];
  sessionId: string | null;
  quality: MatchQuality;
  candidates: string[];
}

/** Spec §7.2. `cwd` resolves to the project DIRECTORY, not to a specific
 *  session file, so two sessions in one repo are indistinguishable this way.
 *  This machine has exactly that case (multiple `claude` pids sharing a cwd
 *  under .../Education/Chocabloc), which is why ambiguity is a first-class
 *  result rather than a tie broken by a guess.
 *
 *  Precision actions — jump-to-terminal, send input — are enabled ONLY on
 *  `unique`. On `ambiguous` the UI offers "Locate manually" with candidates. */
export function classifyMatch(procs: LiveProcess[], sessions: SessionRef[]): MatchResult[] {
  return procs.map(p => {
    const candidates = p.cwd
      ? sessions.filter(s => s.cwd === p.cwd).map(s => s.sessionId)
      : [];
    const quality: MatchQuality =
      candidates.length === 1 ? 'unique' : candidates.length > 1 ? 'ambiguous' : 'unknown';
    return {
      pid: p.pid,
      tty: p.tty,
      host: p.host,
      sessionId: quality === 'unique' ? candidates[0]! : null,
      quality,
      candidates,
    };
  });
}

/** Exact identity beats cwd matching (spec
 *  2026-09-15-exact-session-identity-design.md §3.3). Runs AFTER
 *  classifyMatch, which stays a pure cwd matcher. A process carrying a
 *  verified live session file resolves to that session outright. Its id is
 *  then removed from every other process's candidates -- but that removal
 *  never PROMOTES a neighbour's quality, only ever narrows or empties its
 *  candidates: a claimed id proves which session the exactly-matched
 *  process IS, not which one the neighbour is, since a process can own
 *  several session ids across one or more `/clear`s and only its CURRENT
 *  one is ever visible here. A neighbour whose candidates shrink to zero
 *  becomes `unknown`; one left with any candidates stays `ambiguous`,
 *  never guessed down to a single id by process of elimination. One result
 *  per process, same order. */
export function applyExactMatches(procs: LiveProcess[], matches: MatchResult[]): MatchResult[] {
  const claimed = new Set(procs.flatMap(p => p.liveSession ? [p.liveSession.sessionId] : []));
  if (claimed.size === 0) return matches;
  // Annotated so the literal 'unique' is not widened to string.
  return matches.map((m, i): MatchResult => {
    const exact = procs[i]!.liveSession;
    if (exact) return { ...m, quality: 'unique', sessionId: exact.sessionId, candidates: [exact.sessionId] };
    const candidates = m.candidates.filter(id => !claimed.has(id));
    if (candidates.length === m.candidates.length) return m;
    // Never 'unique' here -- see the doc comment above for why a claimed id
    // cannot stand in for this process's own identity.
    const quality: MatchQuality = candidates.length === 0 ? 'unknown' : 'ambiguous';
    return { ...m, candidates, quality, sessionId: null };
  });
}
