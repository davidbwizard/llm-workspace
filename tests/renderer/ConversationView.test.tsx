import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConversationView } from '../../src/renderer/components/ConversationView.tsx';

const turns = [
  { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'run the farm tests', agentId: null },
  { id: 2, ts: '2026-09-12T10:00:05Z', role: 'assistant', text: 'All green. Want me to commit?', agentId: null },
];

// Same formula the component uses (ConversationView.tsx's formatDate /
// formatTime), so these tests assert against whatever the local timezone
// actually produces rather than a hardcoded clock string.
const fmtDate = (ts: string) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtTime = (ts: string) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

beforeEach(() => {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    conversation: async () => ({ turns, truncated: false }),
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

  // The visual-distinction feature (a long conversation must not read as
  // one undifferentiated wall) hangs entirely off this role class --
  // ConversationView.css.test.ts proves the CSS keyed to it actually
  // differs structurally, not just by colour. This proves the DOM side of
  // that contract: the two roles carry genuinely different classes, not
  // merely that a user turn and an assistant turn both rendered (that
  // weaker claim is already covered by the "renders both sides" test
  // above and would not catch a regression that rendered every turn with
  // the same class).
  it('gives user and assistant turns different classes -- the actual hook the CSS distinction depends on', async () => {
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));
    const [userRow, assistantRow] = [...container.querySelectorAll('.turn')];
    expect(userRow!.className).not.toBe(assistantRow!.className);
    expect(userRow!.classList.contains('user')).toBe(true);
    expect(assistantRow!.classList.contains('assistant')).toBe(true);
  });

  it('says so plainly when a session has nothing to show', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: [], truncated: false }),
    };
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
      conversation: async () => { called = true; return { turns: [], truncated: false }; },
    };
    render(<ConversationView sessionId={null} />);
    // Give any accidental fetch a turn to run before asserting it didn't.
    await Promise.resolve();
    expect(called).toBe(false);
  });

  // Team-lead ruling: this is a catch-up review surface, so it renders
  // newest-first (the fixture below is already in the order conversationFor
  // returns -- newest at index 0 -- and the component must not re-sort it).
  it('renders turns in the order they are given, newest first', async () => {
    const ordered = [
      { id: 3, ts: '2026-09-12T10:00:10Z', role: 'assistant', text: 'newest reply', agentId: null },
      { id: 2, ts: '2026-09-12T10:00:05Z', role: 'user', text: 'middle message', agentId: null },
      { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'oldest message', agentId: null },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: ordered, truncated: false }),
    };
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(3));
    const rendered = [...container.querySelectorAll('.turn .said')].map(el => el.textContent);
    expect(rendered).toEqual(['newest reply', 'middle message', 'oldest message']);
  });

  it('shows a truncation notice only when the fetch reports truncated', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns, truncated: true }),
    };
    render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(screen.getByText(/older turns/i)).toBeTruthy());
  });

  it('shows no truncation notice when the fetch reports not truncated', async () => {
    render(<ConversationView sessionId="s1" />); // default mock: truncated: false
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.queryByText(/older turns/i)).toBeNull();
  });

  it('renders a compact human timestamp on each turn', async () => {
    const [first] = turns;
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelector('.when')).toBeTruthy());
    // Lone/first entry always shows its date -- there is no prior entry to
    // compare against.
    expect(container.querySelector('.when')?.textContent).toBe(`${fmtDate(first!.ts)} ${fmtTime(first!.ts)}`);
  });

  it('does not repeat the date on a second entry from the same day', async () => {
    const sameDay = [
      { id: 1, ts: '2026-09-12T09:00:00Z', role: 'user', text: 'first', agentId: null },
      { id: 2, ts: '2026-09-12T15:30:00Z', role: 'assistant', text: 'second', agentId: null },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: sameDay, truncated: false }),
    };
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.when')).toHaveLength(2));
    const [whenFirst, whenSecond] = [...container.querySelectorAll('.when')];
    expect(whenFirst!.textContent).toBe(`${fmtDate(sameDay[0]!.ts)} ${fmtTime(sameDay[0]!.ts)}`);
    // No date prefix on the second same-day entry -- just the time.
    expect(whenSecond!.textContent).toBe(fmtTime(sameDay[1]!.ts));
  });

  it('shows the date again once the day changes', async () => {
    const twoDays = [
      { id: 1, ts: '2026-09-11T09:00:00Z', role: 'user', text: 'day one', agentId: null },
      { id: 2, ts: '2026-09-12T09:00:00Z', role: 'assistant', text: 'day two', agentId: null },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: twoDays, truncated: false }),
    };
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.when')).toHaveLength(2));
    const [whenFirst, whenSecond] = [...container.querySelectorAll('.when')];
    expect(whenFirst!.textContent).toBe(`${fmtDate(twoDays[0]!.ts)} ${fmtTime(twoDays[0]!.ts)}`);
    expect(whenSecond!.textContent).toBe(`${fmtDate(twoDays[1]!.ts)} ${fmtTime(twoDays[1]!.ts)}`);
  });
});
