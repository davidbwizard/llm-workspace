# Conversation Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the conversation from a read-only catch-up list into the place David talks to a session: chat order, live updates, a message box that accepts multi-line text, a settings modal behind a gear, compact cards, and the Claude logo in place of the word "agent".

**Architecture:**
- `conversationFor` emits each page oldest-first, prompt before reply. The paging contract (`before`, `nextCursor`) is untouched.
- `ConversationView` grows a scroll contract (land at the bottom, prepend older pages with a scroll-height restore, sticky bottom), a refetch driven by the `events` count MainPane already receives, and a message box.
- Multi-line outbound text is delivered as a tmux **bracketed paste** (`load-buffer` + `paste-buffer -p -d` + `Enter`). The single-line `send-keys -l` path is unchanged and still refuses newlines.
- A new renderer-only store, `src/renderer/state/settings.ts`, holds four per-viewer preferences in one `llmws:settings` key, published to components through `useSyncExternalStore`.
- Appearance also reaches main over a new `app:theme` channel, which sets `nativeTheme.themeSource` and mirrors the choice to one small file so the window's first paint is not dark for a light user.

**Tech Stack:** TypeScript, React 18, Electron main process, better-sqlite3, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-15-conversation-pane-design.md`
**Read first:** `docs/superpowers/specs/2026-09-15-part-1-handoff.md`

## Global Constraints

- **Renderer safety.** Nothing under `src/renderer/**` may import `node:*` or `src/main/**` **for a value**. A value import from a module that reaches Node blanks the whole window (see `src/renderer/components/SessionRail.tsx:2-7`, which records the incident). Type-only imports are erased at build and are fine — `import type { KeysResult } from '../../main/ipc.ts'` is already done in `ReplyPopover.tsx:2`.
- **Dependencies:** none added. React 18's own `useSyncExternalStore`, the platform's `<dialog>`, and tmux's own buffer commands are the whole toolkit. No focus-trap library, no modal library, no state library.
- **No emojis** in code, comments, UI strings, test names, or commit messages.
- **Scope:** never touch `game-viewer/`. Commit only the files each task names.
- **Settings keys are namespaced `llmws:`** — the same convention `SessionRail.tsx:33` already uses for `llmws:rail-width`. This work adds exactly one key, `llmws:settings`. The rail's own key stays where it is and is not absorbed.
- **The outbound 4,000 character cap stays.** `MAX_REPLY_CHARS = 4000` (`src/main/outbound.ts:8`) applies to the paste path exactly as it does to the keystroke path. Control-character stripping stays too. Only the newline refusal is relaxed, and only for the paste path.
- **The conversation stylesheet shares no class name with the card stylesheets**, and contains no hardcoded hex. Both are pinned by `tests/renderer/ConversationView.css.test.ts` (class isolation at `:95`, no-hex at `:85`). The reason is real: `SessionCard.css` styles `.said` with a 2-line clamp, and the conversation once used that class, so every reply longer than two lines was clipped in the real window while jsdom passed every test. Every new conversation class in this plan is prefixed `conv`.
- **Tests:**
  - Run one file with `npx vitest run <file>`.
  - The full suite needs the native database module built for **Node**; the app needs it built for **Electron**. `npm test` runs a `pretest` step that rebuilds for Node and `npm run dev` rebuilds for Electron, so **the two cannot run at once**. Order: eyes-on, stop the app, then build and test, then restart.
  - `tests/fleet/state.test.ts` sometimes crashes its worker (a known Node 24 / better-sqlite3 GC bug). A short count with "Worker exited unexpectedly" means rerun, not failure.
- **Measured facts this plan depends on:**
  - **jsdom 30.0.1 does not implement `HTMLDialogElement.showModal()` or `.close()`** — verified directly against this project's installed jsdom: both read `undefined`. The settings modal therefore guards both calls and falls back to the `open` attribute under test. Chromium has both, and they are what supply the real top layer, focus trap and Escape.
  - **jsdom computes no layout.** `scrollHeight`/`clientHeight` are getter-only (`ConversationView.test.tsx:158-161` already works around this with `Object.defineProperty`). Every piece of scroll arithmetic in this plan is therefore an exported pure function over plain numbers, tested as numbers.
  - **Bracketed paste arrives as one message.** Measured 2026-09-15: Claude Code receives a bracketed paste as a single message and does not submit on the embedded newlines, which is why the newline refusal can be relaxed on that path and only that path.

## Spec decisions this plan resolves

Two places where the spec is not self-consistent. Both are recorded here so a reviewer sees the ruling rather than a silent choice.

1. **Where the appearance choice is stored.** §5 says "the settings live entirely in the renderer"; §3.5 says `src/main/index.ts:47` "reads the stored choice at startup so a light user does not get a dark flash". Main cannot read the renderer's `localStorage`, and the window is created before the renderer exists. **Ruling:** main mirrors *only* the appearance value (one of three literals) to `~/.llm-workspace/appearance.json` whenever `app:theme` arrives, and reads it back at startup. Every other setting stays renderer-only. Cost if wrong: one small file, deletable, with no effect on anything but the first paint.
2. **"No pid anywhere."** §1 says no pid anywhere; §3.6 names exactly one thing — the card's accessible name (`OpenSessionCard.tsx:306`) — as losing it. **Ruling:** the visible pid line goes, and the card's accessible name loses `pid N`. The *nested control* labels (`Close, pid 4242`, `Reattach in app, pid 4242`, and the new menu button) keep it, because they exist only to tell otherwise-identical buttons on different cards apart, and two open sessions can share a project name. Cost if wrong: three aria-label strings, changed in one file.

## Deviations from the spec's task shape

- **Task 1 carries the conversation's typography, the meta line, the provider mark and the header path as well as the page order**, because it already rewrites that exact render loop and its date-grouping walk; splitting them would mean rewriting the same twenty lines twice.
- **The agent's mark is the session's own provider mark, not a hardcoded Claude logo** — MainPane knows the provider, and a Codex session showing the Claude logo would be a lie. For a Claude session the rendered result is exactly what §2 asks for.

---

## File Map

| File | Change | Responsibility |
|---|---|---|
| `src/store/conversation.ts` | modify | Pages emit oldest-first, prompt before reply |
| `src/renderer/components/ConversationView.tsx` | modify | Chat order, scroll contract, live refresh, message box |
| `src/renderer/components/ConversationView.css` | modify | Chat layout, size scale, styles A and C |
| `src/renderer/components/MainPane.tsx` | modify | Folder path in the header; threads provider/pid/tmux/events |
| `src/renderer/components/MainPane.css` | modify | Header path styling; `min-height:0` on `.pane` |
| `src/renderer/components/ReplyPopover.tsx` | modify | Export `REFUSAL_TEXT` so the box reuses the popover's wording |
| `src/main/outbound.ts` | modify | `multiline` allowance, used only by the paste path |
| `src/main/tmux.ts` | modify | `loadBuffer`, `pasteBuffer`, stdin-capable `TmuxExec` |
| `src/main/ipc.ts` | modify | Paste path in `sendKeysFor`; `applyThemeChoice`; `app:theme` |
| `src/main/appearance.ts` | create | Read/write the one mirrored appearance value |
| `src/main/index.ts` | modify | `nativeTheme.themeSource` and first-paint background at startup |
| `src/config.ts` | modify | `Paths.appearance` |
| `src/preload/index.ts` | modify | `setTheme` |
| `src/renderer/types.d.ts` | modify | `setTheme` on the bridge |
| `src/renderer/state/settings.ts` | create | The four per-viewer settings, one `llmws:` key |
| `src/renderer/components/SettingsModal.tsx` | create | The modal behind the gear |
| `src/renderer/components/SettingsModal.css` | create | Modal chrome and the background scroll lock |
| `src/renderer/components/Icon.tsx` | modify | The gear joins the shared Phosphor icon set |
| `src/renderer/components/LaunchBar.tsx` | modify | The gear, and focus return on close |
| `src/renderer/components/LaunchBar.css` | modify | Gear button; no-drag for the dialog |
| `src/renderer/App.tsx` | modify | Applies `data-theme` and tells main |
| `src/renderer/components/OpenSessionCard.tsx` | modify | `compact` variant, the `...` menu, pid removal |
| `src/renderer/components/OpenSessionCard.css` | modify | Compact rules and the menu popover |
| `src/renderer/components/SessionRail.tsx` | modify | Passes `compact` from the setting |
| `src/renderer/components/FleetView.tsx` | modify | Passes `compact` from the setting |
| `src/renderer/components/ProviderMark.tsx` | modify | The Claude glyph replaces the Anthropic one |
| `tests/store/conversation.test.ts` | modify | New page order |
| `tests/renderer/ConversationView.test.tsx` | modify | Order, scroll, live refresh, message box |
| `tests/renderer/ConversationView.css.test.ts` | modify | Accent moves to the agent; size scale |
| `tests/renderer/MainPane.test.tsx` | modify | Header path and the threaded props |
| `tests/renderer/OpenSessionCard.test.tsx` | modify | Compact variant, menu, no pid |
| `tests/renderer/SessionRail.test.tsx` | modify | Compact from the setting |
| `tests/renderer/FleetView.test.tsx` | modify | Compact from the setting |
| `tests/renderer/LaunchBar.test.tsx` | modify | The gear opens the modal |
| `tests/renderer/ProviderMark.test.tsx` | modify | The Claude glyph |
| `tests/renderer/theme.test.ts` | modify | First-paint colours match the tokens |
| `tests/renderer/settings.test.ts` | create | Store validation and persistence |
| `tests/renderer/SettingsModal.test.tsx` | create | Modal behaviour |
| `tests/renderer/Icon.test.tsx` | modify | The gear joins the pinned icon set |
| `tests/main/outbound.test.ts` | modify | The multiline allowance |
| `tests/main/tmux.test.ts` | modify | `loadBuffer`/`pasteBuffer` |
| `tests/main/ipc.test.ts` | modify | Paste path; `applyThemeChoice` |
| `tests/main/appearance.test.ts` | create | The mirrored appearance file |
| `tests/main/security.test.ts` | modify | `app:theme` joins the enumerated channels |
| `tests/cli.test.ts` | modify | `Paths.appearance` |

`tests/renderer/SessionCard.test.tsx` is listed in the brief but needs **no change**: `SessionCard` is the History card, it never rendered a pid, and nothing in this work touches it. `SessionCard.css` is likewise untouched — the compact variant only *adds* `.card.compact` rules, so the base `.card`/`.said`/`.proj` rules the open-session card relies on globally keep their current values.

---

### Task 1: The conversation reads as a chat

**Files:**
- Modify: `src/store/conversation.ts:58-94` (doc comment), `:140-156` (turn assembly)
- Modify: `src/renderer/components/ConversationView.tsx:1-6` (imports), `:53-66` (date/time helpers, unchanged), `:200-238` (render loop)
- Modify: `src/renderer/components/ConversationView.css` (layout, size scale, styles A and C)
- Modify: `src/renderer/components/MainPane.tsx:84` (header title), `:101` (props)
- Modify: `src/renderer/components/MainPane.css:16` (`.panetitle`)
- Test: `tests/store/conversation.test.ts`, `tests/renderer/ConversationView.test.tsx`, `tests/renderer/ConversationView.css.test.ts`, `tests/renderer/MainPane.test.tsx`

**Interfaces:**
- Consumes: `ConversationPage`, `ConversationTurn`, `ConversationStep` (unchanged shapes); `ProviderMark({ provider, size })`; `Provider` from `src/core/types.ts`.
- Produces:
  - `conversationFor(db, sessionId, limit?, before?)` — same signature, same `nextCursor` contract; `turns` are now **oldest-first, prompt before reply**.
  - `ConversationView({ sessionId, match, provider })` — `provider: Provider` is new and required.

> The load-more direction is deliberately **not** changed here; Task 2 owns it. Between this task and Task 2 the app renders correctly but pages older content to the wrong end, so do not eyes-on test in that window.

- [ ] **Step 1: Write the failing tests**

In `tests/store/conversation.test.ts`, flip the order inside every page assertion. The page *sequence* never changes — only the order within a page.

Line 83:
```ts
    expect(view(conversationFor(db, 's1').turns)).toEqual(['you: fix the bug', 'agent: Fixed.']);
```

Lines 99-104:
```ts
    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'you: first ask',
      'agent: All green. [Reading the file.|Running tests.]',
      'you: second ask',
      'agent: Done.',
    ]);
```

Lines 115-117:
```ts
    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'you: a', 'agent: b', 'you: still thinking about this one',
    ]);
```

Lines 128-130:
```ts
    expect(view(conversationFor(db, 's1').turns)).toEqual([
      'agent: resumed reply [resumed narration]', 'you: thanks',
    ]);
```

Line 141:
```ts
    expect(view(conversationFor(db, 's1').turns)).toEqual(['you: /clear', 'agent: ok']);
```

Line 156 (and its comment above, lines 144-146):
```ts
  // Bug fix (kept from the row-paged version): the page is the NEWEST
  // exchanges, not the opening of a days-old conversation. Paging is by
  // human prompt, so `limit` counts exchanges; the page's own contents are
  // ordered oldest-first, prompt before reply, which is the order the pane
  // renders top to bottom.
  it('returns the newest exchanges, not the oldest, when a session exceeds the limit', () => {
```
```ts
    expect(view(conversationFor(db, 's1', 1).turns)).toEqual(['you: turn 2', 'agent: turn 3 (newest)']);
```

Lines 189-191:
```ts
    const page1 = conversationFor(db, 's1', 1);
    expect(view(page1.turns)).toEqual(['you: p2', 'agent: r2 [s4]']);
    const page2 = conversationFor(db, 's1', 1, page1.nextCursor!);
    expect(view(page2.turns)).toEqual(['you: p1', 'agent: r1 [s1|s2|s3]']);
```

Lines 210 and 216:
```ts
    expect(view(page1.turns)).toEqual(['you: turn 3', 'agent: turn 4', 'you: turn 5 (newest)']);
```
```ts
    expect(view(page2.turns)).toEqual(['agent: pre-prompt reply', 'you: turn 1', 'agent: turn 2']);
```

Lines 243-246 (each page is internally oldest-first; the walk still goes newest page to oldest page):
```ts
    expect(seen).toEqual([
      'you: c (newer half of the tie)', 'agent: d (newest)',
      'you: a (oldest)', 'agent: b (older half of the tie)',
    ]);
```

In `tests/renderer/ConversationView.test.tsx`, add a render helper just below the `fmtTime` definition (line 14) and use it everywhere:

```tsx
// Every test renders the pane for a Claude session unless it says
// otherwise. One helper, so the component's required props live in one
// place rather than in twenty-odd render calls.
function renderConv(props: Partial<React.ComponentProps<typeof ConversationView>> = {}) {
  return render(<ConversationView sessionId="s1" provider="claude" {...props} />);
}
```

Add `import React from 'react';` to the top of the file (it currently relies on the automatic JSX runtime and never names `React`).

Replace every existing render call with the helper:
- `render(<ConversationView sessionId="s1" />)` becomes `renderConv()` (lines 24, 30, 45, 127, 137, 146, 176, 203, 224, 239, 255)
- `render(<ConversationView sessionId="empty" />)` becomes `renderConv({ sessionId: 'empty' })` (line 57)
- `render(<ConversationView sessionId={null} match="ambiguous" />)` becomes `renderConv({ sessionId: null, match: 'ambiguous' })` (line 79)
- `render(<ConversationView sessionId={null} match="unknown" />)` becomes `renderConv({ sessionId: null, match: 'unknown' })` (line 86)
- `render(<ConversationView sessionId={null} />)` becomes `renderConv({ sessionId: null })` (lines 92, 109)
- inside `showOne` (line 267), `return render(<ConversationView sessionId="s1" />);` becomes `return renderConv();`

Rewrite the order test at line 115-131:

```tsx
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
```

Append a new describe at the end of the file:

```tsx
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
```

In `tests/renderer/ConversationView.css.test.ts`, replace the whole first describe (lines 29-63) with:

```ts
describe('ConversationView.css: user and agent turns are visually distinguishable', () => {
  const base = blockAfter('.turn {');
  const assistant = blockAfter('.turn.assistant {');
  const baseSaid = blockAfter('.turn .turn-text {');
  const userSaid = blockAfter('.turn.user .turn-text {');

  // Style A, the default David picked against the rendered mockup: the
  // accent rule runs down the AGENT's replies, never the user's. The
  // structural cue is the rule's WIDTH (present vs absent), so it survives
  // greyscale and a colour-vision deficiency; the accent hue is a second,
  // redundant cue layered on top.
  it('gives agent turns a margin rule that the shared/user rule does not have', () => {
    expect(assistant).toMatch(/border-left:\s*[1-9]/); // a real, nonzero width
    expect(base).not.toMatch(/border-left/); // absent from the rule user turns fall back to
  });

  // The second, independent-of-colour cue: Karla is a variable font
  // (200-800, see the @font-face rule in theme.css), so a heavier
  // font-weight here is a real cut change, not a faked bold. It stays on
  // the user's text -- the human prompts are the landmarks when scanning.
  it('gives user turns a heavier weight than agent turns, independent of colour', () => {
    expect(userSaid).toMatch(/font-weight:\s*[5-9]\d\d/);
    expect(baseSaid).not.toMatch(/font-weight/);
  });

  it('backs the structural cues with the app\'s existing ink/ink-2 pair and its one emphasis colour', () => {
    expect(assistant).toMatch(/var\(--accent\)/);
    expect(userSaid).toMatch(/color:\s*var\(--ink\)\s*;/);
    expect(baseSaid).toMatch(/color:\s*var\(--ink-2\)\s*;/);
  });

  it('uses theme tokens for every colour here, never a hardcoded hex', () => {
    expect(assistant).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(userSaid).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('ConversationView.css: one text size drives the whole pane', () => {
  // Spec §3.5: conversation text size is a CSS variable on the
  // conversation root, and every message-level size is expressed relative
  // to it -- so changing it in Settings moves the meta lines, code blocks
  // and steps with the body text instead of leaving them behind.
  it('declares --conv-size on the conversation root, defaulting to 16px', () => {
    expect(blockAfter('.conv {')).toMatch(/--conv-size:\s*16px/);
  });

  it('sizes the meta line, code, tables and steps off that variable, not off a fixed px', () => {
    for (const selector of ['.turn .who, .turn .when {', '.turn-text.md code {',
                            '.turn-text.md pre {', '.turn-text.md table {',
                            '.steps-toggle {', '.steps-list {']) {
      expect(blockAfter(selector), selector).toMatch(/font-size:\s*calc\(var\(--conv-size\)/);
    }
  });

  it('offers style C as well as the default style A, keyed off data-style', () => {
    expect(css).toMatch(/\.conv\[data-style="c"\]/);
  });
});
```

In `tests/renderer/MainPane.test.tsx`, add:

```tsx
  // Spec §3.7: the rail already names the project, so the pane header
  // carries the session's FOLDER PATH instead -- with a title for the
  // untruncated value, since a deep path will not fit.
  it('shows the session folder path in the header, not the project name, with a full-value title', () => {
    const { container } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    const title = container.querySelector('.panetitle')!;
    expect(title.textContent).toBe('/a');
    expect(title.getAttribute('title')).toBe('/a');
  });

  it('hands the conversation the session provider, so the agent glyph is that session\'s own', () => {
    const codex = [{ ...(sessions[0] as object), provider: 'codex' }] as never[];
    (window as unknown as { fleet: { conversation: ReturnType<typeof vi.fn> } }).fleet.conversation =
      vi.fn().mockResolvedValue({
        turns: [{ id: 1, ts: '2026-09-12T10:00:00Z', role: 'assistant', text: 'ok', steps: [] }],
        nextCursor: null,
      });
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={codex} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    return waitFor(() => expect(screen.getByText('Codex')).toBeTruthy());
  });
```

Add `waitFor` to the `@testing-library/react` import on line 2.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/store/conversation.test.ts tests/renderer/ConversationView.test.tsx tests/renderer/ConversationView.css.test.ts tests/renderer/MainPane.test.tsx`

Expected: FAIL.
- `conversation.test.ts`: every flipped assertion, e.g. `expected [ 'agent: Fixed.', 'you: fix the bug' ] to deeply equal [ 'you: fix the bug', 'agent: Fixed.' ]`.
- `ConversationView.test.tsx`: a TypeScript error on the unknown `provider` prop, then `expected null to be truthy` for `.turn.assistant .who svg`.
- `ConversationView.css.test.ts`: `selector not found: .turn.assistant {`.
- `MainPane.test.tsx`: `expected 'llm-workspace' to be '/a'`.

- [ ] **Step 3: Emit each page in conversation order**

In `src/store/conversation.ts`, replace the `Order:` paragraph of `conversationFor`'s doc comment (lines 70-73) with:

```
 *  Order WITHIN a page: oldest first, prompt before reply -- the order the
 *  pane renders top to bottom (spec 2026-09-15-conversation-pane-design.md
 *  §3.1). Paging still walks BACKWARDS through history: `before` is the
 *  cursor for the next OLDER page and `nextCursor` still names the oldest
 *  prompt this page kept. The bug this once had (ASC with a LIMIT showed a
 *  days-old opening and hid the recent part) must not come back: the
 *  prompt query below is still ORDER BY ts DESC with a LIMIT, so the FIRST
 *  page is still the newest exchanges. Only the assembled array's order
 *  changed, not which exchanges a page contains.
```

Replace the turn-assembly loop (lines 140-156) with:

```ts
  // prompt.submitted = user, prose = assistant, in BOTH parsers. This is the
  // provider-agnostic backbone; richer detail (tokens, tool payloads) is not.
  //
  // Emitted here in conversation order rather than reversed downstream: the
  // stretch loop above already knows the prompt-to-reply pairing, so saying
  // it once here is smaller than re-deriving it in the view, and every
  // consumer wants the same order.
  const turns: ConversationTurn[] = [];
  for (const { prompt, prose } of stretches) {
    // A wrapper that names no command unwraps to '' and shows nothing, but
    // it still bounds its stretch -- that keeps paging and grouping agreed.
    const text = prompt?.text ? unwrapSlashCommand(prompt.text) : '';
    if (prompt && text !== '') {
      turns.push({ id: prompt.id, ts: prompt.ts, role: 'user', text, steps: [] });
    }
    const reply = prose[prose.length - 1];
    if (reply) {
      turns.push({
        id: reply.id, ts: reply.ts, role: 'assistant', text: reply.text!,
        steps: prose.slice(0, -1).map(s => ({ id: s.id, ts: s.ts, text: s.text! })),
      });
    }
  }
  return { turns, nextCursor };
```

- [ ] **Step 4: Render the pane as a chat**

In `src/renderer/components/ConversationView.tsx`, add to the imports at the top:

```ts
import type { Provider } from '../../core/types.ts';
import { ProviderMark } from './ProviderMark.tsx';
```

Add above `MARKDOWN_COMPONENTS`:

```ts
/** The word "agent" is gone from the meta line (spec §2): the agent is
 *  marked with its provider's own glyph, in the accent colour. The glyph is
 *  aria-hidden (ProviderMark.tsx), so the provider's NAME rides along in a
 *  visually-hidden span -- a screen reader hears "Claude", a reader sees the
 *  mark, and neither hears nor sees the word "agent". */
