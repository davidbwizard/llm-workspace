import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { ConversationView, nearOlderEdge, nearBottom, restoredScrollTop, mergeNewest, clearDrafts,
  messageCounter, MAX_REPLY_CHARS as CONV_MAX_REPLY_CHARS } from '../../src/renderer/components/ConversationView.tsx';
// The main-process cap, imported here ONLY because this is a test, not
// renderer code -- src/renderer/** itself must never import a value out of
// src/main/**. See the drift test below.
import { MAX_REPLY_CHARS as MAIN_MAX_REPLY_CHARS } from '../../src/main/outbound.ts';
import { reloadSettings, setSettings } from '../../src/renderer/state/settings.ts';
import { clearPending } from '../../src/renderer/state/pending.ts';

const turns = [
  { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'run the farm tests' },
  { id: 2, ts: '2026-09-12T10:00:05Z', role: 'assistant', text: 'All green. Want me to commit?' },
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
  // Drafts are module state in the component, kept there deliberately so
  // they survive unmount (see the `drafts` comment there). That also means
  // they survive between tests: without this reset, a test that types
  // without sending leaves its text in the next test's box, which is a
  // demonstrated failure, not a theoretical one -- running the Shift+Enter
  // test and the empty-box test together makes the latter send.
  clearDrafts();
  // Same reasoning as clearDrafts above, for src/renderer/state/pending.ts's
  // own module-level store (Task 8): it is keyed by pid, every test here
  // renders at the same default pid (4821), and it is deliberately built to
  // outlive a component unmount -- so without this, a pending entry one
  // test's send left behind would still be there for the next.
  clearPending();
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
      { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'oldest message' },
      { id: 2, ts: '2026-09-12T10:00:05Z', role: 'user', text: 'middle message' },
      { id: 3, ts: '2026-09-12T10:00:10Z', role: 'assistant', text: 'newest reply' },
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
          turns: [{ id: 0, ts: '2026-09-12T09:58:00Z', role: 'user', text: 'an older turn' }],
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
            turns: [{ id: 5, ts: '2026-09-13T10:00:00Z', role: 'user', text: 'session B turn' }],
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
        turns: [{ id: 0, ts: '2026-09-12T09:58:00Z', role: 'user', text: 'an older turn from session A' }],
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
            turns: [{ id: 5, ts: '2026-09-13T10:00:00Z', role: 'user', text: 'session B turn' }],
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
          turns: [{ id: 0, ts: '2026-09-12T09:58:00Z', role: 'user', text: 'an older turn' }],
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

  // Day dividers, per the Conversation Pane Mockup: the date sits on its own
  // rule above the first turn of each day, and every turn's meta line shows
  // the time alone.
  it('opens the day with a divider and shows only the time on the turn', async () => {
    const [first] = turns;
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelector('.when')).toBeTruthy());
    const day = container.querySelector('.conv-day');
    expect(day?.textContent).toBe(fmtDate(first!.ts));
    expect(day?.getAttribute('role')).toBe('separator');
    // The divider comes before the turn it dates.
    expect(day!.compareDocumentPosition(container.querySelector('.turn')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.when')?.textContent).toBe(fmtTime(first!.ts));
  });

  it('adds no second divider for another entry from the same day', async () => {
    const sameDay = [
      { id: 1, ts: '2026-09-12T09:00:00Z', role: 'user', text: 'first' },
      { id: 2, ts: '2026-09-12T15:30:00Z', role: 'assistant', text: 'second' },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: sameDay, nextCursor: null }),
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.when')).toHaveLength(2));
    expect([...container.querySelectorAll('.conv-day')].map(d => d.textContent)).toEqual([fmtDate(sameDay[0]!.ts)]);
    expect([...container.querySelectorAll('.when')].map(w => w.textContent))
      .toEqual([fmtTime(sameDay[0]!.ts), fmtTime(sameDay[1]!.ts)]);
  });

  it('puts a divider before the first turn of each new day', async () => {
    const twoDays = [
      { id: 1, ts: '2026-09-11T09:00:00Z', role: 'user', text: 'day one' },
      { id: 2, ts: '2026-09-12T09:00:00Z', role: 'assistant', text: 'day two' },
    ];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: twoDays, nextCursor: null }),
    };
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelectorAll('.when')).toHaveLength(2));
    // Document order: divider, turn, divider, turn.
    const order = [...container.querySelectorAll('.conv-day, .turn')].map(el =>
      el.classList.contains('conv-day') ? `day:${el.textContent}` : 'turn');
    expect(order).toEqual([`day:${fmtDate(twoDays[0]!.ts)}`, 'turn', `day:${fmtDate(twoDays[1]!.ts)}`, 'turn']);
    expect([...container.querySelectorAll('.when')].map(w => w.textContent))
      .toEqual([fmtTime(twoDays[0]!.ts), fmtTime(twoDays[1]!.ts)]);
  });
});

