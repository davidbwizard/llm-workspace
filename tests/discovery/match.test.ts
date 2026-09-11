import { describe, it, expect } from 'vitest';
import { classifyMatch } from '../../src/discovery/match.ts';

const sessions = [
  { sessionId: 'a', cwd: '/Users/me/Chocabloc' },
  { sessionId: 'b', cwd: '/Users/me/Chocabloc' },
  { sessionId: 'c', cwd: '/Users/me/trip-planner' },
];

describe('classifyMatch', () => {
  it('marks a single-session directory as unique', () => {
    const m = classifyMatch(
      [{ pid: 1, tty: 'ttys016', cwd: '/Users/me/trip-planner', host: 'iterm2' }], sessions)[0]!;
    expect(m).toMatchObject({ pid: 1, quality: 'unique', sessionId: 'c' });
  });

  it('marks two sessions in one repo as ambiguous — the real Chocabloc case', () => {
    const m = classifyMatch(
      [{ pid: 12014, tty: 'ttys009', cwd: '/Users/me/Chocabloc', host: 'iterm2' }], sessions)[0]!;
    expect(m.quality).toBe('ambiguous');
    expect(m.sessionId).toBeNull();
    expect(m.candidates).toEqual(['a', 'b']);
  });

  it('marks a process whose cwd matches no session as unknown', () => {
    const m = classifyMatch(
      [{ pid: 9, tty: 'ttys001', cwd: '/Users/me/elsewhere', host: 'vscode' }], sessions)[0]!;
    expect(m.quality).toBe('unknown');
    expect(m.candidates).toEqual([]);
  });

  it('marks a process with no cwd as unknown', () => {
    const m = classifyMatch(
      [{ pid: 9, tty: null, cwd: null, host: 'unknown' }], sessions)[0]!;
    expect(m.quality).toBe('unknown');
  });
});