const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };
```

Replace the render loop's leading comment and body (lines 200-238, through the closing `);` of the return) with:

```tsx
  // Chat order (spec §3.1): oldest at the top, newest at the bottom.
  // conversationFor already returns each page in that order, so there is no
  // re-sort here -- and the date-repeat check below walks the same
  // top-to-bottom order the reader sees, which is now oldest date first.
  let prevDate = '';
  return (
    <div className="conv" data-style="a" onScroll={handleScroll}>
      {turns.map(t => {
        const date = formatDate(t.ts);
        const showDate = date !== prevDate;
        prevDate = date;
        return (
          <article key={t.id} className={`turn ${t.role}`}>
            <div className="meta">
              {t.role === 'user'
                ? <span className="who">you</span>
                : (
                  <span className="who">
                    <ProviderMark provider={provider} size={13} />
                    <span className="wholabel">{PROVIDER_NAME[provider]}</span>
                  </span>
                )}
              <span className="when">{showDate ? `${date} ${formatTime(t.ts)}` : formatTime(t.ts)}</span>
            </div>
            {t.role === 'user'
              ? <p className="turn-text">{t.text}</p>
              : (
                <div className="turn-body">
                  <div className="turn-text md"><MarkdownText text={t.text} /></div>
                  {t.steps.length > 0 && <Steps steps={t.steps} />}
                </div>
              )}
          </article>
        );
      })}
      {loadingMore && <p className="conv-loading-more">Loading more…</p>}
      {!loadingMore && nextCursor === null && (
        // A genuine end-of-history fact, not an apology -- unlike the old
        // truncation notice this replaces, nothing here is hidden; older
        // turns just have not been fetched yet, and now there are none left.
        <p className="conv-end">Beginning of this session's recorded conversation.</p>
      )}
    </div>
  );
