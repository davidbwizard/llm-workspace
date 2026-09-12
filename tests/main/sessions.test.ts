import { describe, it, expect, beforeEach } from 'vitest';
import { registerSession, forgetSession, tmuxNameForPid, resolveLiveTmux, clearRegistry } from '../../src/main/sessions.ts';

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
});