describe('ConversationView -- live push refresh (Task 7)', () => {
  // main can now push this pid's live state within ~250ms (Task 6:
  // src/main/sessionLive.ts's watchSessionFor/notifySessionChanged) instead
  // of leaving the pane to the 5s fleet sweep alone -- this proves the pane
  // actually listens, not merely that useSessionLive itself does (that is
  // useSessionLive.test.tsx's job). A ConversationView that never wired the
  // hook's `events` into its existing refresh effect would fail this: the
  // `events` PROP never changes across the push below, so only a wrong
  // implementation that reads solely from the prop would leave the second
  // call unmade.
  it('refreshes the conversation when a session:live push reports a newer event count than the events prop', async () => {
    let pushLive: (payload: unknown) => void = () => {};
    const calls: Array<unknown[]> = [];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        return { turns, nextCursor: null };
      },
      watchSession: vi.fn().mockResolvedValue(true),
      onSessionLive: (cb: (payload: unknown) => void) => { pushLive = cb; return () => {}; },
    };
    renderConv({ events: 4 });
    await waitFor(() => expect(calls).toHaveLength(1));

    act(() => {
      pushLive({ version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: Date.now(), events: 5 });
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual(['s1', undefined]); // the newest page, not a page walk
  });

  // The events PROP stays the authoritative floor: a push reporting a
  // count no higher than what the prop already covered must not fire a
  // redundant refetch on its own.
  it('does not refetch when the live push reports the same event count the prop already covered', async () => {
    let pushLive: (payload: unknown) => void = () => {};
    const calls: Array<unknown[]> = [];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        return { turns, nextCursor: null };
      },
      watchSession: vi.fn().mockResolvedValue(true),
      onSessionLive: (cb: (payload: unknown) => void) => { pushLive = cb; return () => {}; },
    };
    renderConv({ events: 4 });
    await waitFor(() => expect(calls).toHaveLength(1));

    act(() => {
      pushLive({ version: 1, pid: 4821, sessionId: 's1', activity: 'idle', since: null, events: 4 });
    });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  // A push for a DIFFERENT pid than the one the pane has open must not
  // refresh anything -- useSessionLive.test.tsx already proves the hook
  // filters it at the source; this proves the pane does not somehow still
  // react to it another way (e.g. by reading `events` off the raw payload
  // instead of through the hook).
  it('ignores a live push for a different pid entirely', async () => {
    let pushLive: (payload: unknown) => void = () => {};
    const calls: Array<unknown[]> = [];
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async (sessionId: string, cursor?: unknown) => {
        calls.push([sessionId, cursor]);
        return { turns, nextCursor: null };
      },
      watchSession: vi.fn().mockResolvedValue(true),
      onSessionLive: (cb: (payload: unknown) => void) => { pushLive = cb; return () => {}; },
    };
    renderConv({ events: 4 });
    await waitFor(() => expect(calls).toHaveLength(1));

    act(() => {
      pushLive({ version: 1, pid: 9999, sessionId: 's9', activity: 'working', since: Date.now(), events: 99 });
    });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });
});

