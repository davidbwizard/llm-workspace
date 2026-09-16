# Conversation Pane (design)

**Date:** 2026-09-15
**Status:** design, for David's review. No implementation plan yet.
**Part of:** the four-part sequence agreed on 2026-09-15. Part 1 (exact session
identity) is merged (`eb14bbd`); this is part 2. Parts 3 (launch into iTerm) and
4 (question and trust cards) follow.
**Mockup (approved by David):** https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz
**Binding spec:** `2026-09-10-llm-workspace-design.md` §10 (UI) and §11 (security).
**Read first:** `2026-09-15-part-1-handoff.md`.

---

## 1. What this delivers

The conversation stops being a read-only catch-up list and becomes the place
David talks to a session.

- **Readable.** 16px text by default (13px today), the name and time on one line
  above each message, and the agent marked with the Claude logo instead of the
  word "agent".
- **Chat order.** Oldest at the top, newest at the bottom, with the message box
  underneath. Opening a session lands on the latest message.
- **Live.** New messages appear while the pane is open. Today the pane fetches
  once on mount and never updates.
- **Answerable.** A message box under the conversation, for any tmux-backed
  session, including multi-line messages.
- **Tidier fleet.** Compact session cards by default, no pid anywhere, and the
  folder path moved into the conversation header.
- **Settable.** A gear beside Launch opens a settings window: appearance
  (System, Light, Dark), conversation text size (14 to 17), message style (A or
  C), and compact cards (Off, Sidebar, Fleet, Both).

Out of scope, listed in §8.

## 2. Decisions already made with David

From the mockup session on 2026-09-15, all confirmed by David against rendered
options:

