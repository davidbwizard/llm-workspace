# Handoff: Part 2 follow-ups (2026-09-16 evening to 2026-09-17)

Everything below is merged to `main` and pushed. No open branches.

## What shipped

| Merge | What |
|---|---|
| `43b984a` | The app lists the session it was launched from. Discovery used `pgrep -x`, which hides the caller's own ancestors; it now enumerates with `ps -axo pid=,comm=`. |
| `f9ad4e2` | A pane in tmux copy-mode (one mouse-wheel scroll) swallowed the Enter. `sendKeysFor` now leaves copy-mode first. |
| `298921f` | Codex ignored the Enter sent right behind `send-keys -l` text (its paste-burst heuristic). Every message now goes out as a bracketed paste. |
| `4d6f049` | Day dividers in the conversation. |
| `ce1b24b` | Copy icon under each agent reply and on each code block, with a visible Copied / Copy failed result. |
| `8b96d2e` | Images a reply links to show as thumbnails (main reads and checks the file, sends a `data:` URL). |
| `dc57972`, `66f1153` | Images you attached show as thumbnails under your message, for Claude and Codex, read back from the transcript line the index already points at. |
| `3878d77`, `73098e0` | Attach images or any file from the app: paperclip button, paste, or drop on the conversation. |
| `e85100e` | better-sqlite3 13. Fixed a Node 24 native abort (also reachable in the app), and one binary now loads in Node and Electron -- **the app and the test suite run side by side, no rebuild**. |

Suite: 1187 tests, typecheck clean. `KNOWN_ISSUES.md` is current.

## David's priorities for next session, in order