function showOne(turn: Record<string, unknown>) {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    conversation: async () => ({ turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', ...turn }], nextCursor: null }),
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
        turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'assistant', text: 'ok' }],
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
      { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'first' },
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
          turns: [{ id: 0, ts: '2026-09-12T09:30:00Z', role: 'user', text: 'older' }],
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
    ({ id, ts: '2026-09-12T10:00:00Z', role: 'assistant' as const, text });

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
    turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'go on then' }],
    nextCursor: { ts: '2026-09-12T09:00:00Z', id: 0 },
  };
  const second = {
    turns: [
      { id: 1, ts: '2026-09-12T10:00:00Z', role: 'user', text: 'go on then' },
      { id: 2, ts: '2026-09-12T10:00:09Z', role: 'assistant', text: 'arrived while you watched' },
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
            turns: [{ id: 0, ts: '2026-09-12T09:30:00Z', role: 'user', text: 'older' }],
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
            turns: [{ id: 5, ts: '2026-09-13T10:00:00Z', role: 'user', text: 'session B turn' }],
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

// Module-scoped (not local to the "message box" describe below) so the
// length-counter tests further down can set up the same sendKeys mock
// without a second, drifting copy of it.
function withSendKeys(result: unknown) {
  const sendKeys = vi.fn(async () => result);
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    conversation: async () => ({ turns, nextCursor: null }),
    sendKeys,
  };
  return sendKeys;
}

describe('ConversationView -- the message box', () => {
  it('sends what was typed through sendKeys, and clears the box', async () => {
    const sendKeys = withSendKeys({ status: 'sent', queued: false });
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
    const sendKeys = withSendKeys({ status: 'sent', queued: false });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(sendKeys).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('line one');
  });

  it('sends a multi-line message as one message', async () => {
    const sendKeys = withSendKeys({ status: 'sent', queued: false });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'one\ntwo\nthree' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalledTimes(1));
    expect(sendKeys).toHaveBeenCalledWith(4821, 'one\ntwo\nthree');
  });

  it('sends nothing at all for an empty box', async () => {
    const sendKeys = withSendKeys({ status: 'sent', queued: false });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // A chat box that drops the caret on every send is unusable for two
  // messages in a row: disabling the textarea while the send is in flight
  // makes the browser blur it, and re-enabling does not put focus back, so
  // the person has to click in again between every message.
  //
  // These assert the END state -- focused once the send has settled -- on
  // purpose, and deliberately do NOT focus the box first. jsdom's own
  // blur-on-disable behaviour is then irrelevant to the result: the box
  // starts unfocused either way, so the assertion can only pass if
  // something actively puts focus back, which is exactly the property
  // being pinned.
  it('puts focus back in the box after a send, so the next message can just be typed', async () => {
    const sendKeys = withSendKeys({ status: 'sent', queued: false });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'commit it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalled());
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
    expect(document.activeElement).toBe(box);
  });

  // A refusal is the case where focus matters MOST: the text is still
  // there and the whole point is to edit it and try again.
  it('puts focus back after a refusal too, with the typed text still there to retry', async () => {
    withSendKeys({ status: 'refused', reason: 'session_gone' });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'commit it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('That session has ended.')).toBeTruthy());
    expect(document.activeElement).toBe(box);
    expect((box as HTMLTextAreaElement).value).toBe('commit it');
  });

  // The other half of the restore: it must fire on the send-settled
  // transition and nowhere else. An effect that simply focused whenever it
  // ran would steal the caret every time a session is opened.
  it('does not grab focus on mount -- opening a session must not steal the caret', async () => {
    withSendKeys({ status: 'sent', queued: false });
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    expect(document.activeElement).not.toBe(box);
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

  // The draft outliving the component is the whole point, not a nicety.
  // The box's only remedy for prompt_open is Open Terminal, and MainPane
  // renders the conversation as a ternary branch -- so following the UI's
  // own instruction UNMOUNTS the component holding what was typed. Without
  // a store outside the component, answering the choice and coming back
  // loses the message.
  it('keeps the draft across an unmount, so Open Terminal cannot destroy what was typed', async () => {
    withSendKeys({ status: 'refused', reason: 'prompt_open' });
    const first = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'the message I do not want to lose' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/showing a choice/i)).toBeTruthy());
    first.unmount();

    renderConv();
    const again = await screen.findByLabelText('Message this session');
    expect((again as HTMLTextAreaElement).value).toBe('the message I do not want to lose');
  });

  it('drops the draft once the message actually goes out', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const first = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'commit it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
    first.unmount();

    renderConv();
    const again = await screen.findByLabelText('Message this session');
    expect((again as HTMLTextAreaElement).value).toBe('');
  });

  // The invariant: a draft must never appear in a box belonging to a
  // different session than the one it was typed in. A pid alone does not
  // establish that, because the OS reuses pids -- a long-running app can
  // outlive a session and see its number handed to a new process. One
  // Enter would then send the old session's message to the new one.
  it('never shows a draft from a different session, even at the same pid', async () => {
    withSendKeys({ status: 'refused', reason: 'prompt_open' });
    const first = renderConv({ pid: 777, sessionId: 'session-a' });
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'meant for session A' } });
    first.unmount();

    // Same pid number, different session behind it.
    renderConv({ pid: 777, sessionId: 'session-b' });
    const reused = await screen.findByLabelText('Message this session');
    expect((reused as HTMLTextAreaElement).value).toBe('');
  });

  // The honest consequence of keying on session identity: a process whose
  // transcript the app cannot pin down has no identity to check a draft
  // against, so it does not keep one across unmount. Losing a draft is a
  // far better outcome than delivering it to the wrong session, and this
  // is the behaviour such sessions had before drafts existed at all.
  it('does not hold a draft across unmount for a session it cannot identify', async () => {
    withSendKeys({ status: 'refused', reason: 'prompt_open' });
    const first = renderConv({ pid: 888, sessionId: null });
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'unidentified session' } });
    expect((box as HTMLTextAreaElement).value).toBe('unidentified session');
    first.unmount();

    renderConv({ pid: 888, sessionId: null });
    const again = await screen.findByLabelText('Message this session');
    expect((again as HTMLTextAreaElement).value).toBe('');
  });

  // The other half of the identity check, and the reason the store is
  // module-scoped at all: a draft must still come BACK when the reader
  // returns to the session that owns it. Switching away and back is the
  // ordinary case; the checks above must not have turned it into a loss.
  it('brings a draft back when the reader returns to that session', async () => {
    withSendKeys({ status: 'refused', reason: 'prompt_open' });
    const props = (pid: number, sessionId: string) => (
      <ConversationView sessionId={sessionId} provider="claude" events={null}
        pid={pid} tmux={true} onOpenTerminal={() => {}} />
    );
    const { rerender } = render(props(101, 's-a'));
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'half written' } });

    rerender(props(202, 's-b'));
    const other = await screen.findByLabelText('Message this session');
    expect((other as HTMLTextAreaElement).value).toBe('');

    rerender(props(101, 's-a'));
    const back = await screen.findByLabelText('Message this session');
    expect((back as HTMLTextAreaElement).value).toBe('half written');
  });

  // Drafts are per-pid. A store keyed wrongly would leak one session's
  // half-written message into another session's box.
  it('keeps each session\'s draft to itself', async () => {
    withSendKeys({ status: 'refused', reason: 'prompt_open' });
    const first = renderConv({ pid: 111 });
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'meant for 111' } });
    first.unmount();

    renderConv({ pid: 222 });
    const other = await screen.findByLabelText('Message this session');
    expect((other as HTMLTextAreaElement).value).toBe('');
  });

  // The catch in send() exists precisely so a rejected sendKeys cannot
  // leave the box looking like the message went out. Without a test, the
  // thing it protects against is exactly what a refactor would reintroduce.
  it('surfaces a rejected send instead of letting the box look like it went out', async () => {
    const sendKeys = vi.fn(async () => { throw new Error('bridge gone'); });
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns, nextCursor: null }),
      sendKeys,
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'commit it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Could not reach the app.')).toBeTruthy());
    // Not cleared: a cleared box is what "it went out" looks like.
    expect((box as HTMLTextAreaElement).value).toBe('commit it');
    // And the box is usable again rather than stuck disabled mid-send.
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Spec §7.1: never hidden. A box that vanishes reads as a missing
  // feature; a disabled one reads as a state.
  it('shows the box disabled, with a reason, for a session that is not tmux-backed', async () => {
    withSendKeys({ status: 'sent', queued: false });
    renderConv({ tmux: false });
    const box = await screen.findByLabelText('Message this session');
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/not running inside tmux/i)).toBeTruthy();
  });

  it('shows the box disabled, with a reason, for a session with no live process', async () => {
    withSendKeys({ status: 'sent', queued: false });
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

// Task 9 (2026-09-17-live-conversation-feedback): the message you send
// appears in the conversation the instant you press Enter, rather than
// waiting on the agent's own log (which the fleet sweep alone can lag by up
// to 5s, longer while the agent is mid-turn). src/renderer/state/pending.ts
// (Task 8) holds the module-level store this all reads and writes; these
// tests pin how ConversationView renders it and reconciles it against the
// real log, not the store's own matching rules (pending.test.ts's job).
describe('ConversationView -- pending messages (Task 9)', () => {
  // The keyDown itself, not just the change, is wrapped in an async act()
  // that also drains one macrotask: send() awaits window.fleet.sendKeys
  // before its continuation (markQueued/dropPending, the second
  // onPendingChange) runs, and without this the continuation's state
  // update lands outside any act() this file's tests wrap around it --
  // exactly the "not wrapped in act(...)" warning React raises for a real
  // bug (a state update React cannot account for), not a cosmetic one.
  // Draining it here does not undercut what "shows your message straight
  // away" tests below: the pending entry is not removed by this
  // resolution, only by the turn-list effect matching it against the log.
  async function typeAndSend(text: string) {
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  it('shows your message straight away, before the log has it', async () => {
    withSendKeys({ status: 'sent', queued: false });
    renderConv();
    await typeAndSend('ship it');
    expect(screen.getByText('ship it')).toBeTruthy();
    expect(document.querySelector('.turn.user.pending')).toBeTruthy();
  });

  it('shows no label at all for a plain sent message -- Queued and the warning are both opt-in', async () => {
    withSendKeys({ status: 'sent', queued: false });
    renderConv();
    await typeAndSend('ship it');
    await waitFor(() => expect(document.querySelector('.turn.user.pending')).toBeTruthy());
    expect(document.querySelector('.turn.user.pending .turn-state')).toBeNull();
  });

  it('puts the text back in the box when the send is refused, and drops the pending entry', async () => {
    withSendKeys({ status: 'refused', reason: 'session_gone' });
    renderConv();
    await typeAndSend('ship it');
    await waitFor(() => expect(screen.getByText('That session has ended.')).toBeTruthy());
    expect(document.querySelector('.turn.user.pending')).toBe(null);
    expect((screen.getByLabelText('Message this session') as HTMLTextAreaElement).value).toBe('ship it');
  });

  it('labels a queued message', async () => {
    withSendKeys({ status: 'sent', queued: true });
    renderConv();
    await typeAndSend('ship it');
    await waitFor(() => expect(screen.getByText('Queued')).toBeTruthy());
  });

  // The exact regression a reviewer flagged on this plan: an implementation
  // that leaves the pending entry on screen once the real turn lands would
  // show the person their own message TWICE. The mount fetch returns no
  // turns at all, so if the pending entry were not dropped on a match, the
  // second (bumped-events) fetch landing the real turn would leave two
  // `.turn.user` elements on screen instead of one.
  it('replaces the pending entry when the log has the message, never showing it twice', async () => {
    let call = 0;
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => {
        call += 1;
        if (call === 1) return { turns: [], nextCursor: null };
        return {
          turns: [{ id: 9, ts: new Date().toISOString(), role: 'user', text: 'ship it' }],
          nextCursor: null,
        };
      },
      sendKeys: vi.fn(async () => ({ status: 'sent', queued: false })),
    };
    const { rerender } = renderConv({ events: 1 });
    await typeAndSend('ship it');
    await waitFor(() => expect(document.querySelector('.turn.user.pending')).toBeTruthy());

    // A higher events count is what the app's own refresh effect already
    // treats as "go fetch the newest page again" (see the "live refresh
    // from the events count" describe block above) -- the same mechanism a
    // real session:live push or fleet sweep would trigger.
    rerender(<ConversationView sessionId="s1" provider="claude" events={2}
      pid={4821} tmux={true} onOpenTerminal={() => {}} />);

    await waitFor(() => expect(document.querySelectorAll('.turn.user')).toHaveLength(1));
    expect(document.querySelector('.pending')).toBe(null);
  });

  // Guards against the two wrong implementations a countdown invites: one
  // that ticks regardless of activity (would warn while Claude is still
  // working on an earlier message) and one that never stops (irrelevant
  // here, but the same interval also has to actually clear on unmount,
  // covered separately below). vi.useFakeTimers with shouldAdvanceTime is
  // the same combination OpenSessionCard.test.tsx already uses to keep
  // Testing Library's own polling (findByLabelText, waitFor) working
  // underneath fake interval timers.
  it('warns after fifteen seconds of idle, and not while working', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let pushLive: (payload: unknown) => void = () => {};
      (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
        conversation: async () => ({ turns, nextCursor: null }),
        sendKeys: vi.fn(async () => ({ status: 'sent', queued: false })),
        watchSession: vi.fn().mockResolvedValue(true),
        onSessionLive: (cb: (payload: unknown) => void) => { pushLive = cb; return () => {}; },
      };
      renderConv();
      await typeAndSend('ship it');
      await waitFor(() => expect(document.querySelector('.turn.user.pending')).toBeTruthy());

      act(() => {
        pushLive({ version: 1, pid: 4821, sessionId: 's1', activity: 'working', since: Date.now(), events: 1 });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.queryByText('Not seen by Claude')).toBeNull();

      act(() => {
        pushLive({ version: 1, pid: 4821, sessionId: 's1', activity: 'idle', since: null, events: 1 });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

      expect(screen.getByText('Not seen by Claude')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open Terminal' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the Terminal from the warning label', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let pushLive: (payload: unknown) => void = () => {};
      (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
        conversation: async () => ({ turns, nextCursor: null }),
        sendKeys: vi.fn(async () => ({ status: 'sent', queued: false })),
        watchSession: vi.fn().mockResolvedValue(true),
        onSessionLive: (cb: (payload: unknown) => void) => { pushLive = cb; return () => {}; },
      };
      const onOpenTerminal = vi.fn();
      renderConv({ onOpenTerminal });
      await typeAndSend('ship it');
      act(() => {
        pushLive({ version: 1, pid: 4821, sessionId: 's1', activity: 'idle', since: null, events: 1 });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

      fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
      expect(onOpenTerminal).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its pending-idle interval on unmount, rather than leaking a timer per pane', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderConv();
    await screen.findByLabelText('Message this session');
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

// A reviewer suggested `maxLength` on the textarea; rejected because
// maxLength silently truncates a paste -- 5,000 characters in, 4,000 shown,
// with no sign the rest was dropped. This counter is the alternative: the
// cap becomes visible before it's hit, and the server-side cap in
// sanitizeOutbound (src/main/outbound.ts) remains the only thing that ever
// refuses a send.
describe('messageCounter', () => {
  it('reads nothing at all comfortably under the cap', () => {
    expect(messageCounter(3599)).toBeNull();
  });

  it('appears once the length reaches 90% of the cap, reading the remaining budget', () => {
    expect(messageCounter(3600)).toEqual({ label: '400 left', warn: false });
  });

  it('reads "0 left", styled as a warning, at exactly the cap', () => {
    expect(messageCounter(4000)).toEqual({ label: '0 left', warn: true });
  });

  it('reads how much to cut, not a clamped zero, once past the cap', () => {
    expect(messageCounter(5000)).toEqual({ label: '1,000 over', warn: true });
  });

  it('accepts a caller-supplied cap rather than only the default', () => {
    expect(messageCounter(90, 100)).toEqual({ label: '10 left', warn: false });
  });

  // The one thing this whole feature exists to keep true: the renderer's
  // idea of the cap and the main process's actual enforcement
  // (sanitizeOutbound, src/main/outbound.ts) must never silently drift
  // apart. This is a value import into a TEST, not renderer code, so it
  // does not run into the "no src/main value imports in the renderer"
  // constraint that keeps this constant redeclared rather than imported in
  // ConversationView.tsx itself.
  it('keeps its cap equal to the main process enforcement it mirrors', () => {
    expect(CONV_MAX_REPLY_CHARS).toBe(MAIN_MAX_REPLY_CHARS);
  });
});

describe('ConversationView -- the message box\'s length counter', () => {
  it('shows no counter element at all while the message is comfortably short', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(3599) } });
    expect(container.querySelector('.convcount')).toBeNull();
  });

  it('appears at the 3,600-character threshold reading the remaining budget', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(3600) } });
    expect(container.querySelector('.convcount')?.textContent).toBe('400 left');
    expect(container.querySelector('.convcount')?.classList.contains('convcount-warn')).toBe(false);
  });

  it('reads "0 left" and takes the warning styling at exactly the cap', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(4000) } });
    const counter = container.querySelector('.convcount')!;
    expect(counter.textContent).toBe('0 left');
    expect(counter.classList.contains('convcount-warn')).toBe(true);
  });

  it('shows the over-by amount, not a clamped "0 left", once past the cap', async () => {
    withSendKeys({ status: 'refused', reason: 'too_long' });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(5000) } });
    const counter = container.querySelector('.convcount')!;
    expect(counter.textContent).toBe('1,000 over');
    expect(counter.classList.contains('convcount-warn')).toBe(true);
  });

  // The counter is visibility only. maxLength, clamping, truncating and
  // disabling the send are all explicitly out of scope -- the server-side
  // refusal in sanitizeOutbound remains the sole enforcement, and the
  // person must still be able to try.
  it('still attempts to send an over-cap message, untruncated -- the refusal is what stops it', async () => {
    const sendKeys = withSendKeys({ status: 'refused', reason: 'too_long' });
    renderConv();
    const box = await screen.findByLabelText('Message this session') as HTMLTextAreaElement;
    const over = 'a'.repeat(4500);
    fireEvent.change(box, { target: { value: over } });
    expect(box.disabled).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(4821, over));
    await waitFor(() => expect(screen.getByText('That reply is too long to send. Shorten it and try again.')).toBeTruthy());
    expect(box.disabled).toBe(false);
    expect(box.value).toBe(over); // kept whole, not truncated -- same as any other refusal
  });

  // The counter's own text must never be an aria-live region: it changes on
  // every keystroke while visible, and a screen reader announcing that
  // continuously would be unusable.
  it('carries no aria-live attribute on the visible counter itself', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(4500) } });
    expect(container.querySelector('.convcount')?.getAttribute('aria-live')).toBeNull();
    expect(container.querySelector('.convcount')?.getAttribute('role')).toBeNull();
  });

  // The separate, screen-reader-only announcement: fires once on the
  // transition into being over the cap, not on every keystroke below it.
  it('says nothing in the live region while comfortably under the cap', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(3700) } });
    expect(container.querySelector('.convannounce')?.textContent).toBe('');
  });

  it('announces once on crossing over the cap, and does not keep re-announcing while still over', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(4001) } });
    const region = container.querySelector('.convannounce')!;
    await waitFor(() => expect(region.textContent).not.toBe(''));
    const firstAnnouncement = region.textContent;

    fireEvent.change(box, { target: { value: 'a'.repeat(4800) } });
    expect(container.querySelector('.convannounce')!.textContent).toBe(firstAnnouncement);
  });

  it('does not announce merely for reaching the cap exactly, only for going past it', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(4000) } });
    expect(container.querySelector('.convannounce')?.textContent).toBe('');
  });

  it('clears the announcement once the message drops back under the cap', async () => {
    withSendKeys({ status: 'sent', queued: false });
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'a'.repeat(4500) } });
    await waitFor(() => expect(container.querySelector('.convannounce')?.textContent).not.toBe(''));
    fireEvent.change(box, { target: { value: 'a'.repeat(100) } });
    await waitFor(() => expect(container.querySelector('.convannounce')?.textContent).toBe(''));
  });
});

