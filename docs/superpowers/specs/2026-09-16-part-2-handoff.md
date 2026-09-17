# Part 2 handoff: the conversation pane

Merged to `main` as `e0af1b8` on 2026-09-16. 38 commits. Full suite on the
merged result: 1104/1104, typecheck clean.

Plan: `docs/superpowers/plans/2026-09-15-conversation-pane.md`
Spec: `docs/superpowers/specs/2026-09-15-conversation-pane-design.md`
Design artifact (the visual source of truth, see below):
https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz

---

## What shipped

The conversation is no longer a read-only catch-up list. It is where David
talks to a session.

- **Chat order.** Oldest at the top, newest at the bottom, the pane lands at
  the bottom on open, older pages prepend without the view jumping, and a
  sticky bottom follows new text unless the reader has scrolled away, in which
  case it offers Jump to latest.
- **Live updates**, driven by the per-session `events` count already carried on
  every `fleet:update`. No new IPC channel.
- **A message box** that sends multi-line text as a tmux bracketed paste.
  Drafts survive a session switch and survive Open Terminal. A character
  counter appears at 3,600 of 4,000 and turns to "N over" past the cap.
- **A settings panel** behind a gear: appearance, conversation text size,
  message style, compact cards. Four per-viewer preferences under one
  `llmws:settings` key. Appearance also reaches the window chrome via
  `nativeTheme.themeSource`, with the choice mirrored to
  `~/.llm-workspace/appearance.json` so a light user gets no dark first frame.
- **Compact cards** by default in both the rail and the fleet, with actions
  behind a `...` menu and the message text clamped to three lines.
- **The Claude mark** in place of the word "agent", and no pid on any card
  face. The nested control labels (`Close, pid N` and friends) keep theirs, so
  assistive tech can tell otherwise-identical buttons apart.

### Fixes that were not in the plan

Every one of these came from David using the app. None was caught by the suite.

- The **empty footer** was the document itself scrolling. `html, body, #root`
  now carry `overflow:hidden`; a desktop app shell should never scroll.
- **History markers at the wrong end** -- "Beginning of this session's recorded
  conversation" rendered below the newest message, and short conversations
  floated at the top instead of sitting above the message box.
- **A card menu painting under the next card.** `.card:hover` applies a
  `transform`, which creates a stacking context, trapping the popover's
  z-index inside the card. Fixed by raising the whole card while its menu is
  open.
- **Messages hidden behind a steps toggle.** See "no collapse" below.
- **Multi-line sends silently lost** to a race between the paste and the Enter.
- **Rejected fetches** were unhandled at all three call sites.
- **The window controls** colliding with the launch row.

---

## Known issues

`KNOWN_ISSUES.md` at the repo root is new, and is where these live now.

### Multi-line messages do not submit in Codex

**The one thing to fix first.** A multi-line message to a Codex session lands
in its input and is never submitted, while the app reports success and clears
the box. Claude Code is unaffected.

`sendKeysFor` (`src/main/ipc.ts`) is not provider-aware: Claude and Codex get
the identical `load-buffer` / `paste-buffer -p -d` / `send-keys Enter`
sequence, and that sequence has only ever been measured against Claude Code.

Why the Enter does not submit is **not known**. Do not guess -- measure a real
Codex session: what it does with a bracketed paste, whether it requests mode
2004 at all, and what key actually submits after a multi-line paste.

Workaround: single-line messages to Codex take the keystroke path and work.

### Smaller, documented in code

- **The stale-restore bounce.** Going s1 to s2 and back while an older-page
  fetch is in flight arms a stale scroll restore, so the returning pane never
  lands at the bottom. Not reachable by hand (the bounce must happen inside a
  ~6.6ms query plus an IPC hop). The fix is a monotonic fetch-epoch ref, about
  three lines, and it also retires a parked finding. Documented on
  `sessionIdRef` in `ConversationView.tsx`. **Do this first in part 3** -- that
  file is open anyway.
