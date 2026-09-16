import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { ConversationView, nearOlderEdge, nearBottom, restoredScrollTop, mergeNewest } from '../../src/renderer/components/ConversationView.tsx';

const turns = [
  { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'run the farm tests', steps: [] },
  { id: 2, ts: '2026-09-12T10:00:05Z', role: 'assistant', text: 'All green. Want me to commit?', steps: [] },
];

// Same formula the component uses (ConversationView.tsx's formatDate /
// formatTime), so these tests assert against whatever the local timezone
// actually produces rather than a hardcoded clock string.
const fmtDate = (ts: string) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtTime = (ts: string) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// Every test renders the pane for a Claude session unless it says
// otherwise. One helper, so the component's required props live in one
// place rather than in twenty-odd render calls.
function renderConv(props: Partial<React.ComponentProps<typeof ConversationView>> = {}) {
  return render(
    <ConversationView sessionId="s1" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} {...props} />,
  );
}

beforeEach(() => {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    conversation: async () => ({ turns, nextCursor: null }),
  };
});

describe('ConversationView', () => {
  it('renders both sides of the conversation', async () => {
    renderConv();
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.getByText('All green. Want me to commit?')).toBeTruthy();
  });

  it('labels who said what, since prose alone never showed the user', async () => {
    const { container } = renderConv();
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
    const { container } = renderConv();
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
    renderConv({ sessionId: 'empty' });
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
    renderConv({ sessionId: null, match: 'ambiguous' });
    expect(screen.getByText(/several recorded sessions/i)).toBeTruthy();
    expect(screen.queryByText(/no conversation/i)).toBeNull();
    expect(screen.queryByText(/open session/i)).toBeNull();
  });

  it('says no transcript has been found yet when the match is unknown, distinct from the ambiguous message', () => {
    renderConv({ sessionId: null, match: 'unknown' });
    expect(screen.getByText(/no transcript has been found/i)).toBeTruthy();
    expect(screen.queryByText(/several recorded sessions/i)).toBeNull();
  });

  it('falls back to a neutral message, distinct from both above, when sessionId is null with no match info', () => {
    renderConv({ sessionId: null });
    expect(screen.getByText(/transcript can't be identified/i)).toBeTruthy();
    expect(screen.queryByText(/several recorded sessions/i)).toBeNull();
    expect(screen.queryByText(/no transcript has been found/i)).toBeNull();
    // The exact old bug: a substring-compatible fallback ("Several open
    // sessions share this... transcript can't be identified") would pass
    // every assertion above while still lying about "open sessions" -- this
    // is what actually catches that regression.
    expect(screen.queryByText(/open session/i)).toBeNull();
    expect(screen.queryByText(/^Several/i)).toBeNull();
    expect(screen.getByText(/transcript can't be identified/i).className).toBe('convnote');
  });

  it('never calls window.fleet.conversation when sessionId is null', async () => {
    let called = false;
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => { called = true; return { turns: [], nextCursor: null }; },
    };
    renderConv({ sessionId: null });
    // Give any accidental fetch a turn to run before asserting it didn't.
    await Promise.resolve();
    expect(called).toBe(false);
  });

  // Chat order (spec §3.1): oldest at the top, newest at the bottom, with
  // the message box underneath. conversationFor already returns each page
  // in that order, so the component must not re-sort it.
  it('renders turns in the order they are given, oldest first', async () => {
    const ordered = [
      { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'oldest message', steps: [] },
      { id: 2, ts: '2026-09-12T10:00:05Z', role: 'user', text: 'middle message', steps: [] },
      { id: 3, ts: '2026-09-12T10:00:10Z', role: 'assistant', text: 'newest reply', steps: [] },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: ordered, nextCursor: null }),
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(3));
    const rendered = [...container.querySelectorAll('.turn .turn-text')].map(el => el.textContent);
    expect(rendered).toEqual(['oldest message', 'middle message', 'newest reply']);
  });

  // Lazy-loading (50 turns/page) supersedes the old truncation notice --
  // nothing is hidden any more, so instead of an apology there is a plain
  // end-of-history fact once nextCursor genuinely runs out.
  it('shows an end-of-history marker once the fetch reports nextCursor null', async () => {
    renderConv(); // default mock: nextCursor: null
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.getByText(/beginning of this session/i)).toBeTruthy();
  });

  it('does not show the end-of-history marker while more pages remain', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns, nextCursor: { ts: '2026-09-12T10:00:00Z', id: 1 } }),
    };
    renderConv();
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.queryByText(/beginning of this session/i)).toBeNull();
  });

  // Bug fix: Task 1 flipped the render loop to oldest-first but left this
  // marker where the old newest-first layout put it -- below the turns,
  // where a "beginning of history" line reads as a page footer under the
  // NEWEST message. A text-presence check alone would have passed against
  // that bug, so this asserts actual DOM order, the way the meta-row test
  // above does.
  it('renders the end-of-history line above the oldest turn, not below the newest', async () => {
    const { container } = renderConv(); // default mock: nextCursor: null
    await waitFor(() => expect(screen.getByText(/beginning of this session/i)).toBeTruthy());
    const marker = screen.getByText(/beginning of this session/i);
    const oldestTurn = container.querySelector('.turn')!;
    expect(marker.compareDocumentPosition(oldestTurn)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  // Older pages PREPEND -- they arrive at the top -- so the spinner
  // announcing one must be where the content will appear, not where the
  // old newest-first layout put it.
  it('renders "Loading more..." above the turns while an older page is in flight', async () => {
    let resolveOlder: (page: unknown) => void = () => {};
    const olderPromise = new Promise(resolve => { resolveOlder = resolve; });
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (_sessionId: string, cursor?: unknown) => {
        if (cursor === undefined) return { turns, nextCursor: { ts: '2026-09-12T09:59:00Z', id: 0 } };
        return olderPromise;
      },
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    const scroller = container.querySelector('.conv')!;
    fireEvent.scroll(scroller, { target: { scrollTop: 40 } });

    const loadingMarker = await screen.findByText(/loading more/i);
    const oldestTurn = container.querySelector('.turn')!;
    expect(loadingMarker.compareDocumentPosition(oldestTurn)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    resolveOlder({ turns: [], nextCursor: null }); // let the pending fetch settle
    await waitFor(() => expect(screen.queryByText(/loading more/i)).toBeNull());
  });

  // Bug fix: a conversation shorter than the pane must sit at the bottom,
  // not float at the top with empty space below -- but the notes branch
  // (loading, empty, "cannot identify this session") must NOT be pinned: a
  // one-line status floating at the bottom of an empty pane reads as
  // broken, not as a chat.
  it('wraps the turns stack in the bottom-pinning element', async () => {
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));
    expect(container.querySelector('.turn')!.closest('.convstack')).toBeTruthy();
  });

  it('does not wrap a notes message in the bottom-pinning element', () => {
    const { container } = renderConv({ sessionId: null });
    const note = container.querySelector('.convnote')!;
    expect(note.closest('.convstack')).toBeNull();
  });

  it('fetches the next older page and PREPENDS it once the reader scrolls near the top', async () => {
    const olderCursor = { ts: '2026-09-12T09:59:00Z', id: 0 };
    const calls: Array<unknown[]> = [];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        if (cursor === undefined) return { turns, nextCursor: olderCursor };
        return {
          turns: [{ id: 0, ts: '2026-09-12T09:58:00Z', role: 'user', text: 'an older turn', steps: [] }],
          nextCursor: null,
        };
      },
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    const scroller = container.querySelector('.conv')!;
    fireEvent.scroll(scroller, { target: { scrollTop: 40 } }); // inside the 150px top threshold

    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(3));
    // Prepended, not appended: oldest-at-top means the older page
    // continues at the TOP. This is the exact direction the old
    // append-only trick got right for the old layout and wrong for this one.
    const said = [...container.querySelectorAll('.turn .turn-text')].map(el => el.textContent);
    expect(said).toEqual(['an older turn', 'run the farm tests', 'All green. Want me to commit?']);
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
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    const scroller = container.querySelector('.conv')!;
    // Two scroll events in a row, both past the threshold, before the
    // in-flight fetch has any chance to resolve -- exactly the burst a
    // real trackpad or momentum scroll produces.
    fireEvent.scroll(scroller, { target: { scrollTop: 40 } });
    fireEvent.scroll(scroller, { target: { scrollTop: 20 } });
    await waitFor(() => expect(screen.getByText(/loading more/i)).toBeTruthy());

    // Exactly one loadMore call, not two, alongside the initial page-1 call.
    expect(calls).toEqual([['s1', undefined], ['s1', { ts: '2026-09-12T09:59:00Z', id: 0 }]]);

    resolveSecondCall({ turns: [], nextCursor: null });
    await waitFor(() => expect(screen.getByText(/beginning of this session/i)).toBeTruthy());
  });

  // Regression: switching sessions must not let a slow older-page fetch for
  // the OLD session land on whatever session is open now. Without a
  // staleness guard in loadMore, resolving session A's older-page fetch
  // AFTER session B's own page has loaded would prepend A's turn onto B's
  // page and silently overwrite B's nextCursor with A's.
  it('drops a stale older-page fetch if the reader switches sessions before it resolves', async () => {
    let resolveOlderA: (page: unknown) => void = () => {};
    const olderAPromise = new Promise(resolve => { resolveOlderA = resolve; });
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        if (sessionId === 's1' && cursor === undefined) {
          return { turns, nextCursor: { ts: '2026-09-12T09:59:00Z', id: 0 } };
        }
        if (sessionId === 's1') return olderAPromise; // s1's older page, held pending
        if (sessionId === 's2' && cursor === undefined) {
          return {
            turns: [{ id: 5, ts: '2026-09-13T10:00:00Z', role: 'user', text: 'session B turn', steps: [] }],
            // Session B genuinely has more history -- if the stale fetch's
            // nextCursor:null below clobbers this, the end-of-history
            // marker would wrongly appear for a session that has one.
            nextCursor: { ts: '2026-09-13T09:00:00Z', id: 4 },
          };
        }
        throw new Error(`unexpected fetch: ${sessionId} ${String(cursor)}`);
      },
    };
    const { container, rerender } = renderConv({ sessionId: 's1' });
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    const scroller = container.querySelector('.conv')!;
    fireEvent.scroll(scroller, { target: { scrollTop: 40 } }); // starts s1's older-page fetch, left pending

    rerender(<ConversationView sessionId="s2" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText('session B turn')).toBeTruthy());

    // Let session A's older-page fetch resolve well after session B has
    // landed -- exactly the ordering a slow network response can produce.
    await act(async () => {
      resolveOlderA({
        turns: [{ id: 0, ts: '2026-09-12T09:58:00Z', role: 'user', text: 'an older turn from session A', steps: [] }],
        nextCursor: null,
      });
      // A real macrotask tick: the JS event loop always drains every
      // pending microtask -- including the async-function and .then/.finally
      // hops between the mock resolving and loadMore's callback running --
      // before running a timer callback, so this is enough to guarantee the
      // stale continuation, guarded or not, has already run by the time we
      // assert below.
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const said = [...container.querySelectorAll('.turn .turn-text')].map(el => el.textContent);
    expect(said).toEqual(['session B turn']);
    expect(screen.queryByText(/beginning of this session/i)).toBeNull();
  });

  // Out-of-plan fix, task-catch-brief.md: a rejected mount fetch used to
  // leave `page` at null forever, which the render's page===null branch
  // reads as "Loading..." -- a lie, since nothing is loading and nothing
  // ever will. This is the one call site where a rejection must become
  // visible UI, not just a log line.
  it('shows an error note instead of "Loading..." forever when the mount fetch rejects', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => { throw new Error('fetch failed'); },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderConv();
    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeTruthy());
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(consoleError).toHaveBeenCalledWith('Conversation mount fetch failed:', expect.any(Error));
    consoleError.mockRestore();
  });

  // The alive guard: a slow mount fetch for a session the reader has
  // already left must not put the NEW session's pane into an error state.
  // Same controlled-promise technique as the stale-older-page-fetch
  // regression above, applied to the mount fetch instead of loadMore's.
  it('does not leak an error onto the newly-selected session when an old mount fetch rejects after the switch', async () => {
    let rejectA: (err: unknown) => void = () => {};
    const pendingA = new Promise((_resolve, reject) => { rejectA = reject; });
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string) => {
        if (sessionId === 's1') return pendingA; // s1's mount fetch, held pending
        if (sessionId === 's2') {
          return {
            turns: [{ id: 5, ts: '2026-09-13T10:00:00Z', role: 'user', text: 'session B turn', steps: [] }],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected fetch: ${sessionId}`);
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = renderConv({ sessionId: 's1' });

    rerender(<ConversationView sessionId="s2" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText('session B turn')).toBeTruthy());

    // Let session A's mount fetch reject well after session B has landed.
    await act(async () => {
      rejectA(new Error('s1 fetch failed'));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(screen.getByText('session B turn')).toBeTruthy();
    // Still logged -- an old fetch failing is real information even when
    // it can no longer act on the screen -- unlike the state it's guarded
    // out of, the log itself isn't scoped to "alive".
    expect(consoleError).toHaveBeenCalledWith('Conversation mount fetch failed:', expect.any(Error));
    consoleError.mockRestore();
  });

  it('clears a previous session\'s error once the reader switches to a session that loads fine', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string) => {
        if (sessionId === 's1') throw new Error('s1 fetch failed');
        return { turns, nextCursor: null };
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = renderConv({ sessionId: 's1' });
    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeTruthy());

    rerender(<ConversationView sessionId="s2" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText('run the farm tests')).toBeTruthy());
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    consoleError.mockRestore();
  });

  // loadMore's existing .finally() clears loadingMoreRef and setLoadingMore
  // regardless of outcome -- that's what makes this path self-heal on the
  // reader's next scroll, so the retry below must succeed with no other
  // recovery logic.
  it('keeps its turns and clears the loading indicator when loadMore rejects, then retries on the next scroll', async () => {
    const olderCursor = { ts: '2026-09-12T09:59:00Z', id: 0 };
    const calls: Array<unknown[]> = [];
    let attempt = 0;
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        if (cursor === undefined) return { turns, nextCursor: olderCursor };
        attempt += 1;
        if (attempt === 1) throw new Error('network blip');
        return {
          turns: [{ id: 0, ts: '2026-09-12T09:58:00Z', role: 'user', text: 'an older turn', steps: [] }],
          nextCursor: null,
        };
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    const scroller = container.querySelector('.conv')!;
    fireEvent.scroll(scroller, { target: { scrollTop: 40 } });

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      'Conversation load-more fetch failed:', expect.any(Error)));
    await waitFor(() => expect(screen.queryByText(/loading more/i)).toBeNull());
    expect([...container.querySelectorAll('.turn .turn-text')].map(el => el.textContent))
      .toEqual(['run the farm tests', 'All green. Want me to commit?']);
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();

    // Retry: scrolling near the top again fires another fetch, proving
    // loadingMoreRef was cleared by .finally() despite the rejection.
    fireEvent.scroll(scroller, { target: { scrollTop: 40 } });
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(3));
    expect(calls).toEqual([['s1', undefined], ['s1', olderCursor], ['s1', olderCursor]]);

    consoleError.mockRestore();
  });

  it('renders a compact human timestamp on each turn', async () => {
    const [first] = turns;
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelector('.when')).toBeTruthy());
    // Lone/first entry always shows its date -- there is no prior entry to
    // compare against.
    expect(container.querySelector('.when')?.textContent).toBe(`${fmtDate(first!.ts)} ${fmtTime(first!.ts)}`);
  });

  it('does not repeat the date on a second entry from the same day', async () => {
    const sameDay = [
      { id: 1, ts: '2026-09-12T09:00:00Z', role: 'user', text: 'first', steps: [] },
      { id: 2, ts: '2026-09-12T15:30:00Z', role: 'assistant', text: 'second', steps: [] },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: sameDay, nextCursor: null }),
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.when')).toHaveLength(2));
    const [whenFirst, whenSecond] = [...container.querySelectorAll('.when')];
    expect(whenFirst!.textContent).toBe(`${fmtDate(sameDay[0]!.ts)} ${fmtTime(sameDay[0]!.ts)}`);
    // No date prefix on the second same-day entry -- just the time.
    expect(whenSecond!.textContent).toBe(fmtTime(sameDay[1]!.ts));
  });

  it('shows the date again once the day changes', async () => {
    const twoDays = [
      { id: 1, ts: '2026-09-11T09:00:00Z', role: 'user', text: 'day one', steps: [] },
      { id: 2, ts: '2026-09-12T09:00:00Z', role: 'assistant', text: 'day two', steps: [] },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: twoDays, nextCursor: null }),
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.when')).toHaveLength(2));
    const [whenFirst, whenSecond] = [...container.querySelectorAll('.when')];
    expect(whenFirst!.textContent).toBe(`${fmtDate(twoDays[0]!.ts)} ${fmtTime(twoDays[0]!.ts)}`);
    expect(whenSecond!.textContent).toBe(`${fmtDate(twoDays[1]!.ts)} ${fmtTime(twoDays[1]!.ts)}`);
  });
});

function showOne(turn: Record<string, unknown>) {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    conversation: async () => ({ turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', steps: [], ...turn }], nextCursor: null }),
  };
  return renderConv();
}

describe('ConversationView -- agent replies render as markdown', () => {
  it('renders emphasis, lists, fenced code and GFM tables as real elements', async () => {
    const md = [
      'Done. **All green.**',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| file | status |',
      '| --- | --- |',
      '| a.ts | ok |',
    ].join('\n');
    const { container } = showOne({ role: 'assistant', text: md });
    await waitFor(() => expect(container.querySelector('.turn.assistant strong')).toBeTruthy());
    expect(container.querySelector('.turn.assistant strong')!.textContent).toBe('All green.');
    expect(container.querySelectorAll('.turn.assistant li')).toHaveLength(2);
    expect(container.querySelector('.turn.assistant pre code')!.textContent).toContain('const x = 1;');
    expect(container.querySelector('.turn.assistant table td')!.textContent).toBe('a.ts');
  });

  it('keeps raw HTML escaped: it shows as text and never becomes an element', async () => {
    const { container } = showOne({
      role: 'assistant', text: 'use <b>bold</b> here <script>alert(1)</script> <img src="https://x.example/p.png">',
    });
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    const turn = container.querySelector('.turn.assistant')!;
    expect(turn.querySelector('b, script, img')).toBeNull();
    expect(turn.textContent).toContain('<b>bold</b>');
  });

  // src/main/index.ts denies window.open (opening only https externally) and
  // blocks will-navigate. target=_blank routes a click through the window-open
  // handler so it never becomes a navigation of the app window.
  it('renders links so a click opens outside the app window, never navigating it', async () => {
    const { container } = showOne({ role: 'assistant', text: 'See [the docs](https://example.com/docs).' });
    await waitFor(() => expect(container.querySelector('.turn.assistant a')).toBeTruthy());
    const a = container.querySelector('.turn.assistant a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/docs');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toMatch(/noopener/);
    expect(a.getAttribute('rel')).toMatch(/noreferrer/);
  });

  it('strips a javascript: link target', async () => {
    const { container } = showOne({ role: 'assistant', text: '[click](javascript:alert(1))' });
    await waitFor(() => expect(container.querySelector('.turn.assistant a')).toBeTruthy());
    expect(container.querySelector('.turn.assistant a')!.getAttribute('href') ?? '').not.toMatch(/javascript/i);
  });

  it('never loads a markdown image -- it shows the alt text instead', async () => {
    const { container } = showOne({ role: 'assistant', text: 'Look: ![the failing screen](https://tracker.example/pixel.png)' });
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.turn.assistant')!.textContent).toContain('the failing screen');
    expect(container.innerHTML).not.toContain('tracker.example');
  });

  it('leaves the human prompt as plain text, not markdown', async () => {
    const { container } = showOne({ role: 'user', text: '**not bold** <b>x</b>' });
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    expect(container.querySelector('.turn.user strong, .turn.user b')).toBeNull();
    expect(container.querySelector('.turn.user .turn-text')!.textContent).toBe('**not bold** <b>x</b>');
  });
});

describe('ConversationView -- steps under a reply', () => {
  const steps = [
    { id: 10, ts: '2026-09-12T09:59:00Z', text: 'Reading the file.' },
    { id: 11, ts: '2026-09-12T09:59:30Z', text: 'Running `npm test`.' },
  ];

  it('collapses the narration behind a real button that says how many steps there are', async () => {
    showOne({ role: 'assistant', text: 'All green.', steps });
    const button = await screen.findByRole('button', { name: '+ 2 steps' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Reading the file.')).toBeNull();
  });

  it('expands the steps, oldest first, and collapses them again', async () => {
    const { container } = showOne({ role: 'assistant', text: 'All green.', steps });
    const button = await screen.findByRole('button', { name: '+ 2 steps' });

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const list = container.querySelector('.steps-list')!;
    expect(button.getAttribute('aria-controls')).toBe(list.id);
    expect([...list.querySelectorAll('.step')].map(s => s.textContent)).toEqual(['Reading the file.', 'Running npm test.']);
    expect(list.querySelector('code')!.textContent).toBe('npm test');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.steps-list')).toBeNull();
  });

  it('says "1 step" for a single step', async () => {
    showOne({ role: 'assistant', text: 'ok', steps: [steps[0]] });
    expect(await screen.findByRole('button', { name: '+ 1 step' })).toBeTruthy();
  });

  it('shows no steps button when the reply had no narration', async () => {
    const { container } = showOne({ role: 'assistant', text: 'ok' });
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// Every number below is asserted as a number, never through a rendered
// element: jsdom computes no layout, so scrollHeight/clientHeight are
// getter-only there and no real scroll position exists to measure. Keeping
// the arithmetic in exported pure functions is what makes it testable at
// all -- the same shape nearOlderEdge already had before this change.
describe('nearOlderEdge -- the older end is now the TOP', () => {
  it('is true once the reader is within the threshold of the top', () => {
    expect(nearOlderEdge({ scrollTop: 100 })).toBe(true);
  });

  it('is true at the exact top', () => {
    expect(nearOlderEdge({ scrollTop: 0 })).toBe(true);
  });

  it('is false while comfortably below the top', () => {
    expect(nearOlderEdge({ scrollTop: 400 })).toBe(false);
  });

  // The regression this replaces: with oldest-at-bottom, being near the
  // BOTTOM used to mean "running low on loaded history". It no longer does,
  // and a view that still fired there would page backwards at exactly the
  // moment the reader reached the newest message.
  it('is false at the bottom of a long pane, however far down that is', () => {
    expect(nearOlderEdge({ scrollTop: 100_000 })).toBe(false);
  });

  it('respects a caller-supplied threshold rather than only the default', () => {
    expect(nearOlderEdge({ scrollTop: 400 }, 600)).toBe(true);
  });
});

describe('nearBottom', () => {
  it('is true within the sticky threshold of the bottom', () => {
    expect(nearBottom({ scrollTop: 460, scrollHeight: 1000, clientHeight: 500 })).toBe(true); // 40px left
  });

  it('is true at the exact bottom', () => {
    expect(nearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
  });

  it('is false once the reader has scrolled up past the threshold', () => {
    expect(nearBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 500 })).toBe(false); // 200px left
  });

  // A pane shorter than its viewport has nothing to scroll, so the reader
  // is always at the bottom of it -- new messages must follow, not offer a
  // Jump to latest button that would do nothing.
  it('is true when there is nothing to scroll at all', () => {
    expect(nearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 })).toBe(true);
  });
});

describe('restoredScrollTop', () => {
  // The whole point of a prepend: content inserted ABOVE the viewport
  // pushes everything down by exactly the height it added, so the reader's
  // eye stays on the message they were reading.
  it('adds exactly the height the prepended page introduced', () => {
    expect(restoredScrollTop(200, 1000, 2600)).toBe(1800);
  });

  it('is a no-op when nothing was added', () => {
    expect(restoredScrollTop(200, 1000, 1000)).toBe(200);
  });

  // Defensive, not hypothetical: a page that replaces taller content with
  // shorter (a re-render between the measurement and the commit) must not
  // produce a negative scrollTop, which the browser clamps silently and
  // jsdom stores verbatim.
  it('never returns a negative position', () => {
    expect(restoredScrollTop(50, 1000, 600)).toBe(0);
  });
});

describe('ConversationView -- who said it', () => {
  it('marks the agent with the provider glyph and a readable name, never the word "agent"', async () => {
    const { container } = showOne({ role: 'assistant', text: 'ok' });
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    const who = container.querySelector('.turn.assistant .who')!;
    expect(who.querySelector('svg')).toBeTruthy();
    expect(who.textContent).toBe('Claude');
    expect(who.textContent).not.toMatch(/agent/i);
  });

  it('names the Codex provider on a Codex session rather than assuming Claude', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({
        turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'assistant', text: 'ok', steps: [] }],
        nextCursor: null,
      }),
    };
    const { container } = renderConv({ provider: 'codex' });
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    expect(container.querySelector('.turn.assistant .who')!.textContent).toBe('Codex');
  });

  it('still says "you" for a human turn, with no glyph', async () => {
    const { container } = showOne({ role: 'user', text: 'hi' });
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    const who = container.querySelector('.turn.user .who')!;
    expect(who.textContent).toBe('you');
    expect(who.querySelector('svg')).toBeNull();
  });

  // Spec §2: the name and the time sit on ONE line above the message,
  // replacing the 56px left gutter. The two spans being siblings inside
  // .meta is the DOM half of that; the CSS half is in
  // ConversationView.css.test.ts.
  it('puts the name and the time in one meta row above the message text', async () => {
    const { container } = showOne({ role: 'user', text: 'hi' });
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    const turn = container.querySelector('.turn.user')!;
    const meta = turn.querySelector('.meta')!;
    expect(meta.querySelector('.who')).toBeTruthy();
    expect(meta.querySelector('.when')).toBeTruthy();
    // The meta row precedes the text, not beside it.
    expect(meta.compareDocumentPosition(turn.querySelector('.turn-text')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('ConversationView -- the sticky bottom and Jump to latest', () => {
  const page = (rest: Array<Record<string, unknown>>) => ({
    turns: [
      { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'first', steps: [] },
      ...rest,
    ],
    nextCursor: null,
  });

  it('offers no Jump to latest on a pane that has only just opened', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => page([]),
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelector('.turn')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });

  // Scrolling alone must never conjure the button: it appears only when
  // new content LANDS while the reader is away from the bottom. Nothing in
  // this task can deliver new content to an open pane -- Task 3's refetch
  // is the only thing that can -- so the behaviour under new content is
  // tested there, against the signal that actually drives it, rather than
  // faked here with a remount that would reset the pane's own bookkeeping.
  it('does not offer Jump to latest merely because the reader scrolled up', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => page([]),
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 100 } }); // 3400px from the bottom

    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });

  // The other direction: a prepend adds a whole page ABOVE the reader and
  // must not be mistaken for new content at the bottom.
  it('does not offer Jump to latest when an older page is prepended', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (_sessionId: string, cursor?: unknown) => cursor === undefined
        ? { ...page([]), nextCursor: { ts: '2026-09-12T09:00:00Z', id: 0 } }
        : {
          turns: [{ id: 0, ts: '2026-09-12T09:30:00Z', role: 'user', text: 'older', steps: [] }],
          nextCursor: null,
        },
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });

    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });
});

describe('mergeNewest', () => {
  const t = (id: number, text: string) =>
    ({ id, ts: '2026-09-12T10:00:00Z', role: 'assistant' as const, text, steps: [] });

  it('appends turns the pane has not seen, in the order they arrived', () => {
    expect(mergeNewest([t(1, 'a')], [t(1, 'a'), t(2, 'b'), t(3, 'c')]).map(x => x.text))
      .toEqual(['a', 'b', 'c']);
  });

  // The streaming case, and the whole reason this is a merge rather than an
  // append: the last assistant turn GROWS as its reply arrives, keeping the
  // same row id. Appending would show the same reply twice, once truncated.
  it('replaces a turn that already exists, in place, rather than duplicating it', () => {
    const merged = mergeNewest([t(1, 'a'), t(2, 'half a rep')], [t(2, 'half a reply, now whole')]);
    expect(merged.map(x => x.text)).toEqual(['a', 'half a reply, now whole']);
  });

  // Older pages the reader deliberately loaded sit ABOVE the newest page
  // and are not in it. A merge that trusted the incoming page alone would
  // throw them away the first time a message arrived.
  it('leaves older loaded pages exactly where they are', () => {
    const merged = mergeNewest([t(0, 'much older'), t(1, 'a')], [t(1, 'a'), t(2, 'b')]);
    expect(merged.map(x => x.text)).toEqual(['much older', 'a', 'b']);
  });

  it('changes nothing when the newest page is empty', () => {
    const current = [t(1, 'a')];
    expect(mergeNewest(current, [])).toBe(current);
  });
});

describe('ConversationView -- live refresh from the events count', () => {
  function fleetReturning(pages: Array<{ turns: unknown[]; nextCursor: unknown }>) {
    const calls: Array<unknown[]> = [];
    let next = 0;
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        return pages[Math.min(next++, pages.length - 1)];
      },
    };
    return calls;
  }
  const first = {
    turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'go on then', steps: [] }],
    nextCursor: { ts: '2026-09-12T09:00:00Z', id: 0 },
  };
  const second = {
    turns: [
      { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'go on then', steps: [] },
      { id: 2, ts: '2026-09-12T10:00:09Z', role: 'assistant', text: 'arrived while you watched', steps: [] },
    ],
    nextCursor: { ts: '2026-09-12T09:00:00Z', id: 0 },
  };

  it('refetches the newest page and shows the new turn when the events count changes', async () => {
    const calls = fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText('arrived while you watched')).toBeTruthy());
    // The refetch takes NO cursor -- it is the newest page, not a page walk.
    expect(calls).toEqual([['s1', undefined], ['s1', undefined]]);
  });

  it('does not refetch on the very first render, which the mount fetch already covered', async () => {
    const calls = fleetReturning([first]);
    const { container } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    expect(calls).toHaveLength(1);
  });

  it('does not refetch when the events count is unchanged', async () => {
    const calls = fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    rerender(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it('does not refetch for a session whose events count is unknown', async () => {
    const calls = fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    rerender(<ConversationView sessionId="s1" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  // A refetch of the NEWEST page carries the newest page's own cursor,
  // which points at a page the reader may already have loaded above. Taking
  // it would walk backwards through history the reader already has.
  it('keeps the cursor it was already paging from, never the refetched page\'s own', async () => {
    const olderCursor = { ts: '2026-09-12T08:00:00Z', id: -1 };
    const calls: Array<unknown[]> = [];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        if (cursor !== undefined) {
          return {
            turns: [{ id: 0, ts: '2026-09-12T09:30:00Z', role: 'user', text: 'older', steps: [] }],
            nextCursor: olderCursor,
          };
        }
        return calls.length === 1 ? first : second;
      },
    };
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText('arrived while you watched')).toBeTruthy());

    // Scrolling to the top again pages from the OLDER cursor the prepend
    // established, not from the newest page's cursor the refetch carried.
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await waitFor(() => expect(calls.at(-1)).toEqual(['s1', olderCursor]));
  });

  // seenEventsRef is updated BEFORE the fetch fires (so a rejection still
  // consumes that events value and a later events bump can refetch), which
  // is exactly why a failed background refresh must never destroy what the
  // pane already has -- there's no error UI here, only the existing turns.
  it('keeps its existing turns unchanged and shows no error note when the refetch rejects', async () => {
    let call = 0;
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => {
        call += 1;
        if (call === 1) return first;
        throw new Error('refresh blip');
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      'Conversation refresh fetch failed:', expect.any(Error)));

    expect([...container.querySelectorAll('.turn .turn-text')].map(el => el.textContent))
      .toEqual(['go on then']);
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();

    consoleError.mockRestore();
  });

  // The unconditional-logging ruling (fix round 1) has no coverage without
  // this: the test above never switches sessions while the refresh is in
  // flight, so it would pass identically whether the removed `if (!alive)
  // return;` guard were still there or not. Same controlled-promise and
  // macrotask-tick technique as the mount-fetch alive test above (search
  // "does not leak an error onto the newly-selected session") -- applied to
  // the live-refresh fetch instead of the mount fetch.
  it('logs a rejected refresh fetch even for a session the reader has since left', async () => {
    let rejectRefresh: (err: unknown) => void = () => {};
    const pendingRefresh = new Promise((_resolve, reject) => { rejectRefresh = reject; });
    let s1Calls = 0;
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string) => {
        if (sessionId === 's1') {
          s1Calls += 1;
          if (s1Calls === 1) return first; // the mount fetch
          return pendingRefresh; // the live-refresh fetch, held pending
        }
        if (sessionId === 's2') {
          return {
            turns: [{ id: 5, ts: '2026-09-13T10:00:00Z', role: 'user', text: 'session B turn', steps: [] }],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected fetch: ${sessionId}`);
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    // Bump events on session s1 -- fires the live-refresh fetch, held pending.
    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);

    // Switch sessions before that refresh resolves.
    rerender(<ConversationView sessionId="s2" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText('session B turn')).toBeTruthy());

    // Let session s1's live-refresh fetch reject well after s2 has landed.
    await act(async () => {
      rejectRefresh(new Error('s1 refresh failed'));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(screen.getByText('session B turn')).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    // The point of the ruling: logged even though the reader has moved on.
    expect(consoleError).toHaveBeenCalledWith('Conversation refresh fetch failed:', expect.any(Error));

    consoleError.mockRestore();
  });

  // Task 2 built the sticky bottom; this is the first task that can
  // actually deliver new content to an open pane, so the two halves of
  // spec §3.2's rule are pinned here, against the signal that drives them.
  //
  // jsdom reports scrollTop 0 and scrollHeight 0 for an unstubbed element,
  // which nearBottom reads as "at the bottom" -- correct, and why the
  // following case needs no stub while the staying-put case does.
  it('follows the newest message while the reader is at the bottom', async () => {
    fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByText('arrived while you watched')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });

  it('stays put and offers Jump to latest when the reader has scrolled up', async () => {
    fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    // 200px, not 100: comfortably away from the bottom AND outside
    // nearOlderEdge's own 150px-from-the-top threshold. first/second (this
    // describe block's fixture) carry a non-null nextCursor, on purpose,
    // for the cursor-preservation test below -- so a scrollTop inside that
    // threshold would also fire the pre-existing loadMore() here, and the
    // cursor-agnostic fleetReturning mock would hand it the wrong page.
    fireEvent.scroll(scroller, { target: { scrollTop: 200 } }); // 3300px from the bottom

    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy());
    // The view did not move itself.
    expect(scroller.scrollTop).toBe(200);
  });

  it('clears Jump to latest once the reader is back at the bottom', async () => {
    fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 200 } }); // see note above
    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy());

    fireEvent.scroll(scroller, { target: { scrollTop: 3500 } }); // at the bottom
    await waitFor(() => expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull());
  });

  it('jumps to the newest message when the button is pressed, and hides itself', async () => {
    fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 200 } }); // see note above
    rerender(<ConversationView sessionId="s1" provider="claude" events={13}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);

    const jump = await screen.findByRole('button', { name: /jump to latest/i });
    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(4000);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });
});

describe('ConversationView -- the message box', () => {
  function withSendKeys(result: unknown) {
    const sendKeys = vi.fn(async () => result);
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns, nextCursor: null }),
      sendKeys,
    };
    return sendKeys;
  }

  it('sends what was typed through sendKeys, and clears the box', async () => {
    const sendKeys = withSendKeys({ status: 'sent' });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'commit it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(4821, 'commit it'));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  // Spec §7.2: Enter sends, with no confirmation, however long the message.
  // Shift+Enter is the newline, so a multi-line message is typed, not pasted
  // in from somewhere else.
  it('inserts a newline on Shift+Enter rather than sending', async () => {
    const sendKeys = withSendKeys({ status: 'sent' });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(sendKeys).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('line one');
  });

  it('sends a multi-line message as one message', async () => {
    const sendKeys = withSendKeys({ status: 'sent' });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'one\ntwo\nthree' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalledTimes(1));
    expect(sendKeys).toHaveBeenCalledWith(4821, 'one\ntwo\nthree');
  });

  it('sends nothing at all for an empty box', async () => {
    const sendKeys = withSendKeys({ status: 'sent' });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // The popover's wording, not a second copy of it -- part 1 settled these
  // strings against a real misfire (typed text answering a picker).
  it('shows the popover\'s own refusal wording, and keeps the text so it can be retried', async () => {
    withSendKeys({ status: 'refused', reason: 'session_gone' });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'commit it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('That session has ended.')).toBeTruthy());
    expect((box as HTMLTextAreaElement).value).toBe('commit it');
  });

  // Part 1's guard stands: this box does not answer choices. A typed reply
  // to a picker is ignored and Enter selects whatever is highlighted --
  // measured 2026-09-15, "blue" recorded as "Red".
  it('offers Open Terminal when a choice is open, rather than only saying no', async () => {
    withSendKeys({ status: 'refused', reason: 'prompt_open' });
    const onOpenTerminal = vi.fn();
    renderConv({ onOpenTerminal });
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'blue' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/showing a choice/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /open terminal/i }));
    expect(onOpenTerminal).toHaveBeenCalled();
  });

  // Spec §7.1: never hidden. A box that vanishes reads as a missing
  // feature; a disabled one reads as a state.
  it('shows the box disabled, with a reason, for a session that is not tmux-backed', async () => {
    withSendKeys({ status: 'sent' });
    renderConv({ tmux: false });
    const box = await screen.findByLabelText('Message this session');
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/not running inside tmux/i)).toBeTruthy();
  });

  it('shows the box disabled, with a reason, for a session with no live process', async () => {
    withSendKeys({ status: 'sent' });
    renderConv({ pid: null });
    const box = await screen.findByLabelText('Message this session');
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText('This session is not running.')).toBeTruthy();
  });

  it('still shows the box when the session has no conversation to show', async () => {
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: [], nextCursor: null }),
      sendKeys: vi.fn(),
    };
    renderConv();
    expect(await screen.findByLabelText('Message this session')).toBeTruthy();
  });
});