```

Change the component signature (line 122) to:

```tsx
export function ConversationView({ sessionId, match, provider }: {
  sessionId: string | null;
  match?: MatchQuality;
  /** Which CLI this session is, so the agent's meta line carries that
   *  provider's own mark. MainPane always knows it (OpenSession.provider
   *  comes straight from the pgrep that found the process). */
  provider: Provider;
}) {
```

- [ ] **Step 5: Restyle the pane**

In `src/renderer/components/ConversationView.css`, replace lines 2-23 with:

```css
/* --conv-size is the ONE size the whole pane is built from: every
   message-level rule below is expressed relative to it, so the Settings
   slider moves the meta lines, code blocks and steps with the body text
   instead of leaving them behind (spec §3.5). 16px is the default David
   chose against the rendered mockup, up from the 13px this pane shipped
   with; SettingsModal writes 14-17 over it as an inline style. */
.conv { --conv-size:16px; font-size:var(--conv-size); line-height:1.55;
  padding:14px 18px; overflow-y:auto; flex:1; }
.turn { display:block; margin-bottom:16px; }
/* Style A, the default: the accent rule runs down the AGENT's replies.
   David chose it against rendered options, and chose the agent rather than
   the user deliberately -- the replies are the bulk of the pane, and
   accenting them is what makes the two sides read apart while scrolling.
   The rule's WIDTH (3px vs none) is the real, colour-independent signal: a
   colourblind reader, or the pane in greyscale, still sees a turn set off
   from the margin. The accent hue is a second, redundant cue on top, and
   the user's heavier font-weight below is a third, independent of colour
   entirely (Karla is a variable font, 200-800, see theme.css). */
.turn.assistant { border-left:3px solid var(--accent); padding-left:11px; }
/* Name and time on ONE line above the message (spec §2), replacing the
   56px left gutter this pane used to reserve for them. */
.turn .meta { display:flex; align-items:center; gap:8px; margin:0 0 4px; }
.turn .who { font-family:var(--f-mono); color:var(--muted);
  display:inline-flex; align-items:center; }
.turn.assistant .who { color:var(--accent); }
.turn .who, .turn .when { font-size:calc(var(--conv-size) * 0.6875); }
.turn .when { font-family:var(--f-mono); color:var(--faint); white-space:nowrap; }
/* The provider's name, for assistive tech only: ProviderMark's svg is
   aria-hidden, so without this the agent's turns would announce with no
   speaker at all. Not `display:none`, which removes it from the
   accessibility tree as well as the page. */
.wholabel { position:absolute; width:1px; height:1px; margin:-1px; padding:0;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
.turn .turn-text { margin:0; font-size:1em; line-height:inherit; color:var(--ink-2);
  white-space:pre-wrap; min-width:0; }
.turn.user .turn-text { color:var(--ink); font-weight:600; }
```

Replace the markdown size rules (lines 35-47) with:

```css
.turn-text.md h1, .turn-text.md h2, .turn-text.md h3, .turn-text.md h4, .turn-text.md h5, .turn-text.md h6 {
  margin:12px 0 5px; font-size:1em; font-weight:700; color:var(--ink); }
.turn-text.md a { color:var(--accent); }
.turn-text.md blockquote { padding-left:8px; border-left:2px solid var(--line); color:var(--muted); }
.turn-text.md code { font-family:var(--f-mono); font-size:calc(var(--conv-size) * 0.8125);
  background:var(--raised); border-radius:4px; padding:1px 4px; }
.turn-text.md pre { font-family:var(--f-mono); font-size:calc(var(--conv-size) * 0.8125); line-height:1.45;
  background:var(--raised); border:1px solid var(--line-soft); border-radius:var(--r-sm); padding:8px 10px;
  overflow-x:auto; white-space:pre; }
.turn-text.md pre code { background:none; border-radius:0; padding:0; font-size:inherit; }
.turn-text.md table { display:block; max-width:100%; overflow-x:auto; border-collapse:collapse;
  font-size:calc(var(--conv-size) * 0.8125); }
.turn-text.md th, .turn-text.md td { border:1px solid var(--line); padding:3px 8px; text-align:left; vertical-align:top; }
.turn-text.md th { background:var(--raised); color:var(--ink); font-weight:600; }
.turn-text.md .md-image { font-style:italic; color:var(--muted); }
```

Replace the steps size rules (lines 53, 57-58, 61) with:

```css
.steps-toggle { font-family:var(--f-mono); font-size:calc(var(--conv-size) * 0.6875); color:var(--faint);
  background:none; border:0; padding:2px 0; cursor:pointer; }
```
```css
.steps-list { list-style:none; margin:4px 0 0; padding-left:10px; border-left:1px solid var(--line-soft);
  color:var(--muted); font-size:calc(var(--conv-size) * 0.8125); line-height:1.45; }
```
```css
.steps-list code, .steps-list pre { font-family:var(--f-mono); font-size:calc(var(--conv-size) * 0.75); }
```

Append at the end of the file:

```css
/* Style C, the alternative David asked to keep available: YOUR messages in
   a neutral bubble on the right, the agent's left-aligned and unaccented.
   Selected by data-style on the conversation root (SettingsModal); style A
   above is what renders with no attribute or data-style="a". Neutral, not
   accent: the accent is style A's agent cue and reusing it here would put
   two differently-meant accent marks in one pane. */
.conv[data-style="c"] .turn.assistant { border-left:0; padding-left:0; }
.conv[data-style="c"] .turn.user { margin-left:auto; max-width:78%;
  background:var(--raised); border:1px solid var(--line-soft);
  border-radius:var(--r-md); padding:8px 12px; }
.conv[data-style="c"] .turn.user .meta { justify-content:flex-end; }
```

- [ ] **Step 6: Put the folder path in the header**

In `src/renderer/components/MainPane.tsx`, replace line 84 with:

```tsx
          {/* The rail already names the project, so this carries the thing
              the rail cannot fit: the session's full working directory
              (spec §3.7). `title` keeps the untruncated value reachable on
              hover and to assistive tech once the CSS ellipsis bites. */}
          <span className="panetitle" title={session?.cwd ?? undefined}>{session?.cwd ?? 'session'}</span>
```

Replace the `ConversationView` element (line 101) with:

```tsx
          : <ConversationView sessionId={session?.sessionId ?? null} match={session?.match}
              // Falls back to 'claude' only when the selected pid has left
              // the fleet entirely -- the pane is then showing a stale
              // selection and the glyph is cosmetic.
              provider={session?.provider ?? 'claude'} />}
```

In `src/renderer/components/MainPane.css`, replace line 16 with:

```css
/* A path, not a name: mono, quiet, and truncated from the right rather
   than wrapping the header onto a second line. min-width:0 is what lets it
   shrink inside the flex header at all. */
.panetitle { font-family:var(--f-mono); font-size:11px; color:var(--muted);
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/store/conversation.test.ts tests/renderer/ConversationView.test.tsx tests/renderer/ConversationView.css.test.ts tests/renderer/MainPane.test.tsx tests/main/ipc.test.ts`

Expected: PASS, all tests. `ipc.test.ts` is included because `session:conversation` returns `conversationFor`'s output directly; nothing there asserts turn order, so it should pass unchanged, and if it does not, the paging contract moved when it should not have.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/store/conversation.ts src/renderer/components/ConversationView.tsx src/renderer/components/ConversationView.css src/renderer/components/MainPane.tsx src/renderer/components/MainPane.css tests/store/conversation.test.ts tests/renderer/ConversationView.test.tsx tests/renderer/ConversationView.css.test.ts tests/renderer/MainPane.test.tsx
git commit -m "feat(conversation): oldest at the top, name and time on one line, the agent marked by its glyph"
```

---

### Task 2: Land at the bottom, grow upward without jumping

**Files:**
- Modify: `src/renderer/components/ConversationView.tsx:1` (imports), `:68-98` (`nearOlderEdge` and friends), `:122-198` (state, effects, branches, `loadMore`), `:207` (the wrapper)
- Modify: `src/renderer/components/ConversationView.css` (`.convwrap`, `.convjump`, `.convnote`)
- Modify: `src/renderer/components/MainPane.css:13` (`.pane` gains `min-height:0`)
- Test: `tests/renderer/ConversationView.test.tsx`

**Interfaces:**
- Consumes (Task 1): `ConversationView({ sessionId, match, provider })`.
- Produces, all exported from `ConversationView.tsx`:
  - `nearOlderEdge(metrics: { scrollTop: number }, thresholdPx?: number): boolean` — same name, same export, new meaning: near the TOP.
  - `nearBottom(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }, thresholdPx?: number): boolean`
  - `restoredScrollTop(scrollTopBefore: number, scrollHeightBefore: number, scrollHeightAfter: number): number`

  `LOAD_MORE_THRESHOLD_PX` (150) and `STICKY_BOTTOM_PX` (80) stay module-private, as `LOAD_MORE_THRESHOLD_PX` already is: each is the default of a parameter a caller can override, which is how the tests reach them.

- [ ] **Step 1: Write the failing tests**

In `tests/renderer/ConversationView.test.tsx`, replace the whole `nearOlderEdge` describe (lines 381-397) with:

```tsx
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
```

Add `nearBottom, restoredScrollTop` to the import on line 3.

Replace the "fetches the next older page and appends it" test (lines 163-190) with:

```tsx
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
```

Replace the "does not fire a second fetch" test's scroll lines (211-212) with:

```tsx
    fireEvent.scroll(scroller, { target: { scrollTop: 40 } });
    fireEvent.scroll(scroller, { target: { scrollTop: 20 } });
```

and delete the `stubScrollGeometry` call above them plus the helper itself (lines 151-161, 180, 207) — nothing left in this file needs stubbed geometry, because the trigger now reads only `scrollTop`, which jsdom genuinely implements.

Append a new describe at the end of the file:

```tsx
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
```

Finally, the three "cannot identify this session" tests (lines 78-102) currently assert on text alone and keep passing, but the element they land in is renamed. Add one assertion to the neutral-fallback test at line 91 so the rename is pinned:

```tsx
    expect(screen.getByText(/transcript can't be identified/i).className).toBe('convnote');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx`

Expected: FAIL. The file does not load: `The requested module ... does not provide an export named 'nearBottom'`.

- [ ] **Step 3: Replace the edge helpers**

In `src/renderer/components/ConversationView.tsx`, replace lines 68-98 (the `LOAD_MORE_THRESHOLD_PX` constant and `nearOlderEdge`) with:

```ts
/** How close (in px) to the TOP of the scroll container counts as "close
 *  enough to fetch the next page" -- a little slack so the fetch is already
 *  in flight by the time the reader actually reaches the oldest loaded
 *  message, rather than starting only once they hit the top and have to
 *  wait staring at nothing. */
const LOAD_MORE_THRESHOLD_PX = 150;

/** How close to the bottom counts as "still following the conversation".
 *  Inside this, new messages scroll the pane down; outside it, the view
 *  stays where the reader put it and offers Jump to latest instead (spec
 *  §3.2). 80px is roughly one message of slack. */
const STICKY_BOTTOM_PX = 80;

/** Chat order (spec §3.1) puts the OLDEST loaded turn at the TOP, so
 *  reading further back in time means scrolling UP -- and "running low on
 *  loaded history" means nearing the top, which is what this checks. It
 *  used to mean the opposite, because the pane used to render newest-first;
 *  that is the single behaviour change here, not a new function.
 *
 *  Takes only `scrollTop`: the distance from the top IS scrollTop, with no
 *  height arithmetic to do, which is also why the tests for this need no
 *  jsdom geometry stub at all.
 *
 *  Exported as a plain function over plain numbers, rather than inlined
 *  against a live element, because jsdom does not compute real layout. */
export function nearOlderEdge(metrics: { scrollTop: number }, thresholdPx = LOAD_MORE_THRESHOLD_PX): boolean {
  return metrics.scrollTop < thresholdPx;
}

/** Whether the reader is still following the newest end. Same
 *  numbers-not-elements shape as nearOlderEdge, for the same jsdom reason.
 *  A pane with nothing to scroll (scrollHeight <= clientHeight) reads as
 *  at-the-bottom, which is correct: there is no "up" to have scrolled to. */
export function nearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx = STICKY_BOTTOM_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

/** Where scrollTop must land after a PREPEND so the reader's eye does not
 *  move. Content inserted above the viewport pushes everything down by
 *  exactly the height it added, so adding that same delta back cancels it
 *  out. Clamped at 0: a commit that made the pane shorter would otherwise
 *  produce a negative position, which a browser clamps silently and jsdom
 *  stores verbatim -- a difference no test would catch except this one. */
export function restoredScrollTop(
  scrollTopBefore: number, scrollHeightBefore: number, scrollHeightAfter: number,
): number {
  return Math.max(0, scrollTopBefore + (scrollHeightAfter - scrollHeightBefore));
}
```

- [ ] **Step 4: Wire the scroll contract**

In `src/renderer/components/ConversationView.tsx`, change the React import on line 1 to:

```ts
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
```

Inside the component, replace the state block and mount effect (lines 123-144) with:

```tsx
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** True once new content has landed at the bottom while the reader was
   *  scrolled away from it -- the Jump to latest button's whole condition
   *  (spec §3.2). Cleared by reaching the bottom, by the button itself, and
   *  by switching session. */
  const [missedLatest, setMissedLatest] = useState(false);
  // A ref, not just the `loadingMore` state, guards the actual fetch:
  // scroll fires far faster than React re-renders commit, so a handler
  // that only checked state could read a stale "not loading" on two scroll
  // events back to back and fire two fetches. A ref is read and written
  // synchronously, with no render in between, so it is the guard that
  // actually holds under a real burst of scroll events, not just in a
  // test that calls the handler once.
  const loadingMoreRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Set by loadMore immediately before a prepend commits, consumed by the
   *  layout effect below. A ref rather than state because it must be read
   *  in the same commit that wrote it, with no render in between. */
  const pendingRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  /** Whether the reader was at the bottom at the last scroll event. Read in
   *  a layout effect, so it must be a ref, not state. */
  const stickyRef = useRef(true);
  /** Has this session's pane been scrolled to the bottom yet. */
  const landedRef = useRef(false);
  /** The last turn's identity AND length, so a reply that grows in place as
   *  it streams counts as new content just as a brand-new turn does. */
  const lastTurnKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (sessionId === null) return; // nothing to fetch -- see the doc comment above.
    let alive = true;
    setPage(null);
    setMissedLatest(false);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    pendingRestoreRef.current = null;
    stickyRef.current = true;
    landedRef.current = false;
    lastTurnKeyRef.current = null;
    void window.fleet?.conversation(sessionId).then(p => {
      if (alive) setPage(p);
    });
    return () => { alive = false; };
  }, [sessionId]);

  /** All scroll bookkeeping, in a LAYOUT effect so it runs before the
   *  browser paints: landing at the bottom or restoring a prepend in a
   *  plain effect would show one frame at the wrong offset first.
   *
   *  jsdom computes no layout, so none of the arithmetic here is asserted
   *  through the DOM -- nearBottom and restoredScrollTop above carry the
   *  tests, and this effect is the (deliberately dull) wiring between them
   *  and a real element. */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null || page === null) return;

    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      pendingRestoreRef.current = null;
      el.scrollTop = restoredScrollTop(pending.scrollTop, pending.scrollHeight, el.scrollHeight);
      return;
    }

    if (!landedRef.current) {
      landedRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastTurnKeyRef.current = lastTurnKey(page.turns);
      return;
    }

    const key = lastTurnKey(page.turns);
    const grewAtBottom = key !== null && key !== lastTurnKeyRef.current;
    lastTurnKeyRef.current = key;
    if (!grewAtBottom) return;
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
    else setMissedLatest(true);
  }, [page]);
```

Add above the component (just after `restoredScrollTop`):

```ts
/** Identity of the newest turn, including its length. A prepend never
 *  changes it; a brand-new turn does; and so does the last assistant turn
 *  growing as its reply streams, which is exactly what the sticky bottom
 *  needs to follow. */
function lastTurnKey(turns: ConversationTurn[]): string | null {
  const last = turns[turns.length - 1];
  return last ? `${last.id}:${last.text.length}` : null;
}
```

and add `ConversationTurn` to the type import on line 4:

```ts
import type { ConversationPage, ConversationStep, ConversationTurn } from '../../store/conversation.ts';
```

Replace `loadMore` and `handleScroll` (lines 175-198) with:

```tsx
  // Fetches the next OLDER page and PREPENDS it, because chat order puts
  // the oldest loaded turn at the top, so continuing the timeline further
  // back means adding on there. A prepend moves every already-rendered
  // message down by the height it added, which is the classic scroll jump
  // -- pendingRestoreRef records the pre-commit geometry so the layout
  // effect above can cancel it out exactly.
  function loadMore() {
    if (sessionId === null || nextCursor === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void window.fleet?.conversation(sessionId, nextCursor).then(next => {
      const el = scrollerRef.current;
      if (el !== null) pendingRestoreRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      setPage(current => current === null
        ? current
        : { turns: [...next.turns, ...current.turns], nextCursor: next.nextCursor });
    }).finally(() => {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    });
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const atBottom = nearBottom(e.currentTarget);
    stickyRef.current = atBottom;
    if (atBottom) setMissedLatest(false);
    if (nearOlderEdge(e.currentTarget)) loadMore();
  }

  function jumpToLatest() {
    const el = scrollerRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    stickyRef.current = true;
    setMissedLatest(false);
  }
```

- [ ] **Step 5: Give the pane one shape, whatever it is showing**

Still in `ConversationView.tsx`, delete all five early returns — the three `sessionId === null` branches (lines 146-169), the `page === null` loading return (line 171), and the `turns.length === 0` empty return (line 173) — together with the `const { turns, nextCursor } = page;` destructuring on line 172. Everything they said becomes a `body` value instead, so the pane keeps one shape in every state.

Put this immediately before the render loop's `let prevDate = '';`:

```tsx
  // One shape in every state (spec §7.1's reasoning, applied to the whole
  // pane): the scroller is always there, and what varies is what is inside
  // it. The three "we cannot identify this session" messages, the loading
  // state and the empty state used to be whole-component early returns --
  // which would have meant the message box below vanishing in exactly the
  // states a person most wants to see it.
  function note(text: string) {
    return <p className="convnote">{text}</p>;
  }
  let body: React.ReactNode;
  if (sessionId === null) {
    body = match === 'ambiguous'
      ? note(`This working directory has several recorded sessions, so the app can't tell which transcript belongs to this process.`)
      : match === 'unknown'
        ? note(`No transcript has been found for this process yet -- which is also what a session looks like right after it launches, before its first events are written and ingested.`)
        : note(`This process's transcript can't be identified.`);
  } else if (page === null) {
    body = note('Loading…');
  } else if (page.turns.length === 0) {
    body = note('No conversation recorded for this session.');
  }
```

Then re-derive what the destructuring used to supply, above `loadMore` (which reads `nextCursor`), where line 172 was:

```tsx
  const turns = page?.turns ?? [];
  const nextCursor = page?.nextCursor ?? null;
```

and replace the whole `return (...)` with:

```tsx
  let prevDate = '';
  return (
    <div className="convwrap">
      <div className="conv" data-style="a" ref={scrollerRef} onScroll={handleScroll}>
        {body ?? (
          <>
            {turns.map(t => {
              const date = formatDate(t.ts);
              const showDate = date !== prevDate;
              prevDate = date;
              return (
                <article key={t.id} className={`turn ${t.role}`}>
                  <div className="meta">
                    {t.role === 'user'
                      ? <span className="who">you</span>
                      : (
                        <span className="who">
                          <ProviderMark provider={provider} size={13} />
                          <span className="wholabel">{PROVIDER_NAME[provider]}</span>
                        </span>
                      )}
                    <span className="when">{showDate ? `${date} ${formatTime(t.ts)}` : formatTime(t.ts)}</span>
                  </div>
                  {t.role === 'user'
                    ? <p className="turn-text">{t.text}</p>
                    : (
                      <div className="turn-body">
                        <div className="turn-text md"><MarkdownText text={t.text} /></div>
                        {t.steps.length > 0 && <Steps steps={t.steps} />}
                      </div>
                    )}
                </article>
              );
            })}
            {loadingMore && <p className="conv-loading-more">Loading more…</p>}
            {!loadingMore && nextCursor === null && turns.length > 0 && (
              // A genuine end-of-history fact, not an apology -- unlike the
              // old truncation notice this replaces, nothing here is hidden;
              // older turns just have not been fetched yet, and now there
              // are none left.
              <p className="conv-end">Beginning of this session's recorded conversation.</p>
            )}
          </>
        )}
      </div>
      {missedLatest && (
        <button type="button" className="convjump" onClick={jumpToLatest}>Jump to latest</button>
      )}
    </div>
  );
```

The date-repeat loop still walks the same top-to-bottom order the reader sees, so nothing about `prevDate` changes.

- [ ] **Step 6: Style the wrapper, the note and the button**

In `src/renderer/components/ConversationView.css`, replace line 3 (`.conv.empty, .conv.loading, .conv.unknown { ... }`) with:

```css
/* The scroller and everything pinned below it (the Jump to latest button,
   and the message box) are siblings in a bounded column, so the pinned
   parts stay put while only the turns scroll. min-height:0 on both is what
   stops a long conversation from pushing the column past its parent
   instead of scrolling inside it. */
.convwrap { display:flex; flex-direction:column; flex:1; min-height:0; }
.conv { min-height:0; }
/* Whatever the pane is saying instead of turns: loading, empty, or one of
   the three "we cannot identify this session" messages. */
.convnote { margin:0; color:var(--muted); }
/* Offered only when new content landed while the reader was scrolled away
   from the bottom -- so it is never a button that would do nothing. Sits
   between the scroller and the message box, as in the mockup. */
.convjump { align-self:center; margin:6px 0 0; font-family:var(--f-mono); font-size:11px;
  color:var(--ground); background:var(--accent); border:0; border-radius:20px;
  padding:5px 14px; cursor:pointer; }
.convjump:hover { background:color-mix(in srgb,var(--accent) 85%,black); }
```

In `src/renderer/components/MainPane.css`, replace line 13 with:

```css
/* min-height:0 so .convwrap's own bounded column resolves against
   something: without it a flex child's implicit min-height:auto lets the
   conversation grow the pane instead of scrolling inside it. */
.pane { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; order:1; }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx tests/renderer/ConversationView.css.test.ts tests/renderer/MainPane.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/components/ConversationView.tsx src/renderer/components/ConversationView.css src/renderer/components/MainPane.css tests/renderer/ConversationView.test.tsx
git commit -m "feat(conversation): land at the bottom, load older upward without jumping"
```

---

### Task 3: New messages appear while the pane is open

**Files:**
- Modify: `src/renderer/components/ConversationView.tsx` (the `events` prop, the merge, the refetch effect)
- Modify: `src/renderer/components/MainPane.tsx` (passes `events`)
- Test: `tests/renderer/ConversationView.test.tsx`, `tests/renderer/MainPane.test.tsx`

**Interfaces:**
- Consumes (Task 2): `ConversationView({ sessionId, match, provider })`; `OpenSession.events: number | null` (`src/fleet/state.ts:567`), already carried on every `fleet:update` push.
- Produces:
  - `mergeNewest(current: ConversationTurn[], incoming: ConversationTurn[]): ConversationTurn[]`, exported from `ConversationView.tsx`.
  - `ConversationView({ sessionId, match, provider, events })` — `events: number | null` is new and required.

No new IPC channel. `events` is a per-session monotonic count that already changes on exactly the transitions that matter, the push is already coalesced at 250ms for watcher writes, and this keeps conversation data on the request/response path where the cursor logic lives. A refetch is one keyset query for 50 exchanges, the same query the pane already runs on open (measured at most 6.6ms on the busiest real session during part 1). If that ever proves too heavy, the fallback is a `since` cursor on `session:conversation`, not a new channel.

- [ ] **Step 1: Write the failing tests**

In `tests/renderer/ConversationView.test.tsx`, add `mergeNewest` to the import on line 3, add `events: null` to the helper's defaults:

```tsx
function renderConv(props: Partial<React.ComponentProps<typeof ConversationView>> = {}) {
  return render(<ConversationView sessionId="s1" provider="claude" events={null} {...props} />);
}
```

Every existing call in the file goes through that helper, so nothing else needs touching here.

Append two new describes at the end of the file:

```tsx
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
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    rerender(<ConversationView sessionId="s1" provider="claude" events={13} />);
    await waitFor(() => expect(screen.getByText('arrived while you watched')).toBeTruthy());
    // The refetch takes NO cursor -- it is the newest page, not a page walk.
    expect(calls).toEqual([['s1', undefined], ['s1', undefined]]);
  });

  it('does not refetch on the very first render, which the mount fetch already covered', async () => {
    const calls = fleetReturning([first]);
    const { container } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    expect(calls).toHaveLength(1);
  });

  it('does not refetch when the events count is unchanged', async () => {
    const calls = fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    rerender(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it('does not refetch for a session whose events count is unknown', async () => {
    const calls = fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={null} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    rerender(<ConversationView sessionId="s1" provider="claude" events={null} />);
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
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(2));

    rerender(<ConversationView sessionId="s1" provider="claude" events={13} />);
    await waitFor(() => expect(screen.getByText('arrived while you watched')).toBeTruthy());

    // Scrolling to the top again pages from the OLDER cursor the prepend
    // established, not from the newest page's cursor the refetch carried.
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await waitFor(() => expect(calls.at(-1)).toEqual(['s1', olderCursor]));
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
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));
    rerender(<ConversationView sessionId="s1" provider="claude" events={13} />);
    await waitFor(() => expect(screen.getByText('arrived while you watched')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });

  it('stays put and offers Jump to latest when the reader has scrolled up', async () => {
    fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 100 } }); // 3400px from the bottom

    rerender(<ConversationView sessionId="s1" provider="claude" events={13} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy());
    // The view did not move itself.
    expect(scroller.scrollTop).toBe(100);
  });

  it('clears Jump to latest once the reader is back at the bottom', async () => {
    fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 100 } });
    rerender(<ConversationView sessionId="s1" provider="claude" events={13} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy());

    fireEvent.scroll(scroller, { target: { scrollTop: 3500 } }); // at the bottom
    await waitFor(() => expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull());
  });

  it('jumps to the newest message when the button is pressed, and hides itself', async () => {
    fleetReturning([first, second]);
    const { container, rerender } = render(<ConversationView sessionId="s1" provider="claude" events={12} />);
    await waitFor(() => expect(container.querySelectorAll('.turn')).toHaveLength(1));

    const scroller = container.querySelector('.conv')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.scroll(scroller, { target: { scrollTop: 100 } });
    rerender(<ConversationView sessionId="s1" provider="claude" events={13} />);

    const jump = await screen.findByRole('button', { name: /jump to latest/i });
    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(4000);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });
});
```

In `tests/renderer/MainPane.test.tsx`, add:

```tsx
  // Live updates (spec §3.3): the pane refetches on the one signal the app
  // already pushes. MainPane is the only component that holds it.
  it('hands the conversation the session\'s events count, so the pane can refresh itself', async () => {
    const api = (window as unknown as { fleet: { conversation: ReturnType<typeof vi.fn> } }).fleet;
    api.conversation = vi.fn()
      .mockResolvedValueOnce({ turns: [], nextCursor: null })
      .mockResolvedValue({
        turns: [{ id: 9, ts: '2026-09-12T10:00:00Z', role: 'assistant', text: 'live', steps: [] }],
        nextCursor: null,
      });
    const bumped = [{ ...(sessions[0] as object), events: 2 }] as never[];
    const { rerender } = render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    await waitFor(() => expect(api.conversation).toHaveBeenCalledTimes(1));
    rerender(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={bumped} onSelect={() => {}} onSetView={() => {}} onClear={() => {}} railSide="left" />);
    await waitFor(() => expect(screen.getByText('live')).toBeTruthy());
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx tests/renderer/MainPane.test.tsx`

Expected: FAIL. `ConversationView.test.tsx` does not load: `The requested module ... does not provide an export named 'mergeNewest'`.

- [ ] **Step 3: Add the merge**

In `src/renderer/components/ConversationView.tsx`, add just after `lastTurnKey`:

```ts
/** Folds a freshly-fetched NEWEST page into the turns already loaded.
 *
 *  Two rules, and they are different on purpose:
 *  - a turn whose id is already loaded is REPLACED in place, because the
 *    last assistant turn grows as its reply streams and keeps its row id;
 *  - anything genuinely new is appended at the bottom, in the incoming
 *    page's own (oldest-first) order.
 *
 *  Older pages the reader deliberately loaded sit above the newest page and
 *  are simply absent from it -- so they are carried through untouched
 *  rather than being treated as turns the server has forgotten. */
export function mergeNewest(current: ConversationTurn[], incoming: ConversationTurn[]): ConversationTurn[] {
  if (incoming.length === 0) return current;
  const byId = new Map(incoming.map(t => [t.id, t]));
  const merged = current.map(t => byId.get(t.id) ?? t);
  const seen = new Set(current.map(t => t.id));
  for (const t of incoming) if (!seen.has(t.id)) merged.push(t);
  return merged;
}
```

- [ ] **Step 4: Refetch when the count changes**

In `ConversationView.tsx`, add `events` to the signature:

```tsx
export function ConversationView({ sessionId, match, provider, events }: {
  sessionId: string | null;
  match?: MatchQuality;
  /** Which CLI this session is, so the agent's meta line carries that
   *  provider's own mark. MainPane always knows it (OpenSession.provider
   *  comes straight from the pgrep that found the process). */
  provider: Provider;
  /** The matched session's monotonic event count, straight off the
   *  fleet:update push MainPane already receives. Null when this process
   *  matches no session uniquely -- there is nothing to refresh then. */
  events: number | null;
}) {
```

Add a ref alongside the others:

```tsx
  /** The events count this pane has already fetched for. Starts unset per
   *  session so the very first value is recorded, not acted on: the mount
   *  fetch has already covered it. */
  const seenEventsRef = useRef<number | null>(null);
```

Reset it in the session effect, next to `landedRef.current = false;`:

```tsx
    seenEventsRef.current = null;
```

Add this effect immediately after the session effect:

```tsx
  /** Live updates (spec §3.3). No conversation data is pushed today --
   *  fleet:update carries open-session cards only -- but `events` on those
   *  cards is a per-session monotonic count that changes on exactly the
   *  transitions that matter. When it moves, fetch the NEWEST page (no
   *  cursor) and merge; pages the reader loaded above stay put, and so does
   *  the cursor they are paging from, which must not be replaced by the
   *  newest page's own or the next "load older" would walk history the
   *  reader already has. */
  useEffect(() => {
    if (sessionId === null || events === null) return;
    if (seenEventsRef.current === null) { seenEventsRef.current = events; return; }
    if (seenEventsRef.current === events) return;
    seenEventsRef.current = events;
    let alive = true;
    void window.fleet?.conversation(sessionId).then(next => {
      if (!alive) return;
      setPage(current => current === null
        ? current
        : { turns: mergeNewest(current.turns, next.turns), nextCursor: current.nextCursor });
    });
    return () => { alive = false; };
  }, [sessionId, events]);
```

- [ ] **Step 5: Thread it from MainPane**

In `src/renderer/components/MainPane.tsx`, extend the `ConversationView` element:

```tsx
          : <ConversationView sessionId={session?.sessionId ?? null} match={session?.match}
              provider={session?.provider ?? 'claude'}
              // The refresh signal (spec §3.3). Null whenever this process
              // matches no session uniquely -- there is nothing to refresh.
              events={session?.events ?? null} />}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx tests/renderer/MainPane.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/ConversationView.tsx src/renderer/components/MainPane.tsx tests/renderer/ConversationView.test.tsx tests/renderer/MainPane.test.tsx
git commit -m "feat(conversation): refresh the open pane from the fleet's own event count"
```

---

### Task 4: The message box, and multi-line as a bracketed paste

**Files:**
- Modify: `src/main/outbound.ts:10-30`
- Modify: `src/main/tmux.ts:3-16` (`TmuxExec`, `defaultExec`), append `loadBuffer`/`pasteBuffer`
- Modify: `src/main/ipc.ts:1-30` (imports), `:706-755` (`sendKeysFor`)
- Modify: `src/renderer/components/ReplyPopover.tsx:10` (export `REFUSAL_TEXT`)
- Modify: `src/renderer/components/ConversationView.tsx` (the box), `.css` (its chrome)
- Modify: `src/renderer/components/MainPane.tsx` (passes `pid`, `tmux`, `onOpenTerminal`)
- Test: `tests/main/outbound.test.ts`, `tests/main/tmux.test.ts`, `tests/main/ipc.test.ts`, `tests/renderer/ConversationView.test.tsx`, `tests/renderer/MainPane.test.tsx`

**Interfaces:**
- Consumes (Task 3): `ConversationView({ sessionId, match, provider, events })`; `sendKeysFor` and its `KeysResult`/`KeysRefusalReason` (`src/main/ipc.ts:706-707`); `window.fleet.sendKeys(pid, text)`.
- Produces:
  - `sanitizeOutbound(raw: unknown, opts?: { multiline?: boolean }): OutboundResult` — strict by default, unchanged for every existing caller.
  - `TmuxExec = (args: string[], input?: string) => TmuxResult`
  - `TMUX_BUFFER: RegExp`, `loadBuffer(name: string, buffer: string, text: string, exec?: TmuxExec): TmuxResult`, `pasteBuffer(name: string, buffer: string, exec?: TmuxExec): TmuxResult`
  - `REFUSAL_TEXT: Record<KeysRefusalReason, string>` exported from `ReplyPopover.tsx`
  - `ConversationView({ sessionId, match, provider, events, pid, tmux, onOpenTerminal })`

**The rail's Answer popover stays exactly as it is** (spec §7.3, David's own ruling): it answers a session he is not currently looking at, which the conversation's own box cannot do. This task exports that component's refusal wording and changes nothing else about it.

**The security argument, unchanged from the spec §5:** no new trust boundary. The box reuses `session:keys`, which already validates the pid, sanitises the text and refuses a session that is not tmux-backed or has a choice open. The 4,000 character cap and control-character stripping apply before the text reaches `load-buffer`. The buffer name is chosen by this code and checked against an anchored pattern, never derived from the text, and the buffer is deleted as it is pasted (`-d`). Bracketed paste executes nothing: it delivers text to the foreground program, which is exactly why the newline refusal can be relaxed on that path and only that path.

- [ ] **Step 1: Write the failing main-process tests**

In `tests/main/outbound.test.ts`, append inside the existing describe:

```ts
  // The refusal above is load-bearing for the KEYSTROKE path and stays the
  // default: `send-keys -l` types the text, and a newline submits early, so
  // a two-line message would send its first line and run the rest as a
  // second prompt. The allowance below exists for one caller -- the
  // bracketed-paste path in sendKeysFor -- and is opt-in, so no existing
  // call site changes behaviour.
  it('allows newlines only when the caller opts in', () => {
    expect(sanitizeOutbound('line one\nline two')).toEqual({ ok: false, reason: 'contains_newline' });
    expect(sanitizeOutbound('line one\nline two', { multiline: true }))
      .toEqual({ ok: true, text: 'line one\nline two' });
  });

  it('normalises CRLF and CR to LF on the multiline path, so one convention reaches tmux', () => {
    expect(sanitizeOutbound('a\r\nb\rc', { multiline: true })).toEqual({ ok: true, text: 'a\nb\nc' });
  });

  it('still strips every other control character on the multiline path', () => {
    expect(sanitizeOutbound('a\x1bb\nc\x03d', { multiline: true })).toEqual({ ok: true, text: 'ab\ncd' });
  });

  it('still caps the multiline path at MAX_REPLY_CHARS', () => {
    const long = `${'x'.repeat(MAX_REPLY_CHARS)}\ny`;
    expect(sanitizeOutbound(long, { multiline: true })).toEqual({ ok: false, reason: 'too_long' });
  });

  it('refuses a multiline message that is nothing but line breaks', () => {
    expect(sanitizeOutbound('\n\n\n', { multiline: true })).toEqual({ ok: false, reason: 'empty' });
  });
```

In `tests/main/tmux.test.ts`, append:

```ts
describe('bracketed paste', () => {
  it('loads the text on stdin, never in an argv a ps on this machine could read', () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const exec = (args: string[], input?: string) => { calls.push({ args, input }); return { ok: true as const, stdout: '' }; };
    expect(loadBuffer('llmws-claude-abc', 'llmws-paste', 'line one\nline two', exec).ok).toBe(true);
    expect(calls[0]!.args).toEqual(['load-buffer', '-b', 'llmws-paste', '-']);
    expect(calls[0]!.input).toBe('line one\nline two');
    expect(calls[0]!.args.join(' ')).not.toContain('line one');
  });

  it('pastes with -p (bracketed) and -d (delete the buffer), at this session\'s pane', () => {
    const calls: string[][] = [];
    const exec = (args: string[]) => { calls.push(args); return { ok: true as const, stdout: '' }; };
    expect(pasteBuffer('llmws-claude-abc', 'llmws-paste', exec).ok).toBe(true);
    expect(calls[0]).toEqual(['paste-buffer', '-p', '-d', '-b', 'llmws-paste', '-t', '=llmws-claude-abc:']);
  });

  it('refuses a session name this app did not generate, same guard as every other command here', () => {
    expect(() => loadBuffer('someone-elses', 'llmws-paste', 'x')).toThrow(/refusing a tmux name/);
    expect(() => pasteBuffer('someone-elses', 'llmws-paste')).toThrow(/refusing a tmux name/);
  });

  // The buffer name reaches tmux's own target grammar, so it gets the same
  // treatment the session name does: anchored, and app-generated. Nothing
  // derived from the message text may ever get there.
  it('refuses a buffer name this app did not generate', () => {
    expect(() => loadBuffer('llmws-claude-abc', 'default', 'x')).toThrow(/refusing a tmux buffer name/);
    expect(() => pasteBuffer('llmws-claude-abc', '../x', )).toThrow(/refusing a tmux buffer name/);
    expect(TMUX_BUFFER.test('llmws-paste')).toBe(true);
    expect(TMUX_BUFFER.test('llmws-paste; rm -rf ~')).toBe(false);
  });
});
```

Add `loadBuffer, pasteBuffer, TMUX_BUFFER` to that file's import from `'../../src/main/tmux.ts'`.

In `tests/main/ipc.test.ts`, replace the "refuses multi-line text before it reaches tmux" test (line 928) with:

```ts
  // Multi-line is delivered as a BRACKETED PASTE, not as keystrokes
  // (measured 2026-09-15: Claude Code receives a bracketed paste as one
  // message and does not submit on the embedded newlines). Three calls, in
  // this order, and send-keys -l is never one of them.
  it('delivers multi-line text as a bracketed paste, never as send-keys -l', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: Array<{ args: string[]; input?: string }> = [];
    const r = sendKeysFor(4821, 'line one\nline two', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[], input?: string) => { calls.push({ args, input }); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'sent' });
    expect(calls.map(c => c.args)).toEqual([
      ['load-buffer', '-b', 'llmws-paste', '-'],
      ['paste-buffer', '-p', '-d', '-b', 'llmws-paste', '-t', '=llmws-claude-abc:'],
      ['send-keys', '-t', '=llmws-claude-abc:', 'Enter'],
    ]);
    expect(calls[0]!.input).toBe('line one\nline two');
    // The keystroke path never sees a newline. This is the assertion that
    // keeps the relaxation confined to the paste path.
    for (const c of calls) {
      if (c.args.includes('-l')) expect(c.args.at(-1)).not.toMatch(/\n/);
    }
  });

  it('keeps single-line text on the unchanged send-keys -l path, with no buffer involved', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = sendKeysFor(4821, 'yes', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'sent' });
    expect(calls).toEqual([
      ['send-keys', '-t', '=llmws-claude-abc:', '-l', 'yes'],
      ['send-keys', '-t', '=llmws-claude-abc:', 'Enter'],
    ]);
  });

  it('refuses, and sends no Enter, when the buffer cannot be loaded', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = sendKeysFor(4821, 'a\nb', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[]) => {
        calls.push(args);
        return args[0] === 'load-buffer' ? { ok: false, error: 'no server' } : { ok: true, stdout: '' };
      },
    });
    expect(r).toEqual({ status: 'refused', reason: 'session_gone' });
    expect(calls).toEqual([['load-buffer', '-b', 'llmws-paste', '-']]);
  });

  // The choice guard is not path-specific: a multi-line message must be
  // refused while a picker is open exactly as a single-line one is.
  it('still refuses a multi-line message with prompt_open, and touches no buffer', () => {
    registerSession(4821, 'llmws-claude-abc');
    let called = false;
    const r = sendKeysFor(4821, 'a\nb', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: () => { called = true; return { ok: true, stdout: '' }; },
      promptOpen: () => true,
    });
    expect(r).toEqual({ status: 'refused', reason: 'prompt_open' });
    expect(called).toBe(false);
  });