| Decision | Value |
|---|---|
| Text size | 16px default, choosable 14 to 17 |
| Message style | A (accent rule down the agent's replies) default; C (your messages in a neutral bubble on the right) offered |
| Whose message is accented | The agent's. Never the user's. |
| Agent label | The Claude logo, in the accent colour, not the word "agent" |
| Name and time | One mono line above the message text |
| Order | Oldest at top, newest at bottom, message box underneath |
| Cards | Compact by default, in both places; setting Off / Sidebar / Fleet / Both |
| pid | Removed from every card |
| Folder path | Conversation header always; full cards keep it; compact cards drop it |
| Settings | A modal from a gear next to Launch; background scroll locked while open |
| Question layout (part 4) | All questions on one card (recorded here so part 4 does not re-ask) |

## 3. Design

### 3.1 Reading order: reverse at the source, not in the view

`conversationFor` (`src/store/conversation.ts:95`) returns turns newest-first,
and within a stretch it pushes the assistant reply before its own prompt
(`:145-155`). The view renders that array top to bottom.

**Change:** `conversationFor` returns each page **oldest-first, prompt before
reply**, while the paging contract stays exactly as it is: `before` still means
"the page older than this cursor", and `nextCursor` still names the oldest
prompt of the page. Only the array's order changes, plus the date-grouping walk
in the view.

Why here and not a `.reverse()` in the renderer: the page is assembled by a
stretch loop that already knows prompt-to-reply pairing, so emitting in
conversation order is a smaller change than re-deriving it downstream, and
every consumer wants the same order.

Tests that pin the old order (`tests/store/conversation.test.ts:147`,
`tests/renderer/ConversationView.test.tsx:118`) are rewritten to pin the new
one. The "reply and steps never split across a page boundary" test
(`conversation.test.ts:175`) must keep passing unchanged.

### 3.2 Scrolling: land at the bottom, grow upward without jumping

- On open, the pane scrolls to the bottom before first paint (a layout effect,
  not a timer).
- **Loading older messages prepends.** Before prepending, record
  `scrollHeight`; after, set `scrollTop += scrollHeight_after - scrollHeight_before`.
  That keeps the reader's eye on the same message. This replaces today's
  append-only trick (`ConversationView.tsx:189`), which exists precisely
  because older content used to go below.
- **The load-more trigger moves to the top edge.** `nearOlderEdge` (exported,
  four unit tests at `ConversationView.test.tsx:381-396`) becomes
  `nearOlderEdge({ scrollTop }, threshold = 150) => scrollTop < threshold`.
  Keep the name, the export, and the "measure numbers, not a live element"
  shape, because jsdom computes no layout.
- **Sticky bottom.** New messages scroll the pane down only when the reader is
  already within 80px of the bottom. Otherwise the view stays put and a
  **Jump to latest** button appears above the message box, as in the mockup.

### 3.3 Live updates: refetch on the signal the app already pushes

No conversation data is pushed today; `fleet:update` carries open-session cards
only (`src/main/ipc.ts:1163`), including `events`, a per-session monotonic
count.

**Change:** MainPane passes the selected session's `events` count to
`ConversationView`. When it changes, the view fetches the **newest page only**
(no cursor) and merges: new turns are appended at the bottom, and a turn whose
id already exists is replaced in place, because the last assistant turn grows as
the reply streams. Older loaded pages stay where they are.

Why not a new push channel carrying turns: `events` already changes on exactly
the transitions that matter, the push already runs coalesced at 250ms for
watcher writes, and this keeps conversation data on the request/response path
where the cursor logic lives. If measurement later shows the refetch is too
heavy on a 2,800-turn session, the fallback is a `since` cursor on
`session:conversation`, not a new channel.

**Bounded work:** a refetch is one keyset query for 50 exchanges, the same
query the pane already runs on open (measured at most 6.6ms on the busiest real
session during part 1).

### 3.4 The message box

Under the conversation, always visible for a tmux-backed session.

- **Sends through the existing path:** `window.fleet.sendKeys(pid, text)` →
  `sendKeysFor` (`src/main/ipc.ts:719`). `ConversationView` therefore needs the
  session's `pid` and `tmux` flag threaded from MainPane, which has both.
- **Refusals reuse part 1's rules**, including `prompt_open` (a choice is open)
  and `not_tmux`. The box shows the same wording the popover uses, and for
  `prompt_open` it offers the same **Open Terminal** action.
- **Multi-line is allowed**, which today's sanitiser refuses
  (`contains_newline`, `src/main/outbound.ts:10`). The reason for that refusal
  is real: `send-keys -l` types the text, and a newline submits early, so a
  two-line message would send its first line and then run the rest as a second
  prompt.

  **Change:** multi-line text is delivered as a **bracketed paste** instead of
  literal keystrokes: `tmux load-buffer` into a private buffer, then
  `paste-buffer -p -d`, then `send-keys Enter`. This is the same mechanism that
  was measured working for image paths on 2026-09-15: Claude Code receives a
  bracketed paste as one message and does not submit on the embedded newlines.
  Single-line text keeps today's `send-keys -l` path unchanged.

  `sanitizeOutbound` keeps every other rule (non-empty, 4,000 character cap,
  control-character stripping) and gains a `multiline` allowance used only by
  the paste path. The newline refusal stays for the keystroke path.
- **Keys:** Enter sends, Shift+Enter adds a line. A send clears the box.
- **What the box is not:** it does not answer choices. Part 1's guard stands.

### 3.5 Appearance, size and style settings

A settings modal, opened by a gear button in `LaunchBar` beside Launch.

- **Appearance:** System (default), Light, Dark. The renderer sets
  `data-theme` on `document.documentElement` (already supported by
  `theme.css:97`), and asks main to set Electron's `nativeTheme.themeSource` to
  the same value over a new `app:theme` channel, so native scrollbars, the
  folder picker and the title bar match. `src/main/index.ts:47` hardcodes a dark
  `backgroundColor`; it reads the stored choice at startup so a light user does
  not get a dark flash.
- **Conversation text size:** 14, 15, 16 (default), 17. Applied as a CSS
  variable on the conversation root, with every message-level size in
  `ConversationView.css` expressed relative to it (`em`, or `calc()` off the
  variable). Meta lines, code blocks and steps scale with it.
- **Message style:** A (default) or C, applied as a `data-style` attribute on
  the conversation root.
- **Compact cards:** Off, Sidebar, Fleet, Both (default). One setting with four
  values rather than two booleans, so "Both on but Fleet off" cannot happen.
- **Storage:** a new `src/renderer/state/settings.ts`, the first shared
  per-viewer store. It follows `SessionRail`'s existing pattern exactly: one
  `llmws:` namespaced key (`llmws:settings`), a JSON object, every read wrapped
  in try/catch, every value validated against its allowed set with a fallback to
  the default, and a write that swallows errors. The rail's own
  `llmws:rail-width` key stays where it is; this store does not absorb it.
- **Modal behaviour:** a native `<dialog>` with `showModal()`; Escape, a close
  button, a Done button and a backdrop click all close it. While it is open,
  the page and the conversation do not scroll, and scrolling inside the modal
  does not chain out. Focus returns to the gear on close.

### 3.6 Cards

- **Compact card:** provider logo and name, project name, status (working,
  idle, waiting on you), the host button (iTerm2, VS Code), the unread dot, and
  a `...` menu holding Show in host, Reattach in app, and Close session.
- **Full card:** today's card minus the pid line, keeping path, last reply,
  age, memory, event count, and the visible Close and Reattach buttons.
- **The `...` menu** is a plain popover keyed to one card, closed by Escape, a
  click elsewhere, or choosing an item. It reuses the existing confirm flows
  rather than duplicating them: choosing Close opens the same confirm panel the
  full card shows.
- **The accessible name** of a card keeps every signal it carries today
  (`OpenSessionCard.tsx:306`), with pid dropped and the host and status kept.
- **The Claude logo** replaces the Anthropic glyph in `ProviderMark.tsx`. The
  new path comes from Simple Icons (CC0), the same source the file already
  cites; Codex is untouched.

### 3.7 Conversation header

The pane header shows the session's **folder path** (full, with a `title` for
the untruncated value) instead of the project name, since the rail already
names the project. The Conversation and Terminal buttons and the All sessions
button stay as they are.

