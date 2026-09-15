import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConversationView, nearOlderEdge } from '../../src/renderer/components/ConversationView.tsx';

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
    conversation: async () => ({ turns, nextCursor: null }),
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
      conversation: async () => ({ turns: [], nextCursor: null }),
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
      conversation: async () => { called = true; return { turns: [], nextCursor: null }; },
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
      conversation: async () => ({ turns: ordered, nextCursor: null }),
    };
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(3));
    const rendered = [...container.querySelectorAll('.turn .said')].map(el => el.textContent);
    expect(rendered).toEqual(['newest reply', 'middle message', 'oldest message']);
  });

  // Lazy-loading (50 turns/page) supersedes the old truncation notice --
  // nothing is hidden any more, so instead of an apology there is a plain
  // end-of-history fact once nextCursor genuinely runs out.
  it('shows an end-of-history marker once the fetch reports nextCursor null', async () => {
    render(<ConversationView sessionId="s1" />); // default mock: nextCursor: null
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.getByText(/beginning of this session/i)).toBeTruthy();
  });

  it('does not show the end-of-history marker while more pages remain', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns, nextCursor: { ts: '2026-09-12T10:00:00Z', id: 1 } }),
    };
    render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.queryByText(/beginning of this session/i)).toBeNull();
  });

  // Scrolling near the bottom is the trigger (see nearOlderEdge's own doc
  // comment on why bottom, not top, is the older end in this newest-first
  // layout). jsdom computes no real layout, so scrollHeight/clientHeight
  // are stubbed directly on the node (Object.defineProperty -- verified
  // assigning them any other way throws, since jsdom exposes them as
  // getter-only) and only scrollTop, which jsdom genuinely implements, is
  // set through fireEvent's target.
  function stubScrollGeometry(el: Element, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  }

  it('fetches the next older page and appends it once the reader scrolls near the bottom', async () => {
    const olderCursor = { ts: '2026-09-12T09:59:00Z', id: 0 };
    const calls: Array<unknown[]> = [];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        if (cursor === undefined) return { turns, nextCursor: olderCursor };
        return {
          turns: [{ id: 0, ts: '2026-09-12T09:58:00Z', role: 'user', text: 'an older turn', agentId: null }],
          nextCursor: null,
        };
      },
    };
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    const scroller = container.querySelector('.conv')!;
    stubScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 400 } }); // distance from bottom: 100, under the 150px threshold

    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(3));
    // Appended after the existing turns, not prepended -- newest-first
    // means the older page continues at the bottom, not the top.
    const said = [...container.querySelectorAll('.turn .said')].map(el => el.textContent);
    expect(said).toEqual(['run the farm tests', 'All green. Want me to commit?', 'an older turn']);
    expect(calls).toEqual([['s1', undefined], ['s1', olderCursor]]);
    await waitFor(() => expect(screen.getByText(/beginning of this session/i)).toBeTruthy());
  });

  it('does not fire a second fetch while one is already in flight', async () => {
    const calls: Array<unknown[]> = [];
    let resolveSecondCall: (page: unknown) => void = () => {};
    const secondCallPromise = new Promise(resolve => { resolveSecondCall = resolve; });
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        if (cursor === undefined) return { turns, nextCursor: { ts: '2026-09-12T09:59:00Z', id: 0 } };
        return secondCallPromise; // deliberately left unresolved
      },
    };
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    const scroller = container.querySelector('.conv')!;
    stubScrollGeometry(scroller, { scrollHeight: 1000, clientHeight: 500 });
    // Two scroll events in a row, both past the threshold, before the
    // in-flight fetch has any chance to resolve -- exactly the burst a
    // real trackpad or momentum scroll produces.
    fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
    fireEvent.scroll(scroller, { target: { scrollTop: 420 } });
    await waitFor(() => expect(screen.getByText(/loading more/i)).toBeTruthy());

    // Exactly one loadMore call, not two, alongside the initial page-1 call.
    expect(calls).toEqual([['s1', undefined], ['s1', { ts: '2026-09-12T09:59:00Z', id: 0 }]]);

    resolveSecondCall({ turns: [], nextCursor: null });
    await waitFor(() => expect(screen.getByText(/beginning of this session/i)).toBeTruthy());
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
      conversation: async () => ({ turns: sameDay, nextCursor: null }),
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
      conversation: async () => ({ turns: twoDays, nextCursor: null }),
    };
    const { container } = render(<ConversationView sessionId="s1" />);
    await waitFor(() => expect(container.querySelectorAll('.when')).toHaveLength(2));
    const [whenFirst, whenSecond] = [...container.querySelectorAll('.when')];
    expect(whenFirst!.textContent).toBe(`${fmtDate(twoDays[0]!.ts)} ${fmtTime(twoDays[0]!.ts)}`);
    expect(whenSecond!.textContent).toBe(`${fmtDate(twoDays[1]!.ts)} ${fmtTime(twoDays[1]!.ts)}`);
  });
});

describe('nearOlderEdge', () => {
  it('is true once the distance from the bottom drops under the threshold', () => {
    expect(nearOlderEdge({ scrollTop: 400, scrollHeight: 1000, clientHeight: 500 })).toBe(true); // 100px left
  });

  it('is false while comfortably far from the bottom', () => {
    expect(nearOlderEdge({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 })).toBe(false); // 500px left
  });

  it('is true right at the exact bottom', () => {
    expect(nearOlderEdge({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(true); // 0px left
  });

  it('respects a caller-supplied threshold rather than only the default', () => {
    expect(nearOlderEdge({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }, 600)).toBe(true); // 500 < 600
  });
});