```

- [ ] **Step 2: Run the main-process tests to verify they fail**

Run: `npx vitest run tests/main/outbound.test.ts tests/main/tmux.test.ts tests/main/ipc.test.ts`

Expected: FAIL. `tmux.test.ts` does not load (`does not provide an export named 'loadBuffer'`). `outbound.test.ts` fails on `expected { ok: false, reason: 'contains_newline' } to deeply equal { ok: true, text: 'line one\nline two' }`. `ipc.test.ts` fails on `expected { status: 'refused', reason: 'contains_newline' } to deeply equal { status: 'sent' }`.

- [ ] **Step 3: Add the opt-in multiline allowance**

Replace `src/main/outbound.ts:20-30` with:

```ts
/** A newline typed into a pane submits the current line, so multi-line text
 *  typed with `send-keys -l` becomes several submissions -- a way to smuggle
 *  a second message past what the UI showed as one reply. That is why the
 *  default here refuses rather than silently collapsing, and it stays the
 *  default.
 *
 *  `multiline` is the one opt-in, used by exactly one caller: sendKeysFor's
 *  bracketed-paste path (src/main/ipc.ts), which does not type the text at
 *  all -- tmux loads it into a buffer and pastes it, and the foreground
 *  program is told it is pasted text, so the embedded newlines do not
 *  submit (measured 2026-09-15). Every other rule is identical on both
 *  paths: non-empty, the 4,000 character cap, and control-character
 *  stripping, all applied before the text reaches tmux. */
export function sanitizeOutbound(raw: unknown, opts: { multiline?: boolean } = {}): OutboundResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  if (!opts.multiline && NEWLINE.test(raw)) return { ok: false, reason: 'contains_newline' };
  if (raw.length > MAX_REPLY_CHARS) return { ok: false, reason: 'too_long' };
  const stripped = raw.replace(C0_EXCEPT_TAB_NEWLINE, '').replace(C1_CONTROLS, '');
  // One newline convention reaches tmux: a pasted CRLF would otherwise
  // arrive as a stray carriage return inside the buffer.
  const text = opts.multiline ? stripped.replace(/\r\n?/g, '\n') : stripped;
  // A message that is nothing but line breaks has nothing to deliver. On
  // the single-line path this is just the length check it always was.
  if ((opts.multiline ? text.replace(/\n/g, '') : text).length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, text };
}
```

- [ ] **Step 4: Add the two tmux primitives**

In `src/main/tmux.ts`, replace lines 4 and 10-16 with:

```ts
/** `input`, when given, is written to the command's stdin. Only load-buffer
 *  uses it, and it is the reason the message text never appears in an argv:
 *  argv is world-readable through `ps` for as long as the process lives. */
export type TmuxExec = (args: string[], input?: string) => TmuxResult;
```
```ts
function defaultExec(args: string[], input?: string): TmuxResult {
  try {
    return {
      ok: true,
      stdout: execFileSync('tmux', args, {
        timeout: 5000, ...(input === undefined ? {} : { input }),
      }).toString(),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'tmux failed' };
  }
}
```

Add after `TMUX_NAME` (line 8):

```ts
/** Buffer names this app may touch. A buffer name reaches tmux's own target
 *  grammar the same way a session name does, so it gets the same treatment:
 *  anchored, and only ever a literal this code chose -- never anything
 *  derived from the message text. */
export const TMUX_BUFFER = /^llmws-[a-z]{1,16}$/;
```

Add after `guard` (line 37):

```ts
function guardBuffer(buffer: string): void {
  if (!TMUX_BUFFER.test(buffer)) throw new Error('refusing a tmux buffer name this app did not generate');
}
```

Append at the end of the file:

```ts
/** Reads `text` into a private tmux buffer from STDIN, so a multi-line
 *  message never appears in an argv. Paired with pasteBuffer below, which
 *  is what actually delivers it -- loading a buffer on its own sends
 *  nothing anywhere. */
export function loadBuffer(name: string, buffer: string, text: string, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  guardBuffer(buffer);
  return exec(['load-buffer', '-b', buffer, '-'], text);
}

/** Delivers a buffer to the pane as a BRACKETED paste (-p) and deletes the
 *  buffer as it goes (-d).
 *
 *  Bracketed paste is the whole mechanism: the foreground program is told
 *  "this is pasted text", so Claude Code takes the embedded newlines as
 *  part of one message instead of submitting on each of them the way it
 *  would for typed ones (measured 2026-09-15). It executes nothing -- it is
 *  delivery, not interpretation -- which is why it is the one path where
 *  the outbound sanitiser's newline refusal can be relaxed. */
export function pasteBuffer(name: string, buffer: string, exec: TmuxExec = defaultExec): TmuxResult {
  guard(name);
  guardBuffer(buffer);
  return exec(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target(name)]);
}
```

- [ ] **Step 5: Branch `sendKeysFor` on the newline**

In `src/main/ipc.ts`, change the existing `'./tmux.ts'` import (line 24) to:

```ts
import {
  sendLiteral, sendKeyName, capturePane, setSessionOption, loadBuffer, pasteBuffer,
  type TmuxResult, type TmuxExec,
} from './tmux.ts';
```

and add above `sendKeysFor`:

```ts
/** The one buffer this app ever writes. A fixed literal, checked by
 *  tmux.ts's own TMUX_BUFFER before it becomes a tmux target -- never
 *  derived from the message, never per-session (each paste deletes the
 *  buffer as it lands, so there is nothing to collide over). */
const PASTE_BUFFER = 'llmws-paste';
```

Replace `KeysDeps.send`'s type (line 711) with:

```ts
  /** The tmux exec for every outbound call this function makes -- the
   *  keystroke pair AND the three-call paste path -- so a test captures all
   *  of them, in order, through one mock. Widened to TmuxExec because
   *  load-buffer takes its text on stdin; a mock written as
   *  `(args: string[]) => TmuxResult` is still assignable, so every existing
   *  test keeps compiling unchanged. */
  send?: TmuxExec;
```

Replace the sanitise line (line 725) and the send block (lines 744-754) with:

```ts
  // Sanitise BEFORE resolving, so malformed text never reaches tmux even
  // momentarily, and the cheap check runs first. Multi-line is allowed
  // here, but ONLY because the branch below routes it to a bracketed paste
  // -- the keystroke path never sees a newline (see the send block).
  const clean = sanitizeOutbound(raw, { multiline: true });
```
```ts
  // The session name resolving is not proof the pane is still there to
  // receive anything -- re-check the pane itself, immediately before
  // sending, rather than trusting a name that was live a moment ago.
  const captured = capturePane(name, 1, deps.capture);
  if (!captured.ok) return { status: 'refused', reason: 'session_gone' };

  if (clean.text.includes('\n')) {
    // Bracketed paste (spec 2026-09-15-conversation-pane-design.md §3.4).
    // Three calls, never concatenated: load the text into our own buffer,
    // paste it as bracketed text and delete the buffer in the same command,
    // then send Enter as a key name our code chose. A failed load or paste
    // refuses BEFORE any Enter goes out, so a half-delivered message is
    // never submitted.
    const loaded = loadBuffer(name, PASTE_BUFFER, clean.text, deps.send);
    if (!loaded.ok) return { status: 'refused', reason: 'session_gone' };
    const pasted = pasteBuffer(name, PASTE_BUFFER, deps.send);
    if (!pasted.ok) return { status: 'refused', reason: 'session_gone' };
    sendKeyName(name, 'Enter', deps.send);
    return { status: 'sent' };
  }

  // Two calls, always. Text with -l; Enter as a key name our code chose.
  // Concatenating them would let a reply of "Enter" become a keypress.
  // Reached only when the text has no newline at all, which is exactly what
  // the strict sanitiser would have required of it.
  sendLiteral(name, clean.text, deps.send);
  sendKeyName(name, 'Enter', deps.send);
  return { status: 'sent' };
