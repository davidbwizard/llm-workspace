# Part 1 Handoff — exact session identity, and what the app still needs

**Date:** 2026-09-15
**Status:** merged to `main` (`eb14bbd`, 17 commits). 906 tests, 51 files.
Typecheck clean. The app runs from `main`.
**Spec:** `2026-09-15-exact-session-identity-design.md`
**Plan:** `../plans/2026-09-15-exact-session-identity.md`
**Read first:** `2026-09-14-phase-6-handoff.md` (the terminal, and why a green
suite is not evidence).

---

## Read this part first

**The worst bug of the day was invisible to 905 passing tests and to three
rounds of code review.** With a question on screen, the session card's Reply
box sent "blue" as keystrokes; the picker ignored the letters, Enter chose the
highlighted option, and the transcript recorded "Red". At a permission prompt
the highlighted option is "Yes".

David found it by using the app. Nothing else could have: the tests mock the
terminal, and the reviewers were reading a diff that did not contain the bug --
it was in code this part only made *reachable*, by fixing the "waiting on you"
signal so the Reply button finally appeared when it mattered.

**The rule this part earned:** when a change makes an existing path reachable
more often, that path is now part of the change. Review it, and test it by
hand.

## What the app does now

Each live Claude process resolves to its exact session by reading Claude Code's
own `~/.claude/sessions/<pid>.json`, instead of guessing from the working
directory. What that fixes, all confirmed by eye on the real machine:

- **Two sessions in one folder each show their own conversation.** Both cards,
  both Conversation views. No more "several recorded sessions".
- **`/clear` is followed within one discovery sweep** (about 5 seconds).
- **"Waiting on you" is accurate again** without hooks, which have not been
  installed since 2026-09-10. It comes from the session file's own `status`.
- **Reattach works for same-folder sessions,** and refuses -- before killing
  anything -- when the session has no saved conversation to resume.
- **A waiting card offers Answer, which opens the Terminal view.** No text box.
  The main process also refuses typed replies while a choice is open.

Codex is untouched: it writes no equivalent file, so its cwd matching stays.

## How it was built

Spec, then plan, then six tasks executed by fresh subagents, each with its own
review, then a whole-branch review on the most capable model, then eyes-on with
David. The ledger, briefs and review packages lived in a git-ignored workspace
inside the worktree; they were copied to this session's scratch directory at
merge time and are not durable.

**What the process caught that tests did not:**

| Found by | Defect |
|---|---|
| Task review | Pre-existing discovery tests read the operator's real `~/.claude/sessions` |
| Whole-branch review | The spec's own matching rule could attach a live process to another process's pre-`/clear` conversation. Proved with a probe test. |
| Whole-branch review | Reattach on a session with no transcript would kill it and fail to resume. Measured: `claude --resume <unknown id>` exits 1. |
| David, in the app | The Reply box answering a picker with the wrong option |
| David, in the app | The Answer popover morphing back into a text box when the card's state flickered |

**What it cost:** roughly seven hours from spec to merge, most of it review and
in-app testing rather than writing code. Two app restarts were needed because
the native database module has to be built one way for Electron and another for
Node tests, and a third because a cloned `node_modules` carried a stale Vite
cache that made the app load files from the main checkout.

## Facts about Claude Code's session files (measured 2026-09-15, 2.1.272)

These are undocumented internals. The app treats them as an accelerator that
can vanish, never as the only path.

- Written for every running session, interactive and `claude -p` alike
  (`entrypoint: "sdk-cli"`, `status: null` at first), deleted on exit.
- `sessionId` changes on `/clear`; `startedAt` does not, and matches the OS
  process start time to within a second. That pair is what makes the pid-reuse
  guard and Reattach's fresh re-read safe.
- `status` is `waiting` for both a question picker and a permission prompt.
- No file exists while the folder-trust prompt is on screen.
- A permission prompt's tool call IS in the transcript before you answer; an
  AskUserQuestion call is not written until after.

## Open items

**Next, in order (design settled with David on 2026-09-15):**

1. **Part 2, conversation pane.** Mockup:
   https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz — 16px text, accent style
   A by default with C as an option, the Claude logo instead of the word Agent
   (`ProviderMark.tsx` currently draws the Anthropic mark), name and time on one
   line above the message, oldest-at-top with a message box at the bottom and
   live updates, compact cards (setting: Off / Sidebar / Fleet / Both, default
   Both), no pid on cards, folder path in the conversation header, a settings
   modal behind a gear next to Launch (appearance System/Light/Dark, which also
   needs `nativeTheme.themeSource`), and background scroll locked while that
   modal is open. Open question: whether the message box may send multi-line
   text (the outbound sanitiser refuses newlines today).
2. **Part 3, launch into iTerm** via `tmux -CC`, with a larger scrollback than
   the current 2,000 lines. Verified: closing a tmux-mode iTerm window asks
   Hide / Detach / Kill / Cancel, with Hide the default, so a stray Cmd+W does
   not end a session.
3. **Part 4, question and trust cards.** Clickable choices, sent as keystrokes
   and checked against Claude Code's own review screen before submitting. There
   is no documented keystroke-free API. Measured key behaviour: a number key
   picks and advances on a single-select, toggles on a multi-select; Tab moves
   between questions; the Submit tab lists the answers before sending. Where
   the question text comes from is still open, since the app's hooks are not
   installed.

**Carried, not blocking:**

- **History cards still match by cwd only** (`fleetState`), so a same-folder
  pair can read as ambiguous in History and unique in the rail. Out of part 1's
  scope by design; fold into part 2 or 3.
- **The app's hooks are not installed** (last hook event 2026-09-10). Waiting
  status no longer depends on them, but `waiting_permission` versus
  `waiting_input` still does.
- **Minor, deferred:** `ReplyPopover.css`'s `.replyexplain` duplicates
  `.replyprompt`; `reattachSession`'s doc comment does not mention the new
  `hasTranscript` refusal; `readLiveSession` recomputes `resolvePaths(homedir())`
  per pid; the `not_regular_file` / `too_large` / `read_error` warning variants
  share one tested branch.
- **Leftovers from probing:** `~/.claude/plans/plan-only-add-one-linear-naur.md`,
  and a scratch folder marked trusted in `~/.claude.json`.

## Process notes that earned their place

- **A path made reachable is a path changed.** The Reply bug existed before
  this work and was made live by it.
- **Measure the platform, do not reason about it.** Four throwaway sessions
  answered what `/clear` does to `startedAt`, what `status` shows during a
  permission prompt, whether `claude -p` writes a file, and what `--resume`
  does with an unknown id. Each took minutes and each settled a design point.
- **Let the reviewer prove it.** The whole-branch reviewer wrote a probe test
  that reproduced the matching defect rather than describing it. That is what
  made the spec amendment obvious rather than arguable.
- **Rulings, not stalls.** Every conflict between the plan and a review finding
  was decided and recorded in the ledger with its cost if wrong, and the list
  was handed to David at the end. He overrode none of them, but he could see
  all of them.
- **One worktree, two ABIs.** Tests need the database module built for Node and
  the app needs it built for Electron, so they cannot run at the same time in
  one checkout. Plan the order: eyes-on, then stop the app, then build and
  test, then restart.
- **Clone a `node_modules` and you clone its caches.** The stale Vite cache
  made the app serve files from the other checkout, with no error beyond
  "outside of Vite serving allow list".