- **Changing text size or message style loses the reader's place.** The layout
  effect is keyed on `page` alone and never fires on a reflow. The comment
  there records the real fix and warns that adding the settings to that
  effect's dependency array is a no-op.
- **The paste settle can false-positive on a busy session.** It waits for the
  captured pane to change, and the capture includes Claude Code's footer
  spinner, so a busy session can satisfy it immediately. Degrades to pre-fix
  behaviour rather than regressing.

---

## The design artifact is the source of truth

David designs this app's UI as published Claude artifacts and screenshots them.
When he says "just like the artifact", there is a real one with real CSS.
**Read it rather than inferring from a picture** -- doing so settled six corner
radii that had been wrong, including a full pill where the design had a 9px
rounded rectangle.

The Conversation Pane Mockup also contains designs for things not yet built:
a composer with Send and attach buttons, image attach (dropzone, chips,
thumbnails), and prompt cards for questions, command permission, plan approval
and folder trust.

### Backlog: 15 places the conversation diverges from it

Full list in the plan's workspace report. David's triage: **day dividers are
nice to have**, the rest untriaged. The ones with real impact:

| # | What |
|---|---|
| 15 | No day divider exists; the app puts the date in the meta line instead |
| 1 | No `max-width:72ch` on message text, so it runs the full width of a wide window |
| 8 | The provider glyph is hardcoded `size={13}` and does not scale with text size |
| 2 | Style A never pads the user's turn to align with the agent's ruled edge |
| 4 | Turn spacing is 16px against the artifact's 22px |

Two need a decision rather than a fix, because the artifact contradicts the
spec: whether the meta line scales with text size (spec section 3.5 says yes,
the artifact fixes it at 12px), and whether table headers dim inside a user
turn now that user text is the quieter side.

---

## Next

1. **The Codex submit bug.** Measure, then fix. It is the only thing here that
   loses a user's message.
2. **Part 3: iTerm launch.** No spec yet.
3. **Part 4: prompt cards.** The app detects a waiting session and refuses to
   type into it, but cannot yet render or answer the prompt -- you always
   answer in the terminal. The artifact designs all of it.
4. **David's two standing requests**, both designed in the artifact:
   copy output/code, and showing local images in the conversation. For images,
   do NOT relax the CSP to allow `file:`; read the file in main, validate it is
   an image inside an allowed root, and hand the renderer a `data:` URI, which
   the existing policy already permits.

---

## Things worth knowing before touching this

- **Superseded 2026-09-17:** since better-sqlite3 13 (a Node-API addon whose one
  binary loads in Node and Electron), the app and the suite run side by side with no
  rebuild. The note below is kept for history.
- **The app and the test suite cannot both run.** better-sqlite3 has to be
  built for Electron for the app and for Node for the suite. Order: eyes-on,
  stop the app, build and test, restart.
- **Stopping the app is not what it looks like.** Killing `npm run dev` or
  `electron-vite` leaves the Electron window running, orphaned. Verify with
  `pgrep -fl "MacOS/Electron"` and a free port 5173, not with the wrapper.
- **Full-suite runs orphan vitest workers.** One left six holding 5.6 GB.
  Sweep between runs. `tests/fleet/state.test.ts` crashing with "Worker exited
  unexpectedly" is a known Node 24 / better-sqlite3 GC flake -- it reproduces
  when stale workers are around and passes after a sweep.
- **jsdom computes no layout and no paint.** Every visual bug on this branch was
  found by David in the running window while the suite was green. A green suite
  on a rendered surface means go and look.
- **Renderer safety.** A value import of `node:*` or `src/main/**` from
  `src/renderer/**` blanks the whole window with no error any test catches.
- **The control-character stripping in `src/main/outbound.ts` is load-bearing
  for security**, not hygiene. It removes ESC and 8-bit CSI, which is the only
  reason a crafted message cannot terminate its own bracketed paste and run the
  remainder as live keystrokes. It reads like tidiness. It is not.