describe('ConversationView -- the reading settings', () => {
  beforeEach(() => { localStorage.clear(); reloadSettings(); });

  it('renders at the stored text size, as a variable the whole pane is built from', async () => {
    setSettings({ textSize: 14 });
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelector('.conv')).toBeTruthy());
    expect((container.querySelector('.conv') as HTMLElement).style.getPropertyValue('--conv-size')).toBe('14px');
  });

  it('renders the stored message style, defaulting to A', async () => {
    const { container } = renderConv();
    await waitFor(() => expect(container.querySelector('.conv')).toBeTruthy());
    expect(container.querySelector('.conv')!.getAttribute('data-style')).toBe('a');
    setSettings({ messageStyle: 'c' });
    await waitFor(() => expect(container.querySelector('.conv')!.getAttribute('data-style')).toBe('c'));
  });
});

describe('ConversationView -- one-click copy', () => {
  function mockClipboard(write: (text: string) => Promise<void>) {
    const writeText = vi.fn(write);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  it('copies an agent reply as its original markdown, and says so', async () => {
    const writeText = mockClipboard(async () => {});
    const md = '**Done.** Run `npm test` next.';
    const { container } = showOne({ role: 'assistant', text: md });
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    // At the bottom of the reply, not in its meta line; an icon whose hover
    // tooltip reads Copy.
    expect(container.querySelector('.turn.assistant .meta .copy-btn')).toBeNull();
    const btn = container.querySelector('.turn.assistant > .turn-actions .copy-btn') as HTMLButtonElement;
    expect(btn.querySelector('svg')).toBeTruthy();
    expect(btn.title).toBe('Copy');
    expect(btn.getAttribute('aria-label')).toBe('Copy reply');
    fireEvent.click(btn);
    await waitFor(() => expect(btn.dataset.state).toBe('copied'));
    expect(btn.getAttribute('aria-label')).toBe('Copied');
    // Visible confirmation, not just an icon swap.
    expect(btn.querySelector('.copy-note')?.textContent).toBe('Copied');
    expect(writeText).toHaveBeenCalledWith(md);
  });

  // The app renders under React.StrictMode (src/renderer/main.tsx), which in
  // dev mounts, unmounts and remounts every component. The first version's
  // "still mounted" flag was cleared by that unmount and never set again, so
  // in the running app the copy happened but "Copied" never showed.
  it('shows Copied under React.StrictMode, as the app renders', async () => {
    mockClipboard(async () => {});
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'assistant', text: 'x' }], nextCursor: null }),
    };
    const { container } = render(
      <ConversationView sessionId="s1" provider="claude" events={null}
        pid={4821} tmux={true} onOpenTerminal={() => {}} />,
      { wrapper: React.StrictMode },
    );
    await waitFor(() => expect(container.querySelector('.turn-actions .copy-btn')).toBeTruthy());
    const btn = container.querySelector('.turn-actions .copy-btn') as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.querySelector('.copy-note')?.textContent).toBe('Copied'));
  });

  it('gives your own messages no copy button', async () => {
    mockClipboard(async () => {});
    const { container } = showOne({ role: 'user', text: 'hello' });
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    expect(container.querySelector('.turn.user .copy-btn')).toBeNull();
  });

  it('copies exactly the code from a code block', async () => {
    const writeText = mockClipboard(async () => {});
    const { container } = showOne({ role: 'assistant', text: 'Fix:\n\n```js\nfunction parse(s) {\n  return s.trim()\n}\n```\n' });
    await waitFor(() => expect(container.querySelector('pre')).toBeTruthy());
    const btn = container.querySelector('.md-codeblock .copy-btn') as HTMLButtonElement;
    expect(btn.title).toBe('Copy');
    fireEvent.click(btn);
    await waitFor(() => expect(btn.dataset.state).toBe('copied'));
    expect(writeText).toHaveBeenCalledWith('function parse(s) {\n  return s.trim()\n}\n');
  });

  it('says the copy failed, and logs why, instead of claiming success', async () => {
    mockClipboard(async () => { throw new Error('denied'); });
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = showOne({ role: 'assistant', text: 'x' });
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    const btn = container.querySelector('.turn.assistant > .turn-actions .copy-btn') as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.dataset.state).toBe('failed'));
    expect(btn.getAttribute('aria-label')).toBe('Copy failed');
    expect(btn.querySelector('.copy-note')?.textContent).toBe('Copy failed');
    expect(errs).toHaveBeenCalledWith('clipboard write failed:', expect.any(Error));
    errs.mockRestore();
  });
});

