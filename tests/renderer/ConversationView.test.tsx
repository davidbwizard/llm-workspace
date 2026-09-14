import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConversationView } from '../../src/renderer/components/ConversationView.tsx';

const turns = [
  { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'run the farm tests', agentId: null },
  { id: 2, ts: '2026-09-12T10:00:05Z', role: 'assistant', text: 'All green. Want me to commit?', agentId: null },
];

beforeEach(() => {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    conversation: async () => turns,
  };
});

describe('ConversationView', () => {
  it('renders both sides of the conversation', async () => {
    render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.getByText('All green. Want me to commit?')).toBeTruthy();
  });

  it('labels who said what, since prose alone never showed the user', async () => {
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    expect(container.querySelector('.turn.assistant')).toBeTruthy();
  });

  it('says so plainly when a session has nothing to show', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = { conversation: async () => [] };
    render(<ConversationView sessionId="empty" />);
    await waitFor(() => expect(screen.getByText(/no conversation/i)).toBeTruthy());
  });

  // Team-lead ruling on this task: OpenSession.sessionId is `string | null`
  // (src/fleet/state.ts:466) and is null whenever the process's cwd matches
  // no transcript, or matches several ambiguously -- the COMMON case on
  // this user's real machine. This must render a DISTINCT, honest message,
  // not the generic empty-array state above: an empty array means "this
  // session said nothing," but null means "we don't even know which
  // session this is" -- conflating the two would print a false claim about
  // a session that might have plenty to say. Both are asserted separately
  // in this file so neither message can silently regress into the other.
  //
  // `match` says WHY sessionId is null, and each of its three states below
  // must render a genuinely different string (bug fix: the old single
  // message said "several open sessions share this process's working
  // directory" for EVERY null case, which is a false claim when the real
  // reason is 'unknown' (no transcript at all) or when a user has exactly
  // one session open and the ambiguity is against HISTORY, not open
  // sessions).
  it('says several RECORDED sessions share the cwd when the match is ambiguous, never "open sessions"', () => {
    render(<ConversationView sessionId={null} match="ambiguous" />);
    expect(screen.getByText(/several recorded sessions/i)).toBeTruthy();
    expect(screen.queryByText(/no conversation/i)).toBeNull();
    expect(screen.queryByText(/open session/i)).toBeNull();
  });

  it('says no transcript has been found yet when the match is unknown, distinct from the ambiguous message', () => {
    render(<ConversationView sessionId={null} match="unknown" />);
    expect(screen.getByText(/no transcript has been found/i)).toBeTruthy();
    expect(screen.queryByText(/several recorded sessions/i)).toBeNull();
  });

  it('falls back to a neutral message, distinct from both above, when sessionId is null with no match info', () => {
    render(<ConversationView sessionId={null} />);
    expect(screen.getByText(/transcript can't be identified/i)).toBeTruthy();
    expect(screen.queryByText(/several recorded sessions/i)).toBeNull();
    expect(screen.queryByText(/no transcript has been found/i)).toBeNull();
    // The exact old bug: a substring-compatible fallback ("Several open
    // sessions share this... transcript can't be identified") would pass
    // every assertion above while still lying about "open sessions" -- this
    // is what actually catches that regression.
    expect(screen.queryByText(/open session/i)).toBeNull();
    expect(screen.queryByText(/^Several/i)).toBeNull();
  });

  it('never calls window.fleet.conversation when sessionId is null', async () => {
    let called = false;
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => { called = true; return []; },
    };
    render(<ConversationView sessionId={null} />);
    // Give any accidental fetch a turn to run before asserting it didn't.
    await Promise.resolve();
    expect(called).toBe(false);
  });
});