```

- [ ] **Step 6: Run the main-process tests to verify they pass**

Run: `npx vitest run tests/main/outbound.test.ts tests/main/tmux.test.ts tests/main/ipc.test.ts tests/main/launch.test.ts tests/main/sessions.test.ts`
Expected: PASS, all tests. The last two are included because they also drive `TmuxExec` mocks, and widening that type must not have broken them.

- [ ] **Step 7: Write the failing renderer tests**

In `tests/renderer/ConversationView.test.tsx`, extend the helper's defaults once more:

```tsx
function renderConv(props: Partial<React.ComponentProps<typeof ConversationView>> = {}) {
  return render(
    <ConversationView sessionId="s1" provider="claude" events={null}
      pid={4821} tmux={true} onOpenTerminal={() => {}} {...props} />,
  );
}
```

and add `pid={4821} tmux={true} onOpenTerminal={() => {}}` to every bare `render(` / `rerender(` of `ConversationView` still left in the file — all of them are in the live-refresh describe Task 3 added, which drives `events` directly and so cannot go through the helper.

Append:

```tsx
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
```

Add `vi` to the vitest import on line 1.

In `tests/renderer/MainPane.test.tsx`, add:

```tsx
  it('lets the conversation message its own session, and routes a choice to the terminal', async () => {
    const api = (window as unknown as { fleet: Record<string, ReturnType<typeof vi.fn>> }).fleet;
    api.sendKeys = vi.fn().mockResolvedValue({ status: 'refused', reason: 'prompt_open' });
    const onSetView = vi.fn();
    render(<MainPane selection={{ pid: 1, view: 'conversation' }} sessions={sessions} onSelect={() => {}} onSetView={onSetView} onClear={() => {}} railSide="left" />);
    const box = await screen.findByLabelText('Message this session');
    fireEvent.change(box, { target: { value: 'go' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.sendKeys).toHaveBeenCalledWith(1, 'go'));
    fireEvent.click(screen.getByRole('button', { name: /^open terminal$/i }));
    expect(onSetView).toHaveBeenCalledWith('terminal');
  });
```

The fixture at line 9 has no `tmux` field, so add `tmux: true` to it.

- [ ] **Step 8: Run the renderer tests to verify they fail**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx tests/renderer/MainPane.test.tsx`
Expected: FAIL. `Unable to find a label with the text of: Message this session`.

- [ ] **Step 9: Export the popover's refusal wording**

In `src/renderer/components/ReplyPopover.tsx`, change line 10 to:

```ts
/** One message per refusal reason. Exported so the conversation's own
 *  message box says the same thing this popover does rather than keeping a
 *  second, drifting copy -- these strings were settled against a real
 *  misfire during part 1 and are not casual wording. */
export const REFUSAL_TEXT: Record<KeysRefusalReason, string> = {
```

`contains_newline` keeps its entry. It is no longer reachable from `sendKeysFor` (multi-line now takes the paste path), but it is still part of `OutboundRefusal` and therefore of `KeysRefusalReason`, and this map is exhaustive by design so a future reason is a compile error rather than an `undefined`.

- [ ] **Step 10: Add the box**

In `src/renderer/components/ConversationView.tsx`, add to the imports:

```ts
import type { KeysResult } from '../../main/ipc.ts';
import { REFUSAL_TEXT } from './ReplyPopover.tsx';
```

`KeysResult` is a **type-only** import from main. A value import there would blank the window.

Add above `ConversationView`:

```tsx
/** The message box under the conversation (spec §3.4). Never hidden, only
 *  ever disabled with a reason: a box that vanishes reads as a missing
 *  feature, a disabled one reads as a state (spec §7.1, David's own
 *  ruling).
 *
 *  Sends through the same session:keys channel the rail's popover uses, so
 *  every guard part 1 established still applies -- including the one that
 *  matters most: this box does not answer choices. A typed reply to a
 *  picker is ignored and Enter selects whatever option is highlighted
 *  (measured 2026-09-15, "blue" recorded as "Red"), so a prompt_open
 *  refusal offers the Terminal view instead of a retry. */
function MessageBox({ pid, tmux, onOpenTerminal }: {
  pid: number | null;
  tmux: boolean;
  onOpenTerminal: () => void;
}) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const disabledReason = pid === null
    ? 'This session is not running.'
    : !tmux ? REFUSAL_TEXT.not_tmux : null;

  async function send(): Promise<void> {
    if (pid === null || text.trim() === '' || sending) return;
    setSending(true);
    setMessage(null);
    setChoiceOpen(false);
    try {
      const r: KeysResult | undefined = await window.fleet?.sendKeys(pid, text);
      if (r?.status === 'sent') { setText(''); return; }
      // The text is deliberately KEPT on a refusal: the person can fix
      // whatever was wrong (answer the choice, reattach) and press Enter
      // again, rather than retyping what they already wrote.
      setMessage(r ? REFUSAL_TEXT[r.reason] : 'Could not reach the app.');
      setChoiceOpen(r?.status === 'refused' && r.reason === 'prompt_open');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="convbox">
      <textarea
        className="convinput"
        aria-label="Message this session"
        rows={2}
        value={text}
        disabled={disabledReason !== null || sending}
        placeholder={disabledReason ?? 'Message this session'}
        onChange={e => setText(e.target.value)}
        // Enter sends, with no confirmation, however long the message
        // (spec §7.2). Shift+Enter is the line break, which is what makes
        // a multi-line message typeable at all.
        onKeyDown={e => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          void send();
        }}
      />
      {disabledReason !== null && <p className="convmsg">{disabledReason}</p>}
      {message !== null && (
        <p className="convmsg" role="status">
          {message}
          {choiceOpen && tmux && (
            <button type="button" className="convsend" onClick={onOpenTerminal}>Open Terminal</button>
          )}
        </p>
      )}
    </div>
  );
}
```

Extend the component signature:

```tsx
export function ConversationView({ sessionId, match, provider, events, pid, tmux, onOpenTerminal }: {
  sessionId: string | null;
  match?: MatchQuality;
  provider: Provider;
  events: number | null;
  /** The live process behind this pane, or null when the selected pid has
   *  left the fleet. Null is what disables the box with "This session is
   *  not running." rather than removing it. */
  pid: number | null;
  /** Whether that process is tmux-backed. Only a tmux-backed session can be
   *  typed into at all (src/main/ipc.ts's sendKeysFor refuses not_tmux). */
  tmux: boolean;
  /** Switches the pane to the Terminal view -- the only way to answer a
   *  choice, which this box deliberately cannot do. */
  onOpenTerminal: () => void;
}) {
```

and render the box as the last child of `.convwrap`, below the Jump to latest button:

```tsx
      {missedLatest && (
        <button type="button" className="convjump" onClick={jumpToLatest}>Jump to latest</button>
      )}
      <MessageBox pid={pid} tmux={tmux} onOpenTerminal={onOpenTerminal} />
    </div>
  );
```

- [ ] **Step 11: Style it**

Append to `src/renderer/components/ConversationView.css`:

```css
/* The message box, pinned under the scroller rather than inside it, so it
   stays put while the conversation moves. Fixed at the app's own body size
   rather than --conv-size: this is a control, not part of the transcript,
   and it should not resize when the reading size does. */
.convbox { flex:none; border-top:1px solid var(--line); padding:10px 18px 12px;
  background:var(--surface); }
.convinput { display:block; width:100%; resize:vertical; min-height:44px; max-height:30vh;
  font-family:var(--f-body); font-size:13px; line-height:1.5; color:var(--ink);
  background:var(--ground); border:1px solid var(--line); border-radius:var(--r-sm);
  padding:8px 10px; }
.convinput:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.convinput:disabled { color:var(--muted); cursor:default; }
.convmsg { margin:6px 0 0; font-size:11px; color:var(--muted); }
.convsend { margin-left:8px; font-family:var(--f-mono); font-size:11px; color:var(--accent);
  background:none; border:1px solid var(--line); border-radius:20px; padding:3px 10px; cursor:pointer; }
.convsend:hover { border-color:color-mix(in srgb,var(--accent) 40%,transparent); }
```

- [ ] **Step 12: Thread pid, tmux and the terminal switch from MainPane**

In `src/renderer/components/MainPane.tsx`, extend the `ConversationView` element:

```tsx
          : <ConversationView sessionId={session?.sessionId ?? null} match={session?.match}
              provider={session?.provider ?? 'claude'}
              events={session?.events ?? null}
              // null once the selected pid has left the fleet -- the box is
              // then disabled with a reason rather than removed (spec §7.1).
              pid={session ? selection.pid : null}
              tmux={session?.tmux ?? false}
              // The pid is already the selection, so this only has to flip
              // the view -- unlike the rail's Answer, which must select
              // first (see onOpenTerminal on SessionRail above).
              onOpenTerminal={() => onSetView('terminal')} />}
```

- [ ] **Step 13: Run the renderer tests to verify they pass**

Run: `npx vitest run tests/renderer/ConversationView.test.tsx tests/renderer/MainPane.test.tsx tests/renderer/ReplyPopover.test.tsx tests/renderer/ConversationView.css.test.ts`
Expected: PASS, all tests. `ReplyPopover.test.tsx` is included because that file's refusal map just became an export; nothing about its behaviour changed. `ConversationView.css.test.ts` confirms the new `conv*` classes still share no name with either card stylesheet.

- [ ] **Step 14: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 15: Commit**

```bash
git add src/main/outbound.ts src/main/tmux.ts src/main/ipc.ts src/renderer/components/ReplyPopover.tsx src/renderer/components/ConversationView.tsx src/renderer/components/ConversationView.css src/renderer/components/MainPane.tsx tests/main/outbound.test.ts tests/main/tmux.test.ts tests/main/ipc.test.ts tests/renderer/ConversationView.test.tsx tests/renderer/MainPane.test.tsx
git commit -m "feat(conversation): a message box that sends multi-line text as a bracketed paste"
```

---

### Task 5: The settings store, and the modal behind a gear

**Files:**
- Create: `src/renderer/state/settings.ts`
- Create: `src/renderer/components/SettingsModal.tsx`, `src/renderer/components/SettingsModal.css`
- Modify: `src/renderer/components/Icon.tsx:1-8` (the gear joins the icon set)
- Modify: `src/renderer/components/LaunchBar.tsx:52-70` (the gear), `LaunchBar.css` (its styling, and the dialog's no-drag)
- Modify: `src/renderer/components/ConversationView.tsx` (size and style come from the store)
- Test: `tests/renderer/settings.test.ts` (create), `tests/renderer/SettingsModal.test.tsx` (create), `tests/renderer/Icon.test.tsx`, `tests/renderer/LaunchBar.test.tsx`, `tests/renderer/ConversationView.test.tsx`

**Interfaces:**
- Consumes (Task 4): `ConversationView` as it now stands; `LaunchBar({ onLaunched })`.
- Produces, from `src/renderer/state/settings.ts`:
  - `type Appearance = 'system' | 'light' | 'dark'`
  - `type TextSize = 14 | 15 | 16 | 17`
  - `type MessageStyle = 'a' | 'c'`
  - `type CompactCards = 'off' | 'sidebar' | 'fleet' | 'both'`
  - `type Settings = { appearance: Appearance; textSize: TextSize; messageStyle: MessageStyle; compactCards: CompactCards }`
  - `SETTINGS_STORAGE_KEY = 'llmws:settings'`, `DEFAULT_SETTINGS: Settings`
  - `APPEARANCES`, `TEXT_SIZES`, `MESSAGE_STYLES`, `COMPACT_CARDS` — the allowed sets, as readonly arrays
  - `normalizeSettings(raw: unknown): Settings`
  - `getSettings(): Settings`, `setSettings(patch: Partial<Settings>): void`, `subscribeSettings(cb: () => void): () => void`, `useSettings(): Settings`, `reloadSettings(): void`
  - `compactIn(s: Settings, place: 'sidebar' | 'fleet'): boolean`
- Produces, from `src/renderer/components/SettingsModal.tsx`: `SettingsModal({ open, onClose }: { open: boolean; onClose: () => void })`

`compactCards` is deliberately one setting with four values rather than two booleans, so "Both on but Fleet off" cannot happen (spec §3.5).

- [ ] **Step 1: Write the failing store tests**

Create `tests/renderer/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, compactIn, getSettings, normalizeSettings,
  reloadSettings, setSettings, subscribeSettings,
} from '../../src/renderer/state/settings.ts';

beforeEach(() => {
  localStorage.clear();
  reloadSettings();
});

describe('normalizeSettings', () => {
  it('accepts a complete, valid object unchanged', () => {
    const s = { appearance: 'dark', textSize: 14, messageStyle: 'c', compactCards: 'off' };
    expect(normalizeSettings(s)).toEqual(s);
  });

  // Every value is checked against its own allowed set, with a fallback to
  // the default -- the same rule SessionRail's stored width already uses
  // (clamp, never render verbatim). A stored blob is per-viewer data this
  // code wrote, but it is still data on disk that anything could have
  // touched, so it is validated, not trusted.
  it.each([
    ['an unknown appearance', { appearance: 'sepia' }, 'appearance', 'system'],
    ['a text size outside the offered range', { textSize: 40 }, 'textSize', 16],
    ['a text size that is not a number', { textSize: '16' }, 'textSize', 16],
    ['an unknown message style', { messageStyle: 'b' }, 'messageStyle', 'a'],
    ['an unknown compact-cards value', { compactCards: 'yes' }, 'compactCards', 'both'],
  ])('falls back to the default for %s', (_label, patch, key, fallback) => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, ...patch })[key as keyof typeof DEFAULT_SETTINGS])
      .toBe(fallback);
  });

  it('fills in missing keys rather than returning a partial object', () => {
    expect(normalizeSettings({ appearance: 'light' }))
      .toEqual({ ...DEFAULT_SETTINGS, appearance: 'light' });
  });

  it.each([['null', null], ['an array', []], ['a string', 'dark'], ['a number', 3]])(
    'returns the defaults for %s', (_label, raw) => {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    });
});

describe('the settings store', () => {
  it('starts at the documented defaults with nothing stored', () => {
    expect(getSettings()).toEqual({
      appearance: 'system', textSize: 16, messageStyle: 'a', compactCards: 'both',
    });
  });

  it('reads a stored value back on reload -- the restart path', () => {
    setSettings({ textSize: 14, appearance: 'dark' });
    reloadSettings();
    expect(getSettings()).toMatchObject({ textSize: 14, appearance: 'dark' });
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject({ textSize: 14 });
  });

  it('uses one namespaced key, and never disturbs the rail\'s own', () => {
    localStorage.setItem('llmws:rail-width', '204');
    setSettings({ textSize: 17 });
    expect(localStorage.getItem('llmws:rail-width')).toBe('204');
    expect(Object.keys(localStorage).filter(k => k.startsWith('llmws:')).sort())
      .toEqual(['llmws:rail-width', 'llmws:settings']);
  });

  it('ignores a corrupt blob rather than throwing or rendering it', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    expect(() => reloadSettings()).not.toThrow();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  // localStorage throws in a locked-down or private-mode context. A UI
  // preference is never worth taking the window down over -- the same
  // reasoning as readStoredRailWidth's own try/catch.
  it('never throws when localStorage itself is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => setSettings({ textSize: 15 })).not.toThrow();
    expect(() => reloadSettings()).not.toThrow();
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('notifies subscribers on a real change, and not on a no-op write', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeSettings(cb);
    setSettings({ textSize: 15 });
    expect(cb).toHaveBeenCalledTimes(1);
    setSettings({ textSize: 15 });
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    setSettings({ textSize: 17 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('hands out a stable snapshot until something actually changes', () => {
    const before = getSettings();
    setSettings({ textSize: 16 }); // already the default
    expect(getSettings()).toBe(before);
    setSettings({ textSize: 17 });
    expect(getSettings()).not.toBe(before);
  });

  it('validates what it is given, not only what it reads back', () => {
    setSettings({ appearance: 'sepia' as never });
    expect(getSettings().appearance).toBe('system');
  });
});

describe('compactIn', () => {
  it.each([
    ['off', false, false],
    ['sidebar', true, false],
    ['fleet', false, true],
    ['both', true, true],
  ])('%s', (value, sidebar, fleet) => {
    const s = { ...DEFAULT_SETTINGS, compactCards: value as never };
    expect(compactIn(s, 'sidebar')).toBe(sidebar);
    expect(compactIn(s, 'fleet')).toBe(fleet);
  });
});
```

- [ ] **Step 2: Run the store tests to verify they fail**

Run: `npx vitest run tests/renderer/settings.test.ts`
Expected: FAIL. `Failed to load url ../../src/renderer/state/settings.ts`.

- [ ] **Step 3: Create the store**

Create `src/renderer/state/settings.ts`:

```ts
import { useSyncExternalStore } from 'react';

/** The four per-viewer preferences the settings modal owns, and the app's
 *  first shared renderer store.
 *
 *  Follows SessionRail's existing localStorage pattern exactly (see
 *  RAIL_WIDTH_STORAGE_KEY there): one `llmws:` namespaced key, a JSON
 *  object, every read wrapped in try/catch, every value validated against
 *  its allowed set with a fallback to the default, and a write that
 *  swallows errors. The rail's own `llmws:rail-width` key stays where it is
 *  -- this store does not absorb it.
 *
 *  Nothing here crosses IPC except the appearance value, which main needs
 *  for nativeTheme and the window's first paint (src/main/appearance.ts).
 *  There is no node import anywhere in this file, and there must not be:
 *  a value import from main blanks the whole window. */

export type Appearance = 'system' | 'light' | 'dark';
export type TextSize = 14 | 15 | 16 | 17;
export type MessageStyle = 'a' | 'c';
/** One setting with four values rather than two booleans, so "Both on but
 *  Fleet off" is not a state that can exist. */
export type CompactCards = 'off' | 'sidebar' | 'fleet' | 'both';

export type Settings = {
  appearance: Appearance;
  textSize: TextSize;
  messageStyle: MessageStyle;
  compactCards: CompactCards;
};

export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];
export const TEXT_SIZES: readonly TextSize[] = [14, 15, 16, 17];
export const MESSAGE_STYLES: readonly MessageStyle[] = ['a', 'c'];
export const COMPACT_CARDS: readonly CompactCards[] = ['off', 'sidebar', 'fleet', 'both'];

export const SETTINGS_STORAGE_KEY = 'llmws:settings';

/** Every default is a decision David made against the rendered mockup on
 *  2026-09-15, not a placeholder: 16px reading size, style A (the accent
 *  rule down the agent's replies), compact cards in both places, and
 *  appearance following the OS until told otherwise. */
export const DEFAULT_SETTINGS: Settings = {
  appearance: 'system', textSize: 16, messageStyle: 'a', compactCards: 'both',
};

function pick<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

/** Untrusted in the ordinary sense: this is a blob on disk, and a value
 *  rendered verbatim would put an unknown appearance on the root element or
 *  an arbitrary number in a CSS size. Each field is checked on its own, so
 *  one bad value costs one default rather than the whole object. */
export function normalizeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_SETTINGS;
  const r = raw as Record<string, unknown>;
  return {
    appearance: pick(APPEARANCES, r.appearance, DEFAULT_SETTINGS.appearance),
    textSize: pick(TEXT_SIZES, r.textSize, DEFAULT_SETTINGS.textSize),
    messageStyle: pick(MESSAGE_STYLES, r.messageStyle, DEFAULT_SETTINGS.messageStyle),
    compactCards: pick(COMPACT_CARDS, r.compactCards, DEFAULT_SETTINGS.compactCards),
  };
}

function read(): Settings {
  try {
    const rawText = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (rawText === null) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(rawText));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function write(s: Settings): void {
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s)); } catch { /* best-effort only */ }
}

function same(a: Settings, b: Settings): boolean {
  return a.appearance === b.appearance && a.textSize === b.textSize
    && a.messageStyle === b.messageStyle && a.compactCards === b.compactCards;
}

let current: Settings = read();
const listeners = new Set<() => void>();

/** A STABLE object identity until something actually changes -- required by
 *  useSyncExternalStore, which re-renders forever if the snapshot is a new
 *  object each call. */
export function getSettings(): Settings {
  return current;
}

export function setSettings(patch: Partial<Settings>): void {
  const next = normalizeSettings({ ...current, ...patch });
  if (same(next, current)) return;
  current = next;
  write(next);
  for (const listener of listeners) listener();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-reads from storage and notifies. Exists for tests, which write
 *  localStorage directly and need the module to see it; harmless in
 *  production, where nothing calls it. */
export function reloadSettings(): void {
  current = read();
  for (const listener of listeners) listener();
}

/** React 18's own external-store hook -- no state library, no context
 *  provider, and every consumer sees the same object the moment the modal
 *  writes it. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}

/** Whether cards are compact in one of the two places that show them.
 *  Reading the four-value setting in one place keeps the rail and the grid
 *  from drifting into two slightly different interpretations. */
export function compactIn(s: Settings, place: 'sidebar' | 'fleet'): boolean {
  return s.compactCards === 'both' || s.compactCards === place;
}
```

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `npx vitest run tests/renderer/settings.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Write the failing modal and gear tests**

Create `tests/renderer/SettingsModal.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsModal } from '../../src/renderer/components/SettingsModal.tsx';
import { DEFAULT_SETTINGS, getSettings, reloadSettings } from '../../src/renderer/state/settings.ts';

beforeEach(() => {
  localStorage.clear();
  reloadSettings();
  document.documentElement.className = '';
});

describe('SettingsModal', () => {
  it('renders nothing visible until it is opened', () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />);
    expect(container.querySelector('dialog')!.hasAttribute('open')).toBe(false);
  });

  it('offers every documented choice, with the stored value selected', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    expect((screen.getByLabelText('Appearance') as HTMLSelectElement).value).toBe('system');
    expect((screen.getByLabelText('Conversation text size') as HTMLSelectElement).value).toBe('16');
    expect((screen.getByLabelText('Message style') as HTMLSelectElement).value).toBe('a');
    expect((screen.getByLabelText('Compact cards') as HTMLSelectElement).value).toBe('both');
    expect([...(screen.getByLabelText('Conversation text size') as HTMLSelectElement).options].map(o => o.value))
      .toEqual(['14', '15', '16', '17']);
    expect([...(screen.getByLabelText('Compact cards') as HTMLSelectElement).options].map(o => o.value))
      .toEqual(['off', 'sidebar', 'fleet', 'both']);
  });

  it('writes a change straight through to the store', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Conversation text size'), { target: { value: '14' } });
    expect(getSettings().textSize).toBe(14);
    fireEvent.change(screen.getByLabelText('Message style'), { target: { value: 'c' } });
    expect(getSettings().messageStyle).toBe('c');
  });

  it('refuses a value outside the offered set rather than storing it', () => {
    render(<SettingsModal open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'sepia' } });
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: /close settings/i }))],
    ['Done', () => fireEvent.click(screen.getByRole('button', { name: /^done$/i }))],
  ])('closes on %s', (_label, act) => {
    const onClose = vi.fn();
    render(<SettingsModal open={true} onClose={onClose} />);
    act();
    expect(onClose).toHaveBeenCalled();
  });

  // A click on a native dialog's backdrop targets the dialog element
  // itself; a click on anything inside targets that child. Both are
  // exercised, because a handler that only checked "is this the dialog"
  // would also close on every click that bubbled up from a select.
  it('closes on a backdrop click but not on a click inside the panel', () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsModal open={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Appearance'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('dialog')!);
    expect(onClose).toHaveBeenCalled();
  });

  // Spec §3.5: the page and the conversation do not scroll while this is
  // open. jsdom paints nothing, so the class that carries the lock is what
  // can be asserted; SettingsModal.css is where the rules live.
  it('locks background scrolling while open and releases it on close', () => {
    const { rerender, unmount } = render(<SettingsModal open={true} onClose={() => {}} />);
    expect(document.documentElement.classList.contains('modal-open')).toBe(true);
    rerender(<SettingsModal open={false} onClose={() => {}} />);
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);
    rerender(<SettingsModal open={true} onClose={() => {}} />);
    unmount();
    expect(document.documentElement.classList.contains('modal-open')).toBe(false);
  });
});
```

In `tests/renderer/LaunchBar.test.tsx`, append inside the describe:

```tsx
  it('opens settings from a gear beside Launch, and returns focus to it on close', () => {
    render(<LaunchBar onLaunched={() => {}} />);
    const gear = screen.getByRole('button', { name: /^settings$/i });
    fireEvent.click(gear);
    expect(screen.getByLabelText('Appearance')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(document.activeElement).toBe(gear);
  });
```

In `tests/renderer/ConversationView.test.tsx`, append:

```tsx
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
```

Add to that file's imports:

```tsx
import { reloadSettings, setSettings } from '../../src/renderer/state/settings.ts';
```

- [ ] **Step 6: Run the modal tests to verify they fail**

Run: `npx vitest run tests/renderer/SettingsModal.test.tsx tests/renderer/LaunchBar.test.tsx tests/renderer/ConversationView.test.tsx`

Expected: FAIL. `SettingsModal.test.tsx` does not load (`Failed to load url ../../src/renderer/components/SettingsModal.tsx`); `LaunchBar.test.tsx` fails with `Unable to find an accessible element with the role "button" and name /^settings$/i`; `ConversationView.test.tsx` fails with `expected '' to be '14px'`.

- [ ] **Step 7: Create the modal**

Create `src/renderer/components/SettingsModal.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import {
  APPEARANCES, COMPACT_CARDS, MESSAGE_STYLES, TEXT_SIZES, setSettings, useSettings,
  type Appearance, type CompactCards, type MessageStyle, type TextSize,
} from '../state/settings.ts';
import './SettingsModal.css';

/** Human wording for each stored value. Kept beside the store's own allowed
 *  sets so adding a value without labelling it is a compile error, not a
 *  blank option. */
const APPEARANCE_LABEL: Record<Appearance, string> = {
  system: 'System', light: 'Light', dark: 'Dark',
};
const MESSAGE_STYLE_LABEL: Record<MessageStyle, string> = {
  a: 'A -- a rule down the agent\'s replies',
  c: 'C -- your messages in a bubble on the right',
};
const COMPACT_LABEL: Record<CompactCards, string> = {
  off: 'Off', sidebar: 'Sidebar only', fleet: 'Fleet only', both: 'Both',
};

/** The class that carries the background scroll lock. On the root element,
 *  not on body: this app's scrolling lives in .mainpane, .conv and
 *  .railcards, none of which body's own overflow reaches (see
 *  SettingsModal.css). */
const LOCK_CLASS = 'modal-open';

/** A native <dialog>, not a hand-rolled overlay: it supplies the top layer,
 *  the focus trap and the inert background for free, and this renderer has
 *  no focus-trap infrastructure to borrow (ReplyPopover is an inline
 *  popover, not a model for this).
 *
 *  Focus returns to the gear on close -- LaunchBar owns that, since it owns
 *  the button. */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettings();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (el === null) return;
    // jsdom 30 -- this project's test environment -- implements <dialog> as
    // an element but NOT showModal/close: both read undefined, verified
    // directly. Chromium has both. Falling back to the `open` attribute
    // keeps the same component renderable and assertable under test instead
    // of throwing at mount, and costs nothing in the real app.
    if (open) {
      if (typeof el.showModal === 'function') { if (!el.open) el.showModal(); }
      else el.setAttribute('open', '');
    } else {
      if (typeof el.close === 'function') { if (el.open) el.close(); }
      else el.removeAttribute('open');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.documentElement.classList.add(LOCK_CLASS);
    // Removed on close AND on unmount: a modal open when its owner
    // unmounts would otherwise leave the whole app unscrollable with
    // nothing on screen to explain why.
    return () => { document.documentElement.classList.remove(LOCK_CLASS); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // preventDefault, then close through React: Chromium's own dialog
      // Escape closes the ELEMENT directly, which would leave this
      // component's `open` prop stale and the gear unable to reopen it.
      // Routing both environments through onClose keeps one source of truth.
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="settingsdlg"
      aria-label="Settings"
      onCancel={e => { e.preventDefault(); onClose(); }}
      // A click on a native dialog's BACKDROP targets the dialog element
      // itself; a click on anything inside targets that child and bubbles.
      // Comparing the target is what tells the two apart.
      onClick={e => { if (e.target === dialogRef.current) onClose(); }}
    >
      <div className="settingspanel">
        <header className="settingshead">
          <h2>Settings</h2>
          <button type="button" className="settingsclose" aria-label="Close settings" onClick={onClose}>
            Close
          </button>
        </header>

        <label className="settingsrow">
          <span>Appearance</span>
          <select value={settings.appearance}
            onChange={e => setSettings({ appearance: e.target.value as Appearance })}>
            {APPEARANCES.map(a => <option key={a} value={a}>{APPEARANCE_LABEL[a]}</option>)}
          </select>
        </label>

        <label className="settingsrow">
          <span>Conversation text size</span>
          <select value={String(settings.textSize)}
            onChange={e => setSettings({ textSize: Number(e.target.value) as TextSize })}>
            {TEXT_SIZES.map(n => <option key={n} value={n}>{n}px</option>)}
          </select>
        </label>

        <label className="settingsrow">
          <span>Message style</span>
          <select value={settings.messageStyle}
            onChange={e => setSettings({ messageStyle: e.target.value as MessageStyle })}>
            {MESSAGE_STYLES.map(m => <option key={m} value={m}>{MESSAGE_STYLE_LABEL[m]}</option>)}
          </select>
        </label>

        <label className="settingsrow">
          <span>Compact cards</span>
          <select value={settings.compactCards}
            onChange={e => setSettings({ compactCards: e.target.value as CompactCards })}>
            {COMPACT_CARDS.map(c => <option key={c} value={c}>{COMPACT_LABEL[c]}</option>)}
          </select>
        </label>

        <div className="settingsfoot">
          <button type="button" className="settingsdone" onClick={onClose}>Done</button>
        </div>
      </div>
    </dialog>
  );
}
```

`setSettings` re-validates every value against the store's own allowed set, so the `as Appearance` casts above narrow nothing at the boundary — a `<select>` whose value was changed programmatically to something unknown lands on the default, which is what the "refuses a value outside the offered set" test pins.

Create `src/renderer/components/SettingsModal.css`:

```css
/* src/renderer/components/SettingsModal.css
   Tokens only -- theme.css owns every colour. */

/* LaunchBar.css makes .launchbar a window-drag region, and this dialog
   renders inside it, so without this opt-out every control in here would
   be a drag handle instead of a control. Same trap FleetView.css's
   .fleetbar documents. */
.settingsdlg { -webkit-app-region:no-drag; border:0; padding:0; background:none;
  color:var(--ink); max-width:min(440px,92vw); }
.settingsdlg::backdrop { background:rgb(0 0 0 / 46%); }
.settingspanel { display:flex; flex-direction:column; gap:12px;
  background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg);
  box-shadow:var(--shadow-pop); padding:18px 20px 16px;
  /* The modal's own scrolling stays inside it: overscroll-behavior stops a
     wheel that reaches this panel's end from chaining out to whatever is
     behind (spec §3.5). */
  max-height:80vh; overflow-y:auto; overscroll-behavior:contain; }