describe('ConversationView -- images a reply links to', () => {
  function showWithImages(text: string, image: (sessionId: string, src: string) => Promise<unknown>) {
    const spy = vi.fn(image);
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'assistant', text }], nextCursor: null }),
      image: spy,
    };
    return { spy, ...renderConv() };
  }
  const DATA = 'data:image/png;base64,iVBORw0KGgo=';

  it('asks main for a local image and shows it as a thumbnail', async () => {
    const { spy, container } = showWithImages('Here:\n\n![the chart](out/chart.png)', async () => ({ ok: true, dataUrl: DATA }));
    await waitFor(() => expect(container.querySelector('img.md-thumb')).toBeTruthy());
    const img = container.querySelector('img.md-thumb') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(DATA);
    expect(img.alt).toBe('the chart');
    expect(spy).toHaveBeenCalledWith('s1', 'out/chart.png');
  });

  it('passes a file:// link through to main rather than dropping it', async () => {
    const { spy, container } = showWithImages('![x](file:///tmp/a.png)', async () => ({ ok: true, dataUrl: DATA }));
    await waitFor(() => expect(container.querySelector('img.md-thumb')).toBeTruthy());
    expect(spy).toHaveBeenCalledWith('s1', 'file:///tmp/a.png');
  });

  it('never asks for a web image, and shows its alt text instead', async () => {
    const { spy, container } = showWithImages('![remote](https://example.com/a.png)', async () => ({ ok: true, dataUrl: DATA }));
    await waitFor(() => expect(container.querySelector('.md-image')).toBeTruthy());
    expect(container.querySelector('.md-image')?.textContent).toBe('remote');
    expect(container.querySelector('img')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows the alt text when main refuses the file', async () => {
    const { container } = showWithImages('![secret](/etc/x.png)', async () => ({ ok: false, reason: 'outside_roots' }));
    await waitFor(() => expect(container.querySelector('.md-image')).toBeTruthy());
    await act(async () => {});
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.md-image')?.textContent).toBe('secret');
  });
});