1. **DONE 2026-09-17. Live feedback in the conversation -- two parts.**
   Branch `live-conversation-feedback`, commits `75435f1..4d03880`, 1294 tests,
   typecheck clean. David confirmed it by eye in the running app on 2026-09-17
   (see "GUI needs eyes, not tests" -- a green suite on a rendered surface is not
   the finish line).

   What shipped: the person's message appears on send, labelled Queued when the
   agent is mid-turn and warning when it never reaches the log while the agent is
   idle; a working strip above the message box; a waiting card that pauses
   typing; the open session updating in about a quarter second instead of five;
   a message to a busy Codex queued with Tab; an interrupted Codex no longer
   reading as working.

   The composer also gained a visible Send button (the mockup and spec both have
   one; David has seen and approved it).

   - **Your message was sent.** Today the box clears on `sent`, but the message
     only appears once the transcript is ingested, so there is a gap where nothing
     shows it went. Add a pending entry at the bottom (text, attachment chips,
     "Sending…" then "Sent") that is replaced by the real turn when it arrives.
     Decide what a refusal does to it (probably: stays, marked failed, text
     returned to the box).
   - **The agent is working.** While the session is busy, show a working
     indicator at the bottom of the conversation (like the terminal's spinner),
     gone when it is idle or waiting on you. For Claude the app already reads
     `~/.claude/sessions/<pid>.json` `status` (busy / idle / waiting). **Not
     checked:** where the cards get Codex's working state today -- find that
     first and reuse it. If there is nothing reliable, the rollout's
     `task_started` / `task_complete` events tracked busy/idle correctly in every
     measurement on 2026-09-17.
2. **DONE 2026-09-18 (branch quick-answers):** spec
   `2026-09-17-quick-answers-design.md`, plan `plans/2026-09-17-quick-answers.md`,
   checked by eye by David. **Quick responses in the cards and the conversation.** This is Part 4 of the
   plan, pulled ahead of Part 3 at David's request: answer a waiting session's
   question, permission or plan-approval prompt with buttons, from its card and
   from the conversation pane. The Conversation Pane Mockup already designs all of
   it (https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz -- read its CSS, do not
   infer from screenshots). Choices measured 2026-09-15 are in the four-part-plan
   memory. Needs a spec: where the prompt data comes from (hooks are not
   installed), and verifying the answer against Claude's review screen.
3. **Part 3: launch into iTerm.** No spec yet. See the section below.

## Part 3 in one paragraph

Sessions the app launches already live in tmux. Part 3 opens that same tmux session
in a real iTerm2 window using iTerm's tmux integration (`tmux -CC attach -t
<name>`), so the terminal gets native scrollback, selection, copy, find, links and
drag-and-drop instead of the app's embedded widget. Because the session still lives
in tmux, the app keeps sending messages and answers exactly as it does now. Closing
the iTerm window asks Hide / Detach / Kill / Cancel with Hide as the default, so the
session keeps running (verified 2026-09-15). tmux's scrollback is capped at 2,000
lines by default; the app can raise `history-limit` for its own sessions. Open
decisions: open in iTerm automatically on launch or only on a button; keep, drop or
demote the built-in Terminal view; one window per session or tabs; Codex too.

## How to verify agent behaviour -- use this, it worked

Screen-scraping a TUI gave confidently wrong answers twice (Codex echoes a submitted
message in the same form as an unsent one). What worked, all day:

- **The agent's own session log is the verdict.** Codex:
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (local date; first line has
  `payload.cwd`). Claude Code: `~/.claude/projects/<key>/*.jsonl` (records carry
  `cwd`; skip `isMeta` records). Codex TUI logs: `~/.codex/logs_2.sqlite`
  (open read-only).
- **Validate the detector every run:** a known submit must register and a known
  strand must not. It caught a stale-data bug once; make tags unique per run.
- **Drive the real code:** a throwaway vitest file under
  `<scratchpad>/live/tests/`, run with `npx vitest run --dir <scratchpad>/live`,
  calling `sendKeysFor` etc. with production defaults against real tmux sessions.
  Run it against `main` too for a before/after.
- Never send "reset" keys between runs without knowing what they do (Escape puts
  Codex in backtrack mode). A busy Codex does not submit on Enter at all.
- Claude's trust prompt defaults to "No, exit": send Down before Enter.
- **Codex's rollout file does not exist until the first submitted turn.** It is
  created lazily, not at session start -- do not expect it before then.
- **The day directory under `~/.codex/sessions/` is machine-wide**, so "sort
  filenames, take the newest" can pick up someone else's session. Resolve the
  exact file through `~/.codex/state_5.sqlite`'s `threads` table instead
  (`cwd` -> `rollout_path`, kept in sync live).
- **This Codex build (0.154.0) writes a submitted user message as
  `item_completed` / `response_item` with `message`/`role=user`**, not the flat
  `event_msg` / `user_message` form. `task_started` and `task_complete` are
  unaffected -- still flat `event_msg` records.

## Things worth knowing

- **A reboot kills every tmux session**, including app-launched agent sessions. The
  conversations survive; resume them with `claude --resume` / `codex resume`.
- **Launch the app detached** (e.g. a tmux session named `workspace-app` running
  `npm run dev`) when testing discovery, or the launching shell is its ancestor.
- **Uploaded files live in temp** (David's choice), so **Claude asks permission
  before reading each one**; Codex does not. Measured.
- **Attached images/files** are staged by main under `$TMPDIR/llm-workspace-attachments`
  (images, 1 day) and `$TMPDIR/llm-workspace-files` (files, 7 days), sent as
  single-quoted paths -- Codex only attaches a quoted path.
- **Still unexplained:** the first Codex report (2026-09-16 13:40, multi-line, fresh
  idle session). The paste path never stranded in any measurement since. If it
  recurs, capture `#{pane_in_mode}` and the rollout before changing anything.
- **Mockup divergences** from the Part 2 handoff are still untriaged, except day
  dividers (done).

## Ideas from David, not yet scheduled (2026-09-17)

- **Cmd+number opens a session.** Cmd+1..9 opens the session card with that
  number. Open: number by card position (browser-tab style, shifts as sessions
  open and close) or a stable number per session; show the number on the card.
  The app has no keyboard shortcuts today.
- **Favourite projects for quick launch.** Save folders as favourites and launch
  one in a click from the launch bar. Open: provider per favourite or the
  launch bar's current one; favourites only or also recent folders. The app has
  no recent-folders list today.

## Quick answers: open follow-ups (2026-09-18)

- **Multi-select "Other"** is not offered (its key sequence was never measured);
  the card says to use Terminal. Measure it, then enable.
- **Packaged builds cannot install hooks:** `src/hooks/helper.sh` is not in
  `electron-builder.yml`'s files. The helper source path is also duplicated in
  `src/main/index.ts` and `src/main/ipc.ts`.
- **Data at rest:** `~/.llm-workspace/index.sqlite` is 0644 and `signal_events`
  is never pruned; with hooks on it keeps commands, plans and file contents.
- **`ReplyPopover.tsx/.css`** have no production caller (ConversationView still
  imports `REFUSAL_TEXT` from it). Keep or delete.
- **A read-only (0400) settings.json** is installed into when the switch is
  flipped (mode kept). Refusing it is a product call.
- **Switch off on a malformed hooks shape:** `removeByCommand` throws on a
  non-array `hooks[event]`, so `hooks:set` rejects with no message.
- **Plan feedback typed in the terminal first:** if feedback is already typed
  before the card reads the screen, option 3 reads as a plain button.
- **Probe vs uninstall ownership:** `probeCapabilities` counts any
  `sh '...helper.sh'` hook as installed; Off removes only the stable-path one.
- **Other tools' permission prompts** (WebFetch, MCP, NotebookEdit) anchor on the
  tool name and likely stay read-only until measured.
- **Wrapped typed text / review lines** wider than the pane end as
  `unconfirmed_partial` (safe) until wrapped fixtures exist.
- **FIXED 2026-09-18 (477225e): replies saved only as thinking.** Claude Code
  (Opus 5) records some replies as a short summary in a thinking block with no
  text; the pane now shows them as dim italic notes (parser v4 re-read every
  transcript). The full wording of those replies is not on disk anywhere.
- **FIXED 2026-09-18 (477225e): long questions wrap with a "│ " border** and were
  refused; the reader strips it (fixture 98).
- **FIXED 2026-09-18 (667e6ea): multi-line and taller-than-pane commands** now
  answer from the card (bordered lines, exact command match, tail rule for
  overflow, ambiguity guard for two prompts in one wait). Follow-ups from the
  security review: tighten file-tool and other-tool anchors to the same
  exact-region rule as Bash (today: basename/tool name anywhere in the dialog).
- **Usage button (David's idea):** Claude plan limits are exposed token-free
  only via the status line JSON (`rate_limits.five_hour` / `seven_day`
  `used_percentage` + `resets_at`, Pro/Max); David has no status line
  configured, so the app can add one (write-only helper that saves the latest
  snapshot per session and prints a short footer). Codex weekly usage is already
  in rollout `token_count` events (`rate_limits.primary.used_percent`,
  `window_minutes`, `resets_at`). Plan: status line feed first, then the context
  chip and the Usage panel read from it (mockup first).
- **SHIPPED 2026-09-18 (e4c1c8d): context chip + Usage panel + "Usage and
  context" switch.** Chip = used tokens and "% left" = unused share of the
  model's whole window (100 - /context's used %, David's choice; verified:
  /context 632.4k (63%) = chip 37% left). No compaction estimate (the measured
  autocompact buffer is 33k on a 1M window, shown by /context but not used).
  Claude plan limits need the switch on (status line JSON, token-free); Codex
  weekly comes from rollouts. Not yet checked by eye: the Usage panel and the
  switch (turning it on hides most Claude Code footer hints).
- **FIXED 2026-09-18 (6238372): Codex sessions matched by the rollout the
  process holds open** (one `lsof -Fpn` per sweep, ~33 ms), cwd match only as
  fallback -- a folder moved while Codex ran used to lose the conversation.
  Not yet: History list (fleetState) still matches by cwd.
- **Part 3 note (David, 2026-09-18):** without iTerm2, "open in iTerm" must fall
  back (built-in Terminal view, or Terminal.app with plain `tmux attach`);
  everything else already supports Terminal.app (host detection, tab jump).
- **FIXED 2026-09-18: questions not ending in "?"** were refused (reader now
  relies on the exact text match only).
- **Questions with previews** (side-by-side layout) are read-only on the card;
  measure that layout to support it.
- **Context chip (next, David's spec):** short form (2k, 20k, 200k) plus "% left"
  before auto-compact, on session cards and the conversation header. Used =
  last reply's input + cache write + cache read. Windows: Opus 5 / Sonnet 5 /
  Fable 5.1 1M, Haiku 4.5 200k (documented). The compact point is NOT
  documented (CLI: `--autocompact <auto|100k-1M>`), so a "Compacts at" setting
  defaults to 83% of the window, marked as an estimate.
- **SHIPPED 2026-09-18 (3863e02):** right-click edit menu, favourite folders
  (launch bar, conversation header, card menu; chips under the launch bar),
  Cmd+1-9 (numbers beside the card menu, sidebar order), wrapped long "Other"
  answers. Still open: switch permission mode from the Conversation view (mockup
  first); the agent graph view (worktree `../llm-workspace-agent-graph`, branch
  `agent-graph`); Part 3 (iTerm, with a Terminal.app fallback).
- **Mode switcher specced 2026-09-21:**
  `docs/superpowers/specs/2026-09-21-mode-switcher-design.md`. Layout C (chip
  beside the composer hint) picked from the mockup. **Codex is in the spec**,
  not deferred: it cycles on Shift+Tab too, but its presets are Read Only /
  Auto / Full Access plus a Custom state, so the menu is built per provider.
  Two things still to measure on a live pane: whether Claude's Auto is in the
  Shift+Tab cycle at all, and Codex's exact cycle order.
- **SHIPPED 2026-09-21 (509e71e): questions with previews answer from the
  card.** The blanket `hasPreview` refusal now fires only for
  multi-select-with-previews (no measured layout). Verified by eye: three
  answered from the card, proven by `session:answer sent`. Two unexplained
  refusals right after an app restart are in `KNOWN_ISSUES.md`.
  **Tabled at David's call:** rendering the preview text on the card itself
  (he answered "Show them" once and "Leave it as is" on a throwaway re-run, so
  confirm which before building). Also established, so nobody re-researches it:
  there is no supported non-keystroke way to answer a Claude Code prompt --
  hooks observe, the SDK covers tool permissions, Remote Control has no
  programmatic surface.
- **Feature ideas (David, 2026-09-22), not specced, not built:**
  1. **Stop the cards moving on their own.** Today the rail reorders itself as
     sessions become active, so a card can move out from under the cursor
     mid-click. David wants the order held still and reorderable by hand.
     Questions before building: where does a NEW session land in a fixed
     order, and what happens to the gap when one ends; drag-and-drop is
     famously unusable by keyboard, so it needs a keyboard equivalent, not an
     afterthought; the order is per-machine state, so it belongs with
     favourites and settings; and Cmd+1-9 is defined by sidebar order, so a
     hand-sorted rail silently redefines what Cmd+3 opens -- which is
     probably what you want, but it should be a decision.
  2. **A "needs attention" band when the waiting card is out of view.**
     Scrolled past a session that is waiting on you, and the rail should say
     so rather than letting it sit unseen -- which is the app's whole reason
     for existing. The conversation's "Jump to latest" is the precedent for
     both the look and the mechanics; it needs to know direction (above or
     below), a count when more than one, and to take you there on click.
     Waiting is already the only filled status mark, so the band should use
     that same shape rather than inventing a third vocabulary.