.settingshead { display:flex; align-items:center; gap:12px; }
.settingshead h2 { margin:0; font-family:var(--f-display); font-size:18px; font-weight:600; }
.settingsclose { margin-left:auto; font-family:var(--f-mono); font-size:11px; color:var(--muted);
  background:none; border:1px solid var(--line-soft); border-radius:20px; padding:4px 12px; cursor:pointer; }
.settingsclose:hover { color:var(--ink); border-color:var(--line); }
.settingsrow { display:flex; align-items:center; gap:12px; font-size:13px; }
.settingsrow > span { flex:1; min-width:0; }
.settingsrow select { flex:none; max-width:56%; font-family:var(--f-mono); font-size:11px;
  color:var(--ink); background:var(--ground); border:1px solid var(--line);
  border-radius:6px; padding:5px 8px; }
.settingsfoot { display:flex; justify-content:flex-end; }
.settingsdone { font-family:var(--f-mono); font-size:11px; font-weight:600; color:var(--ground);
  background:var(--accent); border:0; border-radius:6px; padding:6px 16px; cursor:pointer; }

/* The background scroll lock (SettingsModal.tsx's LOCK_CLASS). Body's own
   overflow does nothing here -- this app's scrolling lives in these three
   elements, each of which manages its own (see MainPane.css,
   ConversationView.css, SessionRail.css) -- so the lock names them. */
:root.modal-open .mainpane,
:root.modal-open .conv,
:root.modal-open .railcards { overflow:hidden; }
```

- [ ] **Step 8: Add the gear**

First add the glyph to the shared icon set. In `src/renderer/components/Icon.tsx`, change line 1 to:

```ts
import { Bell, CircleNotch, Gear, Terminal, Warning } from '@phosphor-icons/react';
```

and line 6 to:

```ts
const ICONS = { bell: Bell, gear: Gear, spinner: CircleNotch, terminal: Terminal, warning: Warning } as const;
```

In `tests/renderer/Icon.test.tsx`, add `Gear` to the import on line 3, `gear: Gear,` to `EXPECTED` on line 13, and `'gear'` to `NAMES` on line 15.

Then, in `src/renderer/components/LaunchBar.tsx`, change the React import to `import { useRef, useState } from 'react';`, add `import { Icon } from './Icon.tsx';` and `import { SettingsModal } from './SettingsModal.tsx';`, and inside the component add:

```tsx
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focus returns here when the modal closes, by whichever route -- Escape,
  // the close button, Done or the backdrop. A person who opened settings
  // from the keyboard must not be dropped back at the top of the document.
  const gearRef = useRef<HTMLButtonElement | null>(null);
```

Replace the submit button and message (lines 65-68) with:

```tsx
      <button type="submit" className="launchgo" disabled={pending}>
        {pending ? 'Launching…' : 'Launch'}
      </button>
      {/* Beside Launch, per the mockup. A real button, so it is reachable
          by keyboard and carries a real accessible name -- "Settings", not
          the glyph, which Icon renders aria-hidden. Phosphor's Gear, not a
          Unicode gear character: U+2699 renders as a colour emoji on macOS
          in some fonts, and this app uses none. */}
      <button type="button" className="launchgear" aria-label="Settings" ref={gearRef}
        onClick={() => setSettingsOpen(true)}>
        <Icon name="gear" size={14} />
      </button>
      <SettingsModal open={settingsOpen} onClose={() => {
        setSettingsOpen(false);
        gearRef.current?.focus();
      }} />
      {message && <p className="launchmsg" role="status">{message}</p>}
```

The gear sits inside `<form className="launchbar">` and is `type="button"`, so it never submits the launch form.

Append to `src/renderer/components/LaunchBar.css`:

```css
.launchgear { display:inline-flex; align-items:center; line-height:1; color:var(--muted);
  background:none; border:1px solid var(--line-soft); border-radius:6px;
  padding:5px 9px; cursor:pointer; }
.launchgear:hover { color:var(--ink); border-color:var(--line); }
```

`.launchbar button { -webkit-app-region:no-drag; }` already covers the gear itself; the dialog gets its own opt-out in `SettingsModal.css` because it is not a button.

- [ ] **Step 9: Read the settings in the conversation**

In `src/renderer/components/ConversationView.tsx`, add `import { useSettings } from '../state/settings.ts';`, add inside the component (next to the other hooks):

```tsx
  const settings = useSettings();
```

and change the scroller element to:

```tsx
      <div
        className="conv"
        // The one size the pane is built from (spec §3.5): every
        // message-level rule in ConversationView.css is expressed relative
        // to it, so meta lines, code blocks and steps move with the body
        // text rather than staying behind at a fixed px.
        style={{ ['--conv-size' as string]: `${settings.textSize}px` } as React.CSSProperties}
        data-style={settings.messageStyle}
        ref={scrollerRef}
        onScroll={handleScroll}
      >
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/settings.test.ts tests/renderer/SettingsModal.test.tsx tests/renderer/Icon.test.tsx tests/renderer/LaunchBar.test.tsx tests/renderer/ConversationView.test.tsx tests/renderer/App.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 11: Typecheck, and confirm the renderer still reaches no Node**

Run: `npm run typecheck && grep -rn "from 'node:\|require('node:" src/renderer || echo "renderer clean"`
Expected: typecheck exits 0, and the output ends with `renderer clean`.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/state/settings.ts src/renderer/components/SettingsModal.tsx src/renderer/components/SettingsModal.css src/renderer/components/Icon.tsx src/renderer/components/LaunchBar.tsx src/renderer/components/LaunchBar.css src/renderer/components/ConversationView.tsx tests/renderer/settings.test.ts tests/renderer/SettingsModal.test.tsx tests/renderer/Icon.test.tsx tests/renderer/LaunchBar.test.tsx tests/renderer/ConversationView.test.tsx
git commit -m "feat(settings): a gear beside Launch, and the four preferences behind it"
```

---

### Task 6: Appearance reaches the window, not just the page

**Files:**
- Modify: `src/config.ts:10-32` (`Paths`, `resolvePaths`)
- Create: `src/main/appearance.ts`
- Modify: `src/main/ipc.ts` (imports; `applyThemeChoice`; the `app:theme` handler)
- Modify: `src/main/index.ts:1` (imports), `:43-57` (`createWindow`), `:123-126` (startup)
- Modify: `src/preload/index.ts` (`setTheme`), `src/renderer/types.d.ts`
- Modify: `src/renderer/App.tsx:73-85`
- Test: `tests/main/appearance.test.ts` (create), `tests/main/ipc.test.ts`, `tests/main/security.test.ts`, `tests/renderer/theme.test.ts`, `tests/renderer/App.test.tsx`, `tests/cli.test.ts`

**Interfaces:**
- Consumes (Task 5): `useSettings()`, `Settings.appearance`.
- Produces:
  - `type ThemeChoice = 'system' | 'light' | 'dark'` and `readStoredTheme(path: string): ThemeChoice`, `writeStoredTheme(path: string, theme: ThemeChoice): void`, from `src/main/appearance.ts`
  - `Paths.appearance: string`
  - `applyThemeChoice(raw: unknown, deps?: { setSource?: (t: ThemeChoice) => void; persist?: (t: ThemeChoice) => void }): { status: 'set'; theme: ThemeChoice } | { status: 'refused' }`, exported from `src/main/ipc.ts`
  - `window.fleet.setTheme(theme: string): Promise<unknown>` over the new `app:theme` channel

**Why main stores one value.** See "Spec decisions this plan resolves" above: main cannot read the renderer's `localStorage`, and `backgroundColor` is fixed before the renderer exists. Only `appearance` is mirrored; every other setting stays renderer-only.

- [ ] **Step 1: Write the failing tests**

Create `tests/main/appearance.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoredTheme, writeStoredTheme } from '../../src/main/appearance.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'appearance-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the mirrored appearance choice', () => {
  const path = () => join(dir, 'appearance.json');

  it('round-trips each of the three values', () => {
    for (const theme of ['system', 'light', 'dark'] as const) {
      writeStoredTheme(path(), theme);
      expect(readStoredTheme(path())).toBe(theme);
    }
  });

  // Every failure mode reads as 'system', which is the app's own default
  // and the one answer that is never wrong to fall back to: it hands the
  // decision back to the OS.
  it.each([
    ['no file at all', null],
    ['a corrupt blob', '{not json'],
    ['a value outside the three', '{"theme":"sepia"}'],
    ['the wrong shape entirely', '[]'],
    ['an empty file', ''],
  ])('reads as system for %s', (_label, contents) => {
    if (contents !== null) writeFileSync(path(), contents);
    expect(readStoredTheme(path())).toBe('system');
  });

  it('reads as system when the directory itself does not exist, without throwing', () => {
    expect(readStoredTheme(join(dir, 'nope', 'appearance.json'))).toBe('system');
  });

  it('creates the directory rather than failing on a first run', () => {
    const nested = join(dir, 'fresh', 'appearance.json');
    writeStoredTheme(nested, 'dark');
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('never throws when the path cannot be written', () => {
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    // A directory where the file should be: the write must fail quietly,
    // because an unwritable preference is not worth failing a launch over.
    expect(() => writeStoredTheme(blocked, 'light')).not.toThrow();
  });
});
```

In `tests/main/ipc.test.ts`, add `applyThemeChoice` to the import list from `'../../src/main/ipc.ts'` and append:

```ts
describe('applyThemeChoice', () => {
  // The renderer can call any exposed channel with any argument, so the
  // three literals are checked HERE, in main, before the value reaches
  // nativeTheme or a file (spec §5).
  it.each(['system', 'light', 'dark'])('accepts %s and passes it on exactly once', (theme) => {
    const setSource: string[] = [];
    const persist: string[] = [];
    const r = applyThemeChoice(theme, { setSource: t => setSource.push(t), persist: t => persist.push(t) });
    expect(r).toEqual({ status: 'set', theme });
    expect(setSource).toEqual([theme]);
    expect(persist).toEqual([theme]);
  });

  it.each([
    ['an unknown word', 'sepia'],
    ['an empty string', ''],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object', { theme: 'dark' }],
    ['an array', ['dark']],
  ])('refuses %s, and touches neither nativeTheme nor the file', (_label, raw) => {
    let touched = false;
    const mark = () => { touched = true; };
    expect(applyThemeChoice(raw, { setSource: mark, persist: mark })).toEqual({ status: 'refused' });
    expect(touched).toBe(false);
  });
});
```

In `tests/main/security.test.ts`, replace the expected channel list (lines 40-46) with:

```ts
    expect(exposed.sort()).toEqual([
      'app:theme',
      'dialog:directory',
      'fleet:history', 'fleet:list',
      'session:attach', 'session:conversation', 'session:detach', 'session:keys',
      'session:kill', 'session:launch', 'session:raw', 'session:reattach',
      'session:resize', 'session:resume', 'session:reveal',
    ]);
```

In `tests/renderer/theme.test.ts`, append inside the `theme tokens` describe:

```ts
  // src/main/index.ts paints the window's very first frame before any CSS
  // exists, so it hardcodes the two --ground values rather than reading
  // them. That is the one place a token is duplicated outside this file,
  // and drift there is invisible to every renderer test: a light user would
  // simply get a dark flash on every launch.
  it('paints the window\'s first frame from the same --ground values declared here', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    const dark = parseTokens(css.slice(0, css.search(/@media|:root\[data-theme/)))['--ground'];
    const light = parseTokens(blockAfter(':root[data-theme="light"]'))['--ground'];
    expect(main, 'the dark first-paint colour must be --ground').toContain(dark);
    expect(main, 'the light first-paint colour must be the light --ground').toContain(light);
  });