describe('ConversationView -- images you attached', () => {
  const DATA = 'data:image/png;base64,iVBORw0KGgo=';
  function showTurn(turn: Record<string, unknown>, attachments: (id: number) => Promise<unknown>) {
    const spy = vi.fn(attachments);
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns: [{ id: 42, ts: '2026-09-12T10:00:00Z', ...turn }], nextCursor: null }),
      attachments: spy,
    };
    return { spy, ...renderConv() };
  }

  it('shows your attached images under your text, without the [Image #N] markers', async () => {
    const { spy, container } = showTurn({ role: 'user', text: '[Image #1] [Image #2] see these' },
      async () => ({ ok: true, images: [DATA, DATA] }));
    await waitFor(() => expect(container.querySelectorAll('.turn.user .turn-thumbs img')).toHaveLength(2));
    expect(spy).toHaveBeenCalledWith(42);
    expect(container.querySelector('.turn.user .turn-text')?.textContent).toBe('see these');
    expect((container.querySelector('.turn-thumbs img') as HTMLImageElement).alt).toBe('Attached image 1');
  });

  it('does not ask when your message has no image marker', async () => {
    const { spy, container } = showTurn({ role: 'user', text: 'just words' }, async () => ({ ok: true, images: [] }));
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    expect(spy).not.toHaveBeenCalled();
    expect(container.querySelector('.turn.user .turn-text')?.textContent).toBe('just words');
  });

  it('leaves the text exactly as it was when the images cannot be read', async () => {
    const { container } = showTurn({ role: 'user', text: '[Image #1] look' }, async () => ({ ok: false, reason: 'not_found' }));
    await waitFor(() => expect(container.querySelector('.turn.user')).toBeTruthy());
    await act(async () => {});
    expect(container.querySelector('.turn-thumbs')).toBeNull();
    expect(container.querySelector('.turn.user .turn-text')?.textContent).toBe('[Image #1] look');
  });

  it('only asks for your messages, not the agent\'s', async () => {
    const { spy, container } = showTurn({ role: 'assistant', text: '[Image #1] quoted' }, async () => ({ ok: true, images: [DATA] }));
    await waitFor(() => expect(container.querySelector('.turn.assistant')).toBeTruthy());
    await act(async () => {});
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ConversationView -- attaching images and files', () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = (name = 'shot.png') => new File([PNG_BYTES], name, { type: 'image/png' });
  function withFleet(stage: (b: ArrayBuffer) => Promise<unknown> = async () => ({ ok: true, id: 'id-1' })) {
    const sendKeys = vi.fn(async () => ({ status: 'sent', queued: false }));
    const stageImage = vi.fn(stage);
    const stageFile = vi.fn(async () => ({ ok: true, id: 'file-1' }));
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      conversation: async () => ({ turns, nextCursor: null }), sendKeys, stageImage, stageFile,
    };
    return { sendKeys, stageImage, stageFile };
  }
  const pdf = (name = 'report.pdf') => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });
  const chips = (c: HTMLElement) => [...c.querySelectorAll('.convchip span')].map(s => s.textContent);

  it('attaches a picked image as a chip, sending its bytes to main', async () => {
    const { stageImage } = withFleet();
    const { container } = renderConv();
    const input = await waitFor(() => container.querySelector('input[type="file"]') as HTMLInputElement);
    // Any file can be picked; images and other files are told apart below.
    expect(input.accept).toBe('');
    fireEvent.change(input, { target: { files: [png()] } });
    await waitFor(() => expect(chips(container)).toEqual(['shot.png']));
    const sent = stageImage.mock.calls[0]![0] as ArrayBuffer;
    expect(new Uint8Array(sent)).toEqual(PNG_BYTES);
    expect((container.querySelector('.convchip img') as HTMLImageElement).src).toMatch(/^data:image\/png;base64,/);
  });

  it('the image button opens the file picker', async () => {
    withFleet();
    const { container } = renderConv();
    const btn = await screen.findByRole('button', { name: 'Attach files' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(btn);
    expect(click).toHaveBeenCalled();
  });

  it('sends the staged image ids with the text, then clears text and chips', async () => {
    const { sendKeys } = withFleet();
    const { container } = renderConv();
    const input = await waitFor(() => container.querySelector('input[type="file"]') as HTMLInputElement);
    fireEvent.change(input, { target: { files: [png()] } });
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    const box = screen.getByLabelText('Message this session') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'what is this?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(4821, 'what is this?', { images: ['id-1'], files: [] }));
    await waitFor(() => expect(chips(container)).toEqual([]));
    expect(box.value).toBe('');
  });

  it('sends an image with no text', async () => {
    const { sendKeys } = withFleet();
    const { container } = renderConv();
    const input = await waitFor(() => container.querySelector('input[type="file"]') as HTMLInputElement);
    fireEvent.change(input, { target: { files: [png()] } });
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    fireEvent.keyDown(screen.getByLabelText('Message this session'), { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(4821, '', { images: ['id-1'], files: [] }));
  });

  it('keeps the chips when the send is refused', async () => {
    const { sendKeys } = withFleet();
    sendKeys.mockResolvedValueOnce({ status: 'refused', reason: 'attachment_gone' } as never);
    const { container } = renderConv();
    const input = await waitFor(() => container.querySelector('input[type="file"]') as HTMLInputElement);
    fireEvent.change(input, { target: { files: [png()] } });
    await waitFor(() => expect(chips(container)).toHaveLength(1));
    fireEvent.keyDown(screen.getByLabelText('Message this session'), { key: 'Enter' });
    await screen.findByText('An attached image is no longer available. Remove it and attach it again.');
    expect(chips(container)).toHaveLength(1);
  });

  it('removes a chip with its button', async () => {
    withFleet();
    const { container } = renderConv();
    const input = await waitFor(() => container.querySelector('input[type="file"]') as HTMLInputElement);
    fireEvent.change(input, { target: { files: [png('a.png')] } });
    await waitFor(() => expect(chips(container)).toEqual(['a.png']));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(chips(container)).toEqual([]);
  });

  it('attaches an image pasted into the message box', async () => {
    const { stageImage } = withFleet();
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.paste(box, { clipboardData: { files: [png('')], getData: () => '' } });
    await waitFor(() => expect(chips(container)).toEqual(['Pasted image']));
    expect(stageImage).toHaveBeenCalledTimes(1);
  });

  it('attaches an image dropped on the conversation, showing a drop target while dragging', async () => {
    withFleet();
    const { container } = renderConv();
    await screen.findByLabelText('Message this session');
    const pane = container.querySelector('.convwrap') as HTMLElement;
    const dataTransfer = { types: ['Files'], files: [png('dropped.png')], dropEffect: '' };
    fireEvent.dragOver(pane, { dataTransfer });
    expect(container.querySelector('.convdrop')).toBeTruthy();
    fireEvent.drop(pane, { dataTransfer });
    await waitFor(() => expect(chips(container)).toEqual(['dropped.png']));
    expect(container.querySelector('.convdrop')).toBeNull();
  });

  it('says so, and adds no chip, when main refuses a file', async () => {
    withFleet(async () => ({ ok: false, reason: 'not_image' }));
    const { container } = renderConv();
    const input = await waitFor(() => container.querySelector('input[type="file"]') as HTMLInputElement);
    fireEvent.change(input, { target: { files: [png('fake.png')] } });
    await screen.findByText('fake.png is not a PNG, JPEG, GIF or WebP image.');
    expect(chips(container)).toEqual([]);
  });

  it('attaches any other file by name, with a file icon, and sends it as a file', async () => {
    const { sendKeys, stageImage, stageFile } = withFleet();
    const { container } = renderConv();
    const input = await waitFor(() => container.querySelector('input[type="file"]') as HTMLInputElement);
    fireEvent.change(input, { target: { files: [pdf()] } });
    await waitFor(() => expect(chips(container)).toEqual(['report.pdf']));
    expect(stageImage).not.toHaveBeenCalled();
    const [bytes, name] = stageFile.mock.calls[0] as unknown as [ArrayBuffer, string];
    expect([...new Uint8Array(bytes)]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(name).toBe('report.pdf');
    expect(container.querySelector('.convchip img')).toBeNull();
    expect(container.querySelector('.convchip svg')).toBeTruthy();
    const box = screen.getByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'summarise' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendKeys).toHaveBeenCalledWith(4821, 'summarise', { images: [], files: ['file-1'] }));
  });

  it('takes a dropped or pasted non-image file as a file', async () => {
    const { stageFile } = withFleet();
    const { container } = renderConv();
    const box = await screen.findByLabelText('Message this session');
    fireEvent.paste(box, { clipboardData: { files: [pdf('pasted.pdf')], getData: () => '' } });
    await waitFor(() => expect(chips(container)).toEqual(['pasted.pdf']));
    const pane = container.querySelector('.convwrap') as HTMLElement;
    const dataTransfer = { types: ['Files'], files: [pdf('dropped.txt')], dropEffect: '' };
    fireEvent.dragOver(pane, { dataTransfer });
    fireEvent.drop(pane, { dataTransfer });
    await waitFor(() => expect(chips(container)).toEqual(['pasted.pdf', 'dropped.txt']));
    expect(stageFile).toHaveBeenCalledTimes(2);
  });

  it('offers no attaching for a session that cannot be typed into', async () => {
    withFleet();
    renderConv({ tmux: false });
    const btn = await screen.findByRole('button', { name: 'Attach files' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

// src/renderer/** may not import values from src/main/**; this pins the
// renderer's attachment cap to the one main enforces.
it('keeps the renderer attachment cap equal to main\'s', async () => {
  const { MAX_ATTACHMENTS } = await import('../../src/main/attachments.ts');
  const { MAX_ATTACH } = await import('../../src/renderer/components/ConversationView.tsx');
  expect(MAX_ATTACH).toBe(MAX_ATTACHMENTS);
});