## 4. What the user sees change

| Before | After |
|---|---|
| 13px text, name and time in a 56px left gutter | 16px text, one mono line above each message |
| Newest at top, scroll down for older | Oldest at top, newest at the bottom |
| Pane never updates once open | New messages appear as they arrive |
| No way to reply from the conversation | Message box under the conversation, multi-line allowed |
| Cards show pid, path, last reply, metrics | Compact by default: logo, project, status, host, `...` |
| Theme follows macOS only | System, Light or Dark, and the window chrome follows |

## 5. Security notes

- **No new trust boundary.** The message box reuses `session:keys`, which
  already validates the pid, sanitises the text and refuses a session that is
  not tmux-backed or has a choice open.
- **The paste path is still sanitised.** Control characters are stripped and
  the 4,000 character cap applies before the text reaches `load-buffer`. The
  buffer name is chosen by the app, never by the text, and the buffer is
  deleted after pasting (`-d`).
- **Bracketed paste does not execute anything.** It delivers text to the
  foreground program, which is why the newline refusal can be relaxed only on
  this path.
- **`app:theme` carries one of three literal values**, validated in main
  before it reaches `nativeTheme`.
- **No new data crosses IPC to the renderer**: `events` already does, and the
  settings live entirely in the renderer.

## 6. Testing

**Automated (vitest, existing infrastructure):**

- `conversationFor`: pages are oldest-first with prompt before reply; the
  cursor contract, the page-boundary rule and the tie-break tests keep passing
  with the new order.
- `nearOlderEdge`: fires near the top, not the bottom.
- `ConversationView`: renders in conversation order; prepends an older page and
  restores scroll position (jsdom has no layout, so the scroll math is unit
  tested as numbers, as today); refetches when `events` changes and merges
  without duplicating; replaces a grown last turn in place; sticky-bottom
  behaviour and the Jump to latest button; the message box sends through
  `sendKeys`, shows each refusal, and offers Open Terminal on `prompt_open`;
  Shift+Enter inserts a newline rather than sending.
- `sanitizeOutbound`: the multiline allowance applies only to the paste path;
  every other rule unchanged; a control character is still stripped.
- `sendKeysFor`: a multi-line message uses `load-buffer` + `paste-buffer -p -d`
  + `Enter`, in that order, and never `send-keys -l` with a newline.
- Settings store: unknown values fall back to defaults; a corrupt JSON blob is
  ignored; writes never throw.
- Cards: compact and full variants render the documented fields; no card
  renders a pid; the `...` menu opens, closes on Escape and outside click, and
  its Close item reaches the same confirm flow.
- Theme: `data-theme` is applied from the stored choice; the token-set
  equality test (`tests/renderer/theme.test.ts:76`) still passes.
- The class-isolation test (`ConversationView.css.test.ts:95`) keeps passing:
  the conversation stylesheet shares no class name with the card stylesheets.

**In the real app (a green suite is permission to look, not proof):**

1. Open a session mid-reply: the pane shows new text as it arrives, and stays
   put when scrolled up, with Jump to latest offered.
2. Scroll to the top of a long session: older messages load and the view does
   not jump.
3. Send a single-line message and a three-line message; both arrive as one
   message each.
4. Try to send while a question is open: refused, with Open Terminal offered.
5. Change every setting; reopen the app; they persist. Light and Dark change
   the window chrome, not just the page.
6. Compact and full cards, in the fleet and in the rail, at a narrow rail width.

## 7. Questions David settled (2026-09-15)

1. **A session with no live process** still shows the message box, disabled,
   with "This session is not running". It is never hidden: a box that vanishes
   reads as a missing feature, a disabled one reads as a state.
2. **Enter sends, with no confirmation,** however long the message.
3. **The rail's Answer popover stays.** It answers a session David is not
   currently looking at, which the conversation's own box cannot do.

## 8. Out of scope

- **Image attachment.** Measured working on 2026-09-15 via bracketed paste of
  a file path, and shown in the mockup, but it needs a drop target, a paste
  handler, thumbnails and a place to store pasted screenshots. It is its own
  small part after this one.
- **Question and trust cards.** Part 4.
- **Launching into iTerm.** Part 3.
- **History cards remain unclickable.** Selection is pid-keyed and a transcript
  session has no pid (`FleetView.tsx:164`); fixing it needs a different
  selection shape.
- **History matching stays cwd-only,** so a same-folder pair can read as
  ambiguous there and unique in the rail. Carried from part 1.