```

In `tests/cli.test.ts`, inside `describe('resolvePaths', ...)` add after the `spool` line (line 23):

```ts
    expect(p.appearance).toBe('/home/me/.llm-workspace/appearance.json');
```

In `tests/renderer/App.test.tsx`, append:

```tsx
describe('App -- appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    reloadSettings();
    document.documentElement.removeAttribute('data-theme');
    (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
      listFleet: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', openSessions: [] }),
      listHistory: vi.fn().mockResolvedValue({ version: 1, generatedAt: '', sessions: [], total: 0 }),
      onFleet: vi.fn(() => () => {}),
      setTheme: vi.fn().mockResolvedValue({ status: 'set', theme: 'system' }),
    };
  });

  // 'system' must set NO attribute: theme.css's light block is guarded as
  // :root:not([data-theme="dark"]) inside a prefers-color-scheme query, so
  // the OS setting only wins while nothing explicit is on the root.
  it('sets no data-theme for System, and tells main the same thing', async () => {
    render(<App />);
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));
    expect((window as unknown as { fleet: { setTheme: ReturnType<typeof vi.fn> } }).fleet.setTheme)
      .toHaveBeenCalledWith('system');
  });

  it('stamps an explicit choice on the root element and tells main', async () => {
    setSettings({ appearance: 'light' });
    render(<App />);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    expect((window as unknown as { fleet: { setTheme: ReturnType<typeof vi.fn> } }).fleet.setTheme)
      .toHaveBeenCalledWith('light');
  });
});
```

Add to that file's imports whatever it is missing: `App` from `'../../src/renderer/App.tsx'`, `waitFor` from `@testing-library/react`, and `reloadSettings, setSettings` from `'../../src/renderer/state/settings.ts'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/main/appearance.test.ts tests/main/ipc.test.ts tests/main/security.test.ts tests/renderer/theme.test.ts tests/renderer/App.test.tsx tests/cli.test.ts`

Expected: FAIL. `appearance.test.ts` does not load (`Failed to load url ../../src/main/appearance.ts`); `ipc.test.ts` fails on `applyThemeChoice is not a function`; `security.test.ts` fails because `app:theme` is missing from the exposed list; `theme.test.ts` fails on the light `--ground`; `cli.test.ts` fails on `expected undefined to be '/home/me/.llm-workspace/appearance.json'`.

- [ ] **Step 3: Add the path and the mirror**

In `src/config.ts`, add `appearance: string;` to `interface Paths` after `spool: string;`, and in `resolvePaths` add after the `spool` line:

```ts
    appearance: join(home, '.llm-workspace/appearance.json'),
```

Create `src/main/appearance.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The ONE setting main keeps a copy of.
 *
 *  Every other preference lives in the renderer's localStorage and stays
 *  there (src/renderer/state/settings.ts). Appearance is the exception for
 *  a reason that cannot be designed away: BrowserWindow's backgroundColor
 *  is the colour of the window's very first frame, chosen before the
 *  renderer exists, and main cannot read localStorage. Without this mirror
 *  a person who chose Light gets a dark flash on every launch.
 *
 *  Deliberately tiny: one field, three possible values, and every failure
 *  reads as 'system' -- the app's own default, and the one answer that is
 *  never wrong, since it hands the decision back to the OS. */

export type ThemeChoice = 'system' | 'light' | 'dark';

const CHOICES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);

export function readStoredTheme(path: string): ThemeChoice {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'system';
    const theme = (raw as Record<string, unknown>).theme;
    return typeof theme === 'string' && CHOICES.has(theme) ? theme as ThemeChoice : 'system';
  } catch {
    // Missing file, missing directory, unreadable, malformed -- all the
    // same answer, and none of them is worth failing a launch over.
    return 'system';
  }
}

/** Best-effort, like every preference write in this app: an unwritable
 *  home directory costs the next launch's first frame, nothing more. */
export function writeStoredTheme(path: string, theme: ThemeChoice): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ theme }));
  } catch { /* best-effort only */ }
}
```

- [ ] **Step 4: Validate the choice in main**

In `src/main/ipc.ts`, add `nativeTheme` to the electron import on line 6, add `homedir` and `resolvePaths`:

```ts
import { homedir } from 'node:os';
```

add `resolvePaths` to the existing `'../config.ts'` import, and add:

```ts
import { writeStoredTheme, type ThemeChoice } from './appearance.ts';
```

`readStoredTheme` is not imported here: only `src/main/index.ts` reads the file, at startup.

Add above `registerIpc`:

```ts
export type ThemeResult = { status: 'set'; theme: ThemeChoice } | { status: 'refused' };

type ThemeDeps = {
  setSource?: (theme: ThemeChoice) => void;
  persist?: (theme: ThemeChoice) => void;
};

/** app:theme -- the renderer's appearance choice, reaching the WINDOW.
 *
 *  data-theme on the root element only restyles the page; native
 *  scrollbars, the folder picker and the title bar follow nativeTheme,
 *  which only main can set. The value is checked against the three
 *  literals HERE, before it reaches nativeTheme or the file: the renderer
 *  can call any exposed channel with any argument, whatever the preload's
 *  TypeScript says, so this is the boundary, not the typing.
 *
 *  Both effects are injectable because under plain-Node vitest the electron
 *  import is a stub and `nativeTheme` binds to undefined (see this file's
 *  own note on ipcMain at the top). The defaults are built lazily inside
 *  the call, so nothing dereferences the stub at module scope. */
export function applyThemeChoice(raw: unknown, deps: ThemeDeps = {}): ThemeResult {
  if (raw !== 'system' && raw !== 'light' && raw !== 'dark') return { status: 'refused' };
  const theme: ThemeChoice = raw;
  (deps.setSource ?? ((t: ThemeChoice) => { nativeTheme.themeSource = t; }))(theme);
  // Mirrored for the next launch's first frame only -- see
  // src/main/appearance.ts's doc comment.
  (deps.persist ?? ((t: ThemeChoice) => writeStoredTheme(resolvePaths(homedir()).appearance, t)))(theme);
  return { status: 'set', theme };
}
```

Inside `registerIpc`, next to the other handlers:

```ts
  ipcMain.handle('app:theme', (_event, theme: unknown) => applyThemeChoice(theme));
```

- [ ] **Step 5: Paint the first frame in the right colour**

In `src/main/index.ts`, change line 1 to:

```ts
import { app, BrowserWindow, shell, nativeTheme } from 'electron';
```

add:

```ts
import { readStoredTheme } from './appearance.ts';
```

add above `createWindow`:

```ts
/** The window's very first frame is painted before any stylesheet exists,
 *  so these two are theme.css's own --ground values, duplicated here of
 *  necessity. tests/renderer/theme.test.ts pins them to the tokens so they
 *  cannot drift unnoticed -- drift here is invisible to every renderer
 *  test and shows up only as a flash of the wrong colour on launch. */
const FIRST_PAINT_BG = { dark: '#1a1918', light: '#f6f5f3' } as const;
```

replace line 47 with:

```ts
    backgroundColor: nativeTheme.shouldUseDarkColors ? FIRST_PAINT_BG.dark : FIRST_PAINT_BG.light,
```

and in `app.whenReady().then(...)`, immediately after `db = openDb(paths.db);`:

```ts
  // Before createWindow, not after: backgroundColor below is read once, at
  // construction. shouldUseDarkColors then reflects this choice for an
  // explicit Light or Dark, and the OS setting for 'system'.
  nativeTheme.themeSource = readStoredTheme(paths.appearance);
```

- [ ] **Step 6: Expose the channel and apply the attribute**

In `src/preload/index.ts`, add to the api object:

```ts
  // The appearance choice, so the WINDOW follows it too -- nativeTheme
  // drives native scrollbars, the folder picker and the title bar, none of
  // which a data-theme attribute on the page can reach. Main checks the
  // value against its own three literals (applyThemeChoice); this typing
  // narrows nothing at the trust boundary, same as every other channel here.
  setTheme: (theme: string) => ipcRenderer.invoke('app:theme', theme),
```

In `src/renderer/types.d.ts`, add to the `fleet` interface:

```ts
      setTheme: (theme: string) => Promise<unknown>;
```

In `src/renderer/App.tsx`, change the React import to include `useEffect`, add `import { useSettings } from './state/settings.ts';`, and add at the top of `App`, immediately after the `useFleet()` line:

```tsx
  const settings = useSettings();

  useEffect(() => {
    const root = document.documentElement;
    // 'system' means NO attribute at all: theme.css's light palette is
    // guarded as :root:not([data-theme="dark"]) inside a
    // prefers-color-scheme query, so the OS setting only wins while
    // nothing explicit is stamped on the root.
    if (settings.appearance === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.appearance);
    // Best-effort, like every other bridge call in this tree: a missing
    // preload leaves the page correctly themed and only the window chrome
    // behind, which is better than throwing at mount.
    void window.fleet?.setTheme(settings.appearance);
  }, [settings.appearance]);
```

Both hooks sit above the `if (!window.fleet)` early return, so hook order is stable across every branch.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/main/appearance.test.ts tests/main/ipc.test.ts tests/main/security.test.ts tests/renderer/theme.test.ts tests/renderer/App.test.tsx tests/cli.test.ts tests/main/lifecycle.test.ts`
Expected: PASS, all tests. `lifecycle.test.ts` is included because it exercises `src/main/index.ts`'s startup path.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/main/appearance.ts src/main/ipc.ts src/main/index.ts src/preload/index.ts src/renderer/types.d.ts src/renderer/App.tsx tests/main/appearance.test.ts tests/main/ipc.test.ts tests/main/security.test.ts tests/renderer/theme.test.ts tests/renderer/App.test.tsx tests/cli.test.ts
git commit -m "feat(appearance): System, Light and Dark reach the window, not just the page"
```

---

### Task 7: Compact cards, and the "..." menu

**Files:**
- Modify: `src/renderer/components/OpenSessionCard.tsx:110-137` (props), `:230-250` (menu state), `:317-380` (card body), `:396-543` (actions)
- Modify: `src/renderer/components/OpenSessionCard.css` (compact rules, the menu popover)
- Modify: `src/renderer/components/SessionRail.tsx:79-96` (reads the setting), `:217-218`
- Modify: `src/renderer/components/FleetView.tsx:23-27`, `:116-119`
- Test: `tests/renderer/OpenSessionCard.test.tsx`, `tests/renderer/SessionRail.test.tsx`, `tests/renderer/FleetView.test.tsx`

**Interfaces:**
- Consumes (Task 5): `useSettings()`, `compactIn(settings, place)`.
- Produces: `OpenSessionCard({ state, onOpen, onKill, onReveal, onReattach, onResume, unread, compact })` — `compact?: boolean`, default `false`, so every existing call site is unchanged until it opts in.

**Two traps this task is designed around.**
`SessionCard.css` owns the base `.card`/`.said`/`.proj` rules globally, and `.said` carries a 2-line clamp. The compact variant therefore only *adds* `.card.compact` rules and never edits a base one, and a compact card does not render `.said` at all, so the clamp has nothing to clip.
`FleetView.css`'s `.fleetbar` is the window drag region and anything interactive inside it needs an explicit `-webkit-app-region:no-drag`. Nothing in this task goes there: the menu lives inside `.fleet` and `.railcards`, which are not drag regions.

- [ ] **Step 1: Write the failing tests**

In `tests/renderer/OpenSessionCard.test.tsx`, append:

```tsx
describe('OpenSessionCard -- the compact variant', () => {
  const enrichedCompact: OpenSession = {
    ...base, match: 'unique', sessionId: 's1', lastProse: 'Reused the JWT helper',
    events: 9129, activity: 'working', tmux: false,
  };
  const renderCompact = (over: Partial<OpenSession> = {}, props: Record<string, unknown> = {}) =>
    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()}
      onResume={neverResume()} compact state={{ ...enrichedCompact, ...over }} {...props} />);

  it('keeps the provider, the project, the status and the host, and drops the rest', () => {
    const { container } = renderCompact();
    expect(container.querySelector('.card')!.classList.contains('compact')).toBe(true);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('iTerm2')).toBeTruthy();
    expect(screen.getByText('working')).toBeTruthy();
    // Dropped: the path, the last reply, the age/memory line and the
    // event count -- the four things that make a full card tall.
    expect(screen.queryByText('/Users/me/trellome')).toBeNull();
    expect(screen.queryByText('Reused the JWT helper')).toBeNull();
    expect(screen.queryByText(/206 MB/)).toBeNull();
    expect(screen.queryByText('9,129')).toBeNull();
  });

  it('keeps the unread dot, which is the whole point of glancing at the rail', () => {
    const { container } = renderCompact({}, { unread: true });
    expect(container.querySelector('.unread-dot')).not.toBeNull();
  });

  it('keeps the blocked badge and its wording', () => {
    const { container } = renderCompact({ activity: 'waiting_permission' });
    expect(container.querySelector('.badge')).not.toBeNull();
    expect(screen.getByText(/waiting on you/)).toBeTruthy();
  });

  it('offers no bare Close or Reattach button -- they live in the menu', () => {
    renderCompact();
    expect(screen.queryByRole('button', { name: /^Close, pid/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reattach in app, pid/ })).toBeNull();
    expect(screen.getByRole('button', { name: /session actions/i })).toBeTruthy();
  });

  it('opens the menu with the three documented items', () => {
    const { container } = renderCompact({}, { onReveal: vi.fn(async () => {}) });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect([...container.querySelectorAll('.cardmenu-item')].map(b => b.textContent))
      .toEqual(['Show in iTerm2', 'Reattach in app', 'Close session']);
  });

  it('omits Reattach for a session that is already tmux-backed, and Show in host with no host', () => {
    const { container } = renderCompact({ tmux: true, host: null });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect([...container.querySelectorAll('.cardmenu-item')].map(b => b.textContent))
      .toEqual(['Close session']);
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['a click elsewhere', () => fireEvent.mouseDown(document.body)],
  ])('closes the menu on %s', (_label, act) => {
    const { container } = renderCompact();
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    expect(container.querySelector('.cardmenu-list')).not.toBeNull();
    act();
    expect(container.querySelector('.cardmenu-list')).toBeNull();
  });

  // Reuse, not a second implementation: Close opens the SAME confirm panel
  // the full card shows, naming the same session in the same words.
  it('routes Close session into the existing confirm flow, not straight to a kill', () => {
    const onKill = neverKill();
    const { container } = renderCompact({}, { onKill });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(container.querySelector('.kill-confirm')).not.toBeNull();
    expect(screen.getByText(/^End the Claude session in trellome/)).toBeTruthy();
    expect(onKill).not.toHaveBeenCalled();
    expect(container.querySelector('.cardmenu-list')).toBeNull();
  });

  it('routes Reattach in app into the existing confirm flow too', () => {
    const onReattach = neverReattach();
    const { container } = renderCompact({}, { onReattach });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Reattach in app' }));
    expect(container.querySelector('.reattach-confirm')).not.toBeNull();
    expect(onReattach).not.toHaveBeenCalled();
  });

  it('brings the host forward from the menu', () => {
    const onReveal = vi.fn(async () => {});
    renderCompact({}, { onReveal });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Show in iTerm2' }));
    expect(onReveal).toHaveBeenCalledWith(4242);
  });

  // Every control on this card is nested inside the card's own
  // role="button" wrapper, so each must stop its own click from also
  // opening the session -- the same rule .killrow and .reattachrow already
  // follow.
  it('never opens the session when the menu or one of its items is clicked', () => {
    const onOpen = vi.fn();
    renderCompact({}, { onOpen, onReveal: vi.fn(async () => {}) });
    fireEvent.click(screen.getByRole('button', { name: /session actions/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Show in iTerm2' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('still renders the full card by default, with nothing opted in', () => {
    const { container } = render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()}
      onReattach={neverReattach()} onResume={neverResume()} state={enrichedCompact} />);
    expect(container.querySelector('.card')!.classList.contains('compact')).toBe(false);
    expect(screen.getByText('/Users/me/trellome')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /session actions/i })).toBeNull();
  });
});
```

In `tests/renderer/SessionRail.test.tsx`, add a `beforeEach` that clears the store (`localStorage.clear(); reloadSettings();`) and append:

```tsx
describe('SessionRail -- compact cards', () => {
  it('renders compact cards by default, which is what the setting ships as', () => {
    const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
    expect(container.querySelectorAll('.card.compact').length).toBe(sessions.length);
  });

  it('renders full cards once the setting turns the sidebar off', () => {
    setSettings({ compactCards: 'fleet' });
    const { container } = render(<SessionRail sessions={sessions} selectedPid={null} onSelect={() => {}} onKill={noopKill} onReattach={noopReattach} onResume={noopResume} side="left" />);
    expect(container.querySelectorAll('.card.compact').length).toBe(0);
  });
});
```

In `tests/renderer/FleetView.test.tsx`, append inside the `Open sessions` describe:

```tsx
    it('renders compact cards by default, and full ones once the setting turns the fleet off', async () => {
      const { container, rerender } = render(<FleetView payload={payloadWithOpen} error={null} onSelect={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll('.fleet .card').length).toBeGreaterThan(0));
      expect(container.querySelectorAll('.fleet .card.compact').length)
        .toBe(container.querySelectorAll('.fleet > .card').length);

      setSettings({ compactCards: 'sidebar' });
      rerender(<FleetView payload={payloadWithOpen} error={null} onSelect={() => {}} />);
      expect(container.querySelectorAll('.fleet .card.compact').length).toBe(0);
    });
```

That file has no `payloadWithOpen`: it builds payloads with its own `payload(openSessions)` helper, and the open-sessions tier lives in the describe at `tests/renderer/FleetView.test.tsx:292`. Use `payload([...])` there in place of `payloadWithOpen`, and add the same `localStorage.clear(); reloadSettings();` `beforeEach` plus the `setSettings`/`reloadSettings` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/OpenSessionCard.test.tsx tests/renderer/SessionRail.test.tsx tests/renderer/FleetView.test.tsx`
Expected: FAIL. TypeScript rejects the unknown `compact` prop, and at runtime `expected false to be true` for `.card.compact`.

- [ ] **Step 3: Add the compact variant and the menu**

In `src/renderer/components/OpenSessionCard.tsx`, add to the props (after `unread?: boolean;`):

```tsx
  /** The tidier card David chose as the default (spec §3.6): provider,
   *  project, status, host, the unread dot and a `...` menu -- and nothing
   *  else. Which places use it is one setting with four values
   *  (src/renderer/state/settings.ts), read by SessionRail and FleetView,
   *  never here: this component renders what it is told to, so a single
   *  card can still be exercised either way in a test.
   *
   *  Optional and defaulted to false rather than required, so every
   *  existing call site keeps rendering exactly what it rendered before. */
  compact?: boolean;
```

and add `compact = false` to the destructure.

Add after the `reattachPhase` state block (around line 249):

```tsx
  // The `...` menu, compact cards only. A plain popover keyed to this one
  // card -- Escape, a click anywhere else, or choosing an item closes it.
  // Every item routes into a flow this card already has rather than a
  // second implementation of it: Close opens the same confirm panel the
  // full card shows, naming the same session in the same words.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    // mousedown, not click: a click listener registered during the very
    // click that opened this menu fires again as that same event finishes
    // bubbling to the window, closing the menu before it is ever seen.
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  // In compact mode the two idle buttons live in the menu instead -- but
  // every NON-idle state (both confirm panels, the status lines, the
  // stranded alert) renders exactly as it does on a full card.
  const showActions = !compact || phase !== 'idle' || reattachPhase !== 'idle';
```

