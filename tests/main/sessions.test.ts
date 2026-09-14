import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSession, forgetSession, tmuxNameForPid, resolveLiveTmux, clearRegistry, launchedAtForPid,
  adoptRunningSessions,
} from '../../src/main/sessions.ts';

beforeEach(() => clearRegistry());

describe('session registry', () => {
  it('maps a pid to the name main itself chose', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(tmuxNameForPid(4821)).toBe('llmws-claude-abc');
  });

  it('refuses to register a name this app did not generate', () => {
    expect(() => registerSession(4821, 'someone-elses-session')).toThrow();
    expect(tmuxNameForPid(4821)).toBeNull();
  });

  it('returns null for an unknown or malformed pid', () => {
    expect(tmuxNameForPid(9999)).toBeNull();
    expect(tmuxNameForPid('4821')).toBeNull();
    expect(tmuxNameForPid(-1)).toBeNull();
    expect(tmuxNameForPid(1.5)).toBeNull();
  });

  // The test above passes trivially for -1/1.5 even without a validPid guard,
  // because those keys were never inserted into the map -- a lookup miss
  // looks identical to a rejected lookup. This test forces registerSession to
  // actually accept or reject a malformed pid, so weakening validPid (e.g. to
  // `typeof pid === 'number'`) is caught here even though it survives the
  // test above.
  it('refuses to register a negative or non-integer pid in the first place', () => {
    expect(() => registerSession(-1, 'llmws-claude-abc')).toThrow();
    expect(() => registerSession(1.5, 'llmws-claude-abc')).toThrow();
    expect(tmuxNameForPid(-1)).toBeNull();
    expect(tmuxNameForPid(1.5)).toBeNull();
  });

  it('resolveLiveTmux refuses when the session is gone, even though the map still has it', () => {
    registerSession(4821, 'llmws-claude-abc');
    expect(resolveLiveTmux(4821, { has: () => false })).toBeNull();
    expect(resolveLiveTmux(4821, { has: () => true })).toBe('llmws-claude-abc');
  });

  it('forgets a pid', () => {
    registerSession(4821, 'llmws-claude-abc');
    forgetSession(4821);
    expect(tmuxNameForPid(4821)).toBeNull();
  });

  // Bug 2 (Conversation-identification fix): the registry records WHEN
  // main launched a pid, not just its tmux name -- src/fleet/state.ts's
  // openSessionsLive reads this to disambiguate an otherwise-ambiguous cwd
  // match for a session the app started itself.
  it('records the launch timestamp alongside the tmux name', () => {
    registerSession(4821, 'llmws-claude-abc', 1_700_000_000_000);
    expect(launchedAtForPid(4821)).toBe(1_700_000_000_000);
  });

  it('defaults the launch timestamp to now when none is given', () => {
    const before = Date.now();
    registerSession(4821, 'llmws-claude-abc');
    const after = Date.now();
    expect(launchedAtForPid(4821)).not.toBeNull();
    expect(launchedAtForPid(4821)!).toBeGreaterThanOrEqual(before);
    expect(launchedAtForPid(4821)!).toBeLessThanOrEqual(after);
  });

  it('returns null for an unknown or malformed pid, same as tmuxNameForPid', () => {
    expect(launchedAtForPid(9999)).toBeNull();
    expect(launchedAtForPid('4821')).toBeNull();
    expect(launchedAtForPid(-1)).toBeNull();
  });

  it('forgets the launch timestamp along with the pid', () => {
    registerSession(4821, 'llmws-claude-abc', 1_700_000_000_000);
    forgetSession(4821);
    expect(launchedAtForPid(4821)).toBeNull();
  });

  it('clearRegistry wipes launch timestamps too, not just names', () => {
    registerSession(4821, 'llmws-claude-abc', 1_700_000_000_000);
    clearRegistry();
    expect(launchedAtForPid(4821)).toBeNull();
  });
});

// Bug 3: byPid is otherwise written only at launch, so it starts empty on
// every app restart even though the tmux sessions it named do not --
// leaving every previously-launched session reporting `tmux: false`
// forever. adoptRunningSessions rebuilds it from tmux, the actual source
// of truth.
describe('adoptRunningSessions', () => {
  it('adopts a session present in tmux, so its pid resolves', () => {
    adoptRunningSessions({ listSessionNames: () => ['llmws-claude-abc'], panePid: () => 43741 });
    expect(tmuxNameForPid(43741)).toBe('llmws-claude-abc');
  });

  it('does not adopt a session whose name this app did not generate', () => {
    adoptRunningSessions({ listSessionNames: () => ['someone-elses-session'], panePid: () => 43741 });
    expect(tmuxNameForPid(43741)).toBeNull();
  });

  it("does not register a session whose pane pid can't be read", () => {
    adoptRunningSessions({ listSessionNames: () => ['llmws-claude-abc'], panePid: () => null });
    expect(tmuxNameForPid(43741)).toBeNull();
  });

  // The actual Bug 3 scenario: a stale entry (from an earlier sweep, or
  // from registerSession at launch time) for a session that has since
  // ended must stop resolving on the very next sweep, not linger as a
  // false `tmux: true` until the app happens to restart.
  it('drops a stale entry once its tmux session is no longer in the live list', () => {
    registerSession(43741, 'llmws-claude-abc');
    expect(tmuxNameForPid(43741)).toBe('llmws-claude-abc');

    adoptRunningSessions({ listSessionNames: () => [], panePid: () => null });
    expect(tmuxNameForPid(43741)).toBeNull();
  });

  it('leaves an already-known pid/name pair, and its launch timestamp, untouched', () => {
    registerSession(43741, 'llmws-claude-abc', 1_700_000_000_000);
    adoptRunningSessions({ listSessionNames: () => ['llmws-claude-abc'], panePid: () => 43741 });
    expect(tmuxNameForPid(43741)).toBe('llmws-claude-abc');
    expect(launchedAtForPid(43741)).toBe(1_700_000_000_000);
  });

  // A pid genuinely new this sweep (this run never launched it) must not
  // get a fabricated launch timestamp -- openSessionsLive's disambiguation
  // (src/fleet/state.ts) must fall back to ordinary cwd matching for it,
  // never a guessed launch moment.
  it('adopts a brand-new pid with no launch timestamp at all', () => {
    adoptRunningSessions({ listSessionNames: () => ['llmws-claude-abc'], panePid: () => 43741 });
    expect(launchedAtForPid(43741)).toBeNull();
  });
});
