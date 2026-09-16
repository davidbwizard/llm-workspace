import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { ConversationView, nearOlderEdge, nearBottom, restoredScrollTop } from '../../src/renderer/components/ConversationView.tsx';

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
  return render(<ConversationView sessionId="s1" provider="claude" {...props} />);
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

    rerender(<ConversationView sessionId="s2" provider="claude" />);
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