Add the class to the article (line 319):

```tsx
      className={`card${compact ? ' compact' : ''} ${blocked ? 'attn' : showUnread ? 'unread' : state.activity === 'working' ? 'live' : ''}`}
```

In the `.crow` block, gate the process meta (line 334 and 343):

```tsx
        {(hostLabel || (!compact && procMeta)) && (
          <span className="crow-meta">
            {hostLabel && (onReveal
              ? <button type="button" className="host host-btn"
                  aria-label={`Show this session in ${hostLabel}`}
                  onClick={(e) => { e.stopPropagation(); void onReveal(state.pid); }}>
                  {hostLabel}
                </button>
              : <span className="host">{hostLabel}</span>)}
            {!compact && procMeta && <span className="procmeta">{procMeta}</span>}
          </span>
        )}
```

Gate the path (line 357), the last reply (lines 363-365) and swap the metrics row (lines 367-379):

```tsx
        <p className="proj display" title={state.project}>{state.project}</p>
        {!compact && <p className="path">{state.cwd ?? 'no working directory'}</p>}
      </div>

      {/* No fallback text (unlike SessionCard's "No output yet"): a blank
          last-message is honest on an ambiguous or unmatched card, where
          there is no session to say anything came from. Dropped entirely on
          a compact card -- it is the tallest thing on the card, and
          SessionCard.css clamps it to two lines regardless. */}
      {!compact && state.lastProse && (
        <p className={`said ${blocked ? 'wait' : ''}`}>{state.lastProse}</p>
      )}

      <div className="metrics">
        {/* The pid stays on the full card for now, gated like its siblings.
            Task 8 removes it from both cards and updates the test that asserts
            it; dropping it here would fail that test one task early. */}
        {!compact && <span className="pid">pid {state.pid}</span>}
        {!compact && state.events != null && <span>{state.events.toLocaleString()}</span>}
        {activityWord && (
          <span className={`state ${state.activity}`}>
            <span className="dot" aria-hidden="true" />
            {activityWord}
          </span>
        )}
        {compact && (
          <div
            className="cardmenu"
            ref={menuRef}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="cardmenu-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              // Named with the pid for the same reason the Close button is:
              // with several cards in the rail, a bare "Session actions"
              // would put indistinguishable buttons in the accessibility
              // tree, which is the one thing the rail exists to prevent.
              aria-label={`Session actions, pid ${state.pid}`}
              onClick={() => setMenuOpen(o => !o)}
            >
              <span aria-hidden="true">…</span>
            </button>
            {menuOpen && (
              <div className="cardmenu-list" role="menu">
                {hostLabel && onReveal && (
                  <button type="button" role="menuitem" className="cardmenu-item"
                    onClick={() => { setMenuOpen(false); void onReveal(state.pid); }}>
                    Show in {hostLabel}
                  </button>
                )}
                {reattachEligible && (
                  <button type="button" role="menuitem" className="cardmenu-item"
                    onClick={() => { setMenuOpen(false); setReattachPhase('confirming'); }}>
                    Reattach in app
                  </button>
                )}
                <button type="button" role="menuitem" className="cardmenu-item cardmenu-danger"
                  onClick={() => { setMenuOpen(false); setPhase('confirming'); }}>
                  Close session
                </button>
              </div>
            )}
          </div>
        )}
      </div>
```

`reattachEligible` is declared at line 236, above this block, so the menu can read it.

Gate the whole actions row and its two idle buttons. Change line 396 to:

```tsx
      {showActions && <div className="actionsrow">
```

change the idle Close button's guard (line 412) to `{phase === 'idle' && !compact && (`, change the idle Reattach button's guard (line 480) to `{reattachPhase === 'idle' && !compact && (`, and close the new conditional by replacing line 536 (`</div>` closing `.actionsrow`) with `</div>}`.

Finally gate the Codex explanation (line 541), which is prose, not a control:

```tsx
      {!compact && state.provider === 'codex' && (
        <p className="reattach-na">Reattach in app isn't available for Codex sessions yet.</p>
      )}
```

- [ ] **Step 4: Style the compact card and the menu**

Append to `src/renderer/components/OpenSessionCard.css`:

```css
/* The compact card (spec §3.6). Additive only: every rule here is scoped
   to .card.compact, so SessionCard.css's base .card/.proj/.said rules --
   which this component and the History card BOTH rely on globally -- keep
   the exact values they have today. A compact card does not render .said
   at all, so that stylesheet's 2-line clamp has nothing to clip here. */
.card.compact { padding:10px 12px 11px; gap:7px; }
.card.compact .proj { font-size:15px; }
.card.compact .badge { top:9px; right:11px; }
.card.compact .unread-dot { top:12px; right:14px; }
.card.compact .metrics { margin-top:0; }
/* .state carries margin-left:auto in SessionCard.css, which would push the
   status to the far right and strand the menu beyond it. On a compact card
   the menu is what claims that edge. */
.card.compact .state { margin-left:0; }

/* The `...` menu. A popover anchored to this one card, not a shared
   overlay: .cardmenu is the positioned ancestor, so nothing here needs to
   know where on screen the card is. */
.cardmenu { position:relative; margin-left:auto; }
.cardmenu-btn { font-family:var(--f-mono); font-size:13px; line-height:1; color:var(--muted);
  background:none; border:1px solid transparent; border-radius:6px;
  padding:1px 6px 3px; cursor:pointer; }
.cardmenu-btn:hover { color:var(--ink); border-color:var(--line); }
.cardmenu-list { position:absolute; right:0; top:calc(100% + 4px); z-index:5;
  display:flex; flex-direction:column; min-width:150px;
  background:var(--surface); border:1px solid var(--line); border-radius:var(--r-sm);
  box-shadow:var(--shadow-pop); padding:4px; }
.cardmenu-item { text-align:left; font-family:var(--f-mono); font-size:11px; color:var(--ink-2);
  background:none; border:0; border-radius:5px; padding:6px 9px; cursor:pointer; white-space:nowrap; }
.cardmenu-item:hover { background:var(--raised); color:var(--ink); }
/* Close is the one destructive item, and it still only opens the confirm
   panel -- the colour marks which item it is, not what pressing it does. */
.cardmenu-danger:hover { color:var(--critical); }
```

- [ ] **Step 5: Read the setting in the two places that show cards**

In `src/renderer/components/SessionRail.tsx`, add:

```ts
import { compactIn, useSettings } from '../state/settings.ts';
```

add inside the component, next to the other state:

```tsx
  // Which places use compact cards is one setting with four values, so
  // "Both on but Fleet off" is not a state that can exist -- the rail reads
  // its own half of it and nothing more.
  const compact = compactIn(useSettings(), 'sidebar');
```

and pass it (line 217):

```tsx
              <OpenSessionCard state={s} onOpen={onSelect} onKill={onKill} onReveal={onReveal}
                onReattach={onReattach} onResume={onResume} unread={unread} compact={compact} />
```

In `src/renderer/components/FleetView.tsx`, add the same import, add inside the component (above the early returns, so hook order is stable):

```tsx
  const compact = compactIn(useSettings(), 'fleet');
```

and pass it (line 117):

```tsx
            <OpenSessionCard key={o.pid} state={o} onOpen={onSelect} onKill={fleetApi.killSession}
              onReveal={fleetApi.revealSession} onReattach={fleetApi.reattach} onResume={fleetApi.resume}
              compact={compact} />
```

`useSettings` must be called before `if (!window.fleet)` and the other early returns in `FleetView`, alongside the two existing `useState`/`useEffect` calls — they already sit above those returns, so this goes with them.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/OpenSessionCard.test.tsx tests/renderer/SessionRail.test.tsx tests/renderer/FleetView.test.tsx tests/renderer/MainPane.test.tsx tests/renderer/SessionRail.css.test.ts tests/renderer/ConversationView.css.test.ts`
Expected: PASS, all tests. The last one confirms the new `cardmenu*` classes still share no name with the conversation stylesheet.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/OpenSessionCard.tsx src/renderer/components/OpenSessionCard.css src/renderer/components/SessionRail.tsx src/renderer/components/FleetView.tsx tests/renderer/OpenSessionCard.test.tsx tests/renderer/SessionRail.test.tsx tests/renderer/FleetView.test.tsx
git commit -m "feat(cards): a compact card by default, with its actions behind a menu"
```

---

### Task 8: The Claude logo, and the pid off the cards

**Files:**
- Modify: `src/renderer/components/ProviderMark.tsx:9-12`
- Modify: `src/renderer/components/OpenSessionCard.tsx:306-315` (the accessible name), `:367-372` (the pid line)
- Modify: `src/renderer/components/OpenSessionCard.css:14-17` (the `.pid` rule)
- Test: `tests/renderer/ProviderMark.test.tsx`, `tests/renderer/OpenSessionCard.test.tsx`

**Interfaces:**
- Consumes (Task 7): the compact card and its menu.
- Produces: no signature change. `ProviderMark`'s `claude` path becomes the Claude glyph; `OpenSession.pid` is still used for every callback and every nested control label, and is no longer rendered or announced as part of the card itself.

The visible pid goes and the card's accessible name loses it; the nested control labels keep it. See "Spec decisions this plan resolves" above for why, and what it would cost to reverse.

- [ ] **Step 1: Write the failing tests**

In `tests/renderer/ProviderMark.test.tsx`, replace the first test with:

```tsx
  // Simple Icons' `claude` glyph (CC0), the same source this file already
  // cites for the Codex mark -- not the Anthropic wordmark A that used to
  // stand in for it. The conversation pane marks every agent turn with
  // this, so it is the app's most-rendered glyph.
  it('renders the Claude glyph for claude, not the Anthropic wordmark', () => {
    const { container } = render(<ProviderMark provider="claude" />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).toMatch(/^m4\.7144 15\.9555/);
    expect(d).not.toMatch(/^M17\.3041 3\.541/);
  });
```

In `tests/renderer/OpenSessionCard.test.tsx`, change the first test (line 43) to drop the pid expectation and pin its absence:

```tsx
  it('shows provider, project, cwd, host, age and memory even with no transcript match at all', () => {
    render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={base} />);
    expect(screen.getByText('trellome')).toBeTruthy();
    expect(screen.getByText('/Users/me/trellome')).toBeTruthy();
    expect(screen.getByText('Claude')).toBeTruthy();
    expect(screen.getByText('iTerm2')).toBeTruthy();
    expect(screen.getByText(/9d/)).toBeTruthy();
    expect(screen.getByText(/206 MB/)).toBeTruthy();
    // Gone from every card (spec §2). It was bookkeeping, and the app
    // already knows which process a card is without printing it.
    expect(screen.queryByText(/pid 4242/)).toBeNull();
  });
```

and change the accessible-name test (line 129) to:

```tsx
    it('includes project, provider, activity and last prose in the accessible name, and no pid', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={enriched} />);
      const card = screen.getByRole('button', { name: /trellome/i });
      const label = card.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/Claude/);
      expect(label).toMatch(/working/);
      expect(label).toMatch(/Reused the JWT helper/);
      expect(label).not.toMatch(/pid/i);
    });

    // The nested controls keep it, and must: with two cards open, "Close"
    // and "Close" are indistinguishable in a screen reader's rotor or a
    // test's own lookup, and two sessions can share a project name. This
    // is a different string from the card's own name, on a different
    // element, and it is the only thing telling those buttons apart.
    it('keeps the pid on the nested controls, which have nothing else to tell them apart', () => {
      render(<OpenSessionCard onOpen={() => {}} onKill={neverKill()} onReattach={neverReattach()} onResume={neverResume()} state={enriched} />);
      expect(screen.getByRole('button', { name: 'Close, pid 4242' })).toBeTruthy();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/ProviderMark.test.tsx tests/renderer/OpenSessionCard.test.tsx`

Expected: FAIL. `ProviderMark.test.tsx`: `expected 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm…' to match /^m4\.7144 15\.9555/`. `OpenSessionCard.test.tsx`: `expected null not to be null` for the pid text, and `expected 'Open trellome (Claude), pid 4242. working…' not to match /pid/i`.

- [ ] **Step 3: Swap the glyph**

In `src/renderer/components/ProviderMark.tsx`, replace the `claude` entry of `PATHS` with the Claude glyph. The value below is `simple-icons`' `claude.svg` path verbatim (CC0), fetched 2026-09-15:

```ts
  claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246-1.4146-2.1674-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
```

Update the file's doc comment so it still describes what is there:

```ts
/** Official single-path brand glyphs from Simple Icons (CC0). Rendered
 *  monochrome so they inherit the surrounding colour and invert correctly
 *  between themes with no second asset.
 *
 *  `claude` is the Claude mark, not the Anthropic wordmark that used to
 *  stand in for it: it identifies a SESSION's CLI, and it is what the
 *  conversation pane puts above every agent turn in place of the word
 *  "agent" (spec 2026-09-15-conversation-pane-design.md §2). Codex is
 *  unchanged.
 *
 *  The trademarks remain Anthropic's and OpenAI's; these identify which
 *  provider a session belongs to and nothing more. */
```

- [ ] **Step 4: Take the pid off the card**

In `src/renderer/components/OpenSessionCard.tsx`, replace the accessible-name comment and array (lines 301-315) with:

```tsx
  // Same reasoning as SessionCard's label: role="button" replaces this
  // element's content with its accessible name, so every signal rendered
  // below has to be carried in the name too.
  //
  // The pid is NOT here any more (spec §2: no pid on any card). It was
  // never a signal a person acts on -- it was bookkeeping for the close
  // action, which the code performs from `state.pid` regardless. The
  // NESTED controls (Close, Reattach, the compact menu) do keep it, and
  // must: those are otherwise-identical buttons repeated once per card,
  // and two open sessions can share a project name.
  const label = [
    `Open ${state.project} (${providerLabel})`,
    activityWord,
    // Placed right after activityWord, before lastProse -- "there is new
    // output" is a fact about the session's state, the same category as
    // activityWord, not part of what it actually said.
    showUnread ? 'New output since you last looked' : null,
    state.lastProse,
    hostLabel ? `Running in ${hostLabel}` : null,
  ].filter((part): part is string => Boolean(part)).join('. ');
```

and delete the pid span Task 7 left gated on the full card (the `{!compact && <span className="pid">pid {state.pid}</span>}` line in the metrics row), leaving:

```tsx
      <div className="metrics">
        {!compact && state.events != null && <span>{state.events.toLocaleString()}</span>}
```

In `src/renderer/components/OpenSessionCard.css`, delete the `.pid` rule and its comment (lines 14-17). Nothing else references that class.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/ProviderMark.test.tsx tests/renderer/OpenSessionCard.test.tsx tests/renderer/ConversationView.test.tsx tests/renderer/SessionRail.test.tsx tests/renderer/FleetView.test.tsx tests/renderer/MainPane.test.tsx`
Expected: PASS, all tests. The conversation tests are included because the agent's meta line renders this exact glyph.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/ProviderMark.tsx src/renderer/components/OpenSessionCard.tsx src/renderer/components/OpenSessionCard.css tests/renderer/ProviderMark.test.tsx tests/renderer/OpenSessionCard.test.tsx
git commit -m "feat(cards): the Claude mark in place of the Anthropic one, and no pid on any card"
```

---

### Task 9: Verification — the controller and David, not an implementer

**This task is not an implementer's.** Tasks 1 to 8 each end green on their own files; this one runs the whole suite, then puts the app in front of David. A green suite is permission to look, not proof — part 1's worst bug was invisible to 905 passing tests and three rounds of review, and David found it by using the app.

**Files:** none. Nothing here changes code. A FAIL goes back to the task that owns it.

**Interfaces:**
- Consumes: Tasks 1 to 8.
- Produces: a recorded PASS/FAIL for every check below, and a decision on the two rulings in "Spec decisions this plan resolves".

- [ ] **Step 1: Stop the dev app before running anything**

The native database module has to be built one way for Electron and another for Node, so the app and the suite cannot both run. If `npm run dev` is up, stop it first. (Part 1 lost two restarts to this; the order is: eyes-on, stop the app, build and test, restart.)

- [ ] **Step 2: Full suite and typecheck**

Run: `npm run typecheck && npm test`

Expected: typecheck exits 0. Every test file passes. The count is 906 (part 1's total) plus everything Tasks 1 to 8 added, and none fail. If the count is short with "Worker exited unexpectedly", that is the known Node 24 / better-sqlite3 GC bug — rerun `npx vitest run tests/fleet/state.test.ts` on its own rather than treating it as a failure.

- [ ] **Step 3: Confirm the two structural constraints directly**

Run:

```bash
grep -rn "from 'node:\|require('node:\|from '\.\./\.\./main/" src/renderer | grep -v "import type" || echo "renderer clean"
```

Expected: the output ends with `renderer clean`. A value import of `node:*` or of anything under `src/main/**` blanks the window at runtime with no error a test would see; only a type import is safe.

- [ ] **Step 4: Restart the app**

Run: `npm run dev` (its `predev` step rebuilds the native module for Electron). Wait for `starting electron app...`.

- [ ] **Step 5: Eyes-on with David — spec §6**

Work through each with David watching the window. Record PASS/FAIL and what was actually seen.

1. **Live, mid-reply.** Open a session that is mid-reply. **Expect:** the pane shows new text as it arrives; scrolled to the bottom it follows, and scrolled up it stays put and offers **Jump to latest**, which lands at the newest message.
2. **Older pages.** Scroll to the top of a long session. **Expect:** older messages load above and the view does not jump — the message under the cursor stays under the cursor. Keep going until "Beginning of this session's recorded conversation."
3. **One line and three.** Send a single-line message and a three-line one (Shift+Enter for each break). **Expect:** each arrives in the session as exactly ONE message, not as a first line followed by the rest run as separate prompts. This is the check that cannot be faked by a test: every test here mocks tmux.
4. **A choice is open.** With a question or a permission prompt on screen, try to send. **Expect:** refused, with the popover's own wording and an **Open Terminal** button that switches the pane. Nothing is typed into the session.
5. **Settings persist, and reach the chrome.** Change all four settings; quit and reopen the app. **Expect:** all four survive. Light and Dark change the window chrome — the title bar, native scrollbars and the folder picker — not just the page, and launching straight into Light shows no dark flash on the first frame.
6. **Cards, both places, narrow.** Compare compact and full cards in the fleet and in the rail, and drag the rail down to its 140px minimum. **Expect:** nothing overflows the card border, the `...` menu opens and closes (Escape, a click elsewhere, choosing an item), and Close from the menu opens the same confirm panel the full card shows.

Two more worth a look while the app is open, because they are where this work touches a path part 1 made reachable:

7. **The conversation header** shows the session's full folder path, with the whole value on hover.
8. **A session that is not tmux-backed** shows the message box disabled with a reason, never hidden.

- [ ] **Step 6: Put the two rulings in front of David**

Both are recorded in "Spec decisions this plan resolves" at the top of this plan, with what reversing each would cost. Neither needs a decision to ship, but David should see them rather than discover them:

1. Main keeps one mirrored file (`~/.llm-workspace/appearance.json`) holding only the appearance value, because `backgroundColor` is fixed before the renderer exists.
2. The pid is off every card's face and out of the card's accessible name, but the Close / Reattach / menu buttons still carry `pid N`, because two open sessions can share a project name.

- [ ] **Step 7: Record the outcome**

Write the PASS/FAIL list into the final report, with what was seen for each. Do not mark the plan done on a green suite alone.
