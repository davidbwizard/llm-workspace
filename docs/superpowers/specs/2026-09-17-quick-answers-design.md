# Quick Answers (design)

**Date:** 2026-09-17
**Status:** design, approved section by section by David on 2026-09-17. No
implementation plan yet.
**Part of:** Part 4 of the four-part plan (question and permission cards),
pulled ahead of Part 3 (iTerm). Priority 2 in
`2026-09-17-part-2-followups-handoff.md`.
**Design:** Conversation Pane Mockup, "Show in the window" scenarios Questions,
Command permission and Plan approval:
https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz

Read the mockup's CSS (`.prompt`, `.q`, `.opt`, `.tabs`, `.review`, `.choices`,
`.cmd`, `.plan`, `.feedback`) for exact values. Do not work from screenshots.

---

## 1. What this delivers

- When a Claude session is waiting on a **question** (AskUserQuestion), a
  **tool permission**, or a **plan approval**, the conversation pane shows a
  prompt card above the message box with the real content and Claude's own
  choices. Clicking a choice answers Claude, from the app, without the terminal.
- A waiting session's **Answer** button (sidebar and Fleet cards) opens that
  session's conversation with the card showing, instead of Open Terminal.
- A **Quick answers** switch in Settings installs and removes the app's Claude
  Code hooks, which is where the prompt content comes from.
- The app never presses a key unless Claude's screen shows the prompt the card
  shows. When it cannot confirm that, it presses nothing and says so.

## 2. Decisions (David, 2026-09-17)

| Question | Decision |
|---|---|
| Where prompt data comes from | Install the app's own hooks (`src/hooks/install.ts`). Rejected: reading the screen only (tmux sessions only, fragile) and the transcript only (a question is not written until it is answered). |
| Scope | Questions, tool permission, plan approval. Folder trust later. Codex out. |
| Session cards | Answer opens the conversation pane. No answer buttons on cards. |
| Switch | In Settings, **off by default**. Off removes only the app's entries. |
| How answers are delivered | tmux keystrokes, with a screen check. Rejected: a blocking `PermissionRequest` hook that returns allow/deny. It needs a local approval channel (anything that can write to it can approve commands), a hung app would stall every session's permission prompts for up to the 10-minute hook timeout, and whether the terminal dialog stays usable meanwhile is undocumented. |
| Question layout | All on one card (default from the Part 2 decisions; the mockup's "one at a time" layout is not built). |
| Sessions the app did not launch | Prompt shown read-only, with Open Terminal. |
| Screen check fails | Press nothing; "Couldn't confirm -- answer in Terminal". |

## 3. Facts this design rests on

Measured 2026-09-17 in throwaway sessions, Claude Code **2.1.276**, Haiku 4.5.
Raw hook payloads, 51 screen captures and two status logs are committed under
`tests/fixtures/quick-answers/` (username and plan name redacted with
same-length placeholders, so line wrapping is unchanged).

**Events and status**
- Order: `PreToolUse` (AskUserQuestion and ExitPlanMode only, because of the
  installed matcher), then `PermissionRequest` about 25 ms later, then
  `Notification` 6 s later and only if still unanswered.
- **`PermissionRequest` fires for all three kinds**, AskUserQuestion and
  ExitPlanMode included, and carries the same `tool_input` as `PreToolUse`.
- **`PermissionRequest` has no `tool_use_id`** (0 of 14 events). Fields:
  `session_id, prompt_id, tool_name, tool_input, permission_mode,
  permission_suggestions` (Bash, Write only), `cwd, transcript_path,
  hook_event_name`. `prompt_id` is per user turn -- the same value appears on
  that turn's `UserPromptSubmit` and every tool event in it.
- `PostToolUse` is not in the app's installed event list. A **No, Esc or
  interrupt fires no event at all** (no PostToolUse, no Stop).
- The dialog is on screen within 0.1 s of the `PermissionRequest` file.
- `~/.claude/sessions/<pid>.json`: `status` goes `busy` then `waiting` about
  15-30 ms **before** the `PermissionRequest` file is written; `waitingFor` is
  `"input needed"` for questions and `"permission prompt"` for Bash, Write and
  plan approval. Answering goes `busy` then `idle`; No or Esc goes straight to
  `idle` with `waitingFor: null`.
- The helper stamps `occurred_at` in **whole seconds**.

**Payloads**
- AskUserQuestion `tool_input`: `{questions: [{question, header, options:
  [{label, description}], multiSelect}]}`.
- ExitPlanMode `tool_input`: `{plan: "<full markdown>", planFilePath}`.
- Bash / Write: the tool's own `tool_input` (`command`, `description`;
  `file_path`, `content`). No field lists the choices shown on screen.

**Screens and keys** (every sequence below was verified by its result -- file
created, mode changed, answer in the transcript -- not just by the screen)
- A digit on a list option acts **at once**, with no Enter. The exception is a
  digit on a free-text row, which only focuses it.
- Permission (Bash): `Do you want to proceed?` / `1. Yes` / `2. Yes, and always
  allow access to <dir> from this project` / `3. No` / `Esc to cancel · Tab to
  amend`. Write: `Do you want to create <file>?`, option 2 `Yes, and switch to
  accept edits (...) for this session (shift+tab)`. **Wording varies by tool.**
  - `1`, `2`, `3` answer directly. No with text: move to option 3, `Tab` (the
    row becomes `No, and tell Claude what to do differently`), type, `Enter`.
- Plan: `Would you like to proceed?` / `1. Yes, auto-accept edits` / `2. Yes,
  manually approve edits` / `3. Tell Claude what to change`. `1` and `2` answer
  directly; `3` focuses the text row, then type, `Enter`.
- Questions: a tab row `←  ☐ Color  ☐ Pets  ✔ Submit  →`, then options, then
  `n+1. Type something.`, then `n+2. Chat about this`.
  - Single-select: a digit picks and advances to the next question.
  - Multi-select: a digit toggles and the cursor stays; `Right` advances.
  - Free text, single-select: digit `n+1`, type, `Enter`.
  - Free text, multi-select: digit `n+1` ticks; `Down` to the row; type; `Tab`
    to leave the field. The plan's first task pins this sequence from fixtures
    30-40 before it is coded.
  - `Left` goes back and keeps answers. After the last question a **review
    screen** lists every answer; `1` or `Enter` submits.
  - `n+2` (Chat about this) rejects the tool. `Esc` declines.
- Answers come back in `PostToolUse.tool_response.answers` as
  `{"<question>": "<label or typed text>"}`, multi-select joined with `", "`.

**Not measured** (the plan's first task measures these or the design avoids
them): whether the status file's `updatedAt` changes during a single wait;
Bash option 2's wording in a normal project folder (in `/private/tmp` it did
not stop the next prompt); `Tab to amend` on Yes; Shift+Tab "approve with this
feedback" on plans; whether `PermissionDenied` fires on a user's No.

## 4. The Quick answers switch (main)

- **Settings:** a "Quick answers" section with one switch and one line: "Adds
  the app's hooks to ~/.claude/settings.json so it can show what Claude is
  asking. Turning this off removes them." The switch shows the real state from
  `probeCapabilities().hooksInstalled`, re-read each time Settings opens, so a
  hand edit cannot make it lie.
- **Stable helper path.** On install, copy `src/hooks/helper.sh` to
  `~/.llm-workspace/bin/helper.sh` (directory 0700, written atomically) and
  point the hooks there. The app's own location can then change without leaving
  hooks that point at a missing script. On every app start with hooks
  installed, refresh the copy if its content differs.
- **On:** `buildHookFragments(stablePath)` + `planInstall` + `applyInstall`,
  unchanged except for the two fixes below. The event list and the
  `AskUserQuestion|ExitPlanMode` PreToolUse matcher are unchanged.
- **Off:** `uninstall` with the manifest for the stable path. The command
  string is fixed, so no stored manifest is needed. Exact-match removal leaves
  the user's own hooks untouched.
- **Fixes to the write path:**
  - `writeJsonAtomic` keeps the original file's mode (today the temp file is
    created with the default mode, so a 0600 settings file would become 0644).
  - A `settings.json` that exists but does not parse is an error shown under
    the switch. Nothing is written. A missing file is created.
- **Spool privacy.** The spool now holds commands and plan text. The helper
  sets `umask 077` before `mkdir`; the app creates `~/.llm-workspace/spool` as
  0700 and tightens an existing one.
- `applyInstall`'s changed-since-read refusal is shown as "Settings changed
  while installing -- try again", and the switch stays off.

## 5. Which prompt is open (main)

### 5.1 Rule

A session has an **open prompt** when all of these hold:
1. Its live status file says `status: "waiting"`.
2. Among that session's `signal_events`, the newest `PermissionRequest`
   occurred at or after **waitingSince floored to the whole second**. (Built
   2026-09-18; this replaced a 2 s slack. The status flips 15-30 ms before the
   PermissionRequest is written and the helper stamps whole seconds, so the
   floor is exact and a just-answered prompt cannot pass for the next one.)
3. No other event from that session (except `Notification`, `PreToolUse`,
   `SubagentStart` and `SubagentStop`) is newer than that `PermissionRequest`.

`waitingSince` is the status file's `updatedAt` from the first read in which the
watcher saw `waiting` for this pid, held until the status changes. If the first
measurement task shows `updatedAt` never moves during a wait, the plain
`updatedAt` is used instead.

The prompt's **identity** is that `PermissionRequest`'s `event_id`. Its **kind**
comes from `tool_name`: `AskUserQuestion` = question, `ExitPlanMode` = plan,
anything else = permission.

No open prompt while `waiting` (hooks off, a prompt kind with no hook, or no
match) means today's behaviour: the waiting card with Open Terminal.

### 5.2 The blocker path this makes reachable

With hooks installed, `openBlockers` (`src/store/signals.ts`) starts returning
rows on this machine for the first time. Measured payloads break it:
- `PermissionRequest` is keyed by `prompt_id`, which is shared by the whole
  turn, and its resolvers (`PostToolUse`) are not installed. So a blocker never
  closes before `SessionEnd` or the 24 h window.
- `deriveActivity` (`src/fleet/state.ts`) ranks a blocker **above** the live
  status file.

Together, any session that has hit one permission prompt would read as waiting
for up to a day. This design changes both callers (`fleet/state.ts`
`fleetState` and the targeted path, `sessionLive.ts` `buildSessionLive`):
- **When a live status file exists, it wins.** The waiting kind comes from
  `waitingFor` (`"permission prompt"` = `waiting_permission`, anything else =
  `waiting_input`).
- Without a status file, a blocker counts only if rule 3 above holds (nothing
  newer from that session).

`openBlockers` keeps its current contract for any other caller. The new query
is per session (`WHERE session_id = ? ORDER BY occurred_at DESC LIMIT n`), not
a 24 h scan every 250 ms. The plan adds an index on
`signal_events(session_id, occurred_at)` if one does not exist.

## 6. The prompt sent to the renderer

`SessionLivePayload` gains `prompt: PromptView | null`:

```ts
type PromptView = {
  id: string;                    // PermissionRequest event_id
  kind: 'question' | 'permission' | 'plan';
  answerable: boolean;
  reason: null | 'not_tmux' | 'screen_unread';  // why not answerable
  // question
  questions?: { question: string; header: string; multiSelect: boolean;
                options: { label: string; description: string }[] }[];
  // permission
  toolName?: string; command?: string; filePath?: string; description?: string;
  // plan
  plan?: string;                 // markdown
  // permission + plan: Claude's choices, read from the screen
  choices?: { key: string; label: string; takesText: boolean }[];
};
```

- Content (questions, command, plan) always comes from the hook payload.
- `choices` come from the screen (section 8), because the hook does not carry
  them and the wording varies. When the prompt first opens, main captures the
  pane, retrying every 100 ms for up to 1 s, and caches the result by prompt
  `id`. Question choices need no screen read, since the hook carries the
  options.
- `answerable` is false for a session not hosted in an app tmux session
  (`not_tmux`), or when permission or plan choices could not be read
  (`screen_unread`). A non-answerable prompt still shows its content.
- Text fields are rendered as text, never as HTML. The plan markdown goes
  through the conversation pane's existing markdown renderer.

## 7. Answering (main)

### 7.1 IPC

`session:answer(pid, promptId, answer)` returns `{ status: 'sent' }` or
`{ status: 'refused', reason }`. It never throws across IPC.

```ts
type Answer =
  | { kind: 'choice'; key: string }                   // permission / plan
  | { kind: 'choice_text'; key: string; text: string } // No + text, plan option 3
  | { kind: 'questions'; picks: { options: number[]; other?: string }[] }
  | { kind: 'chat' };                                  // "Chat about this"
```

### 7.2 Guards, in order (each refusal presses nothing)

1. `pid` resolves to a live, app-launched tmux session (existing resolution
   used by `session:keys`). Else `not_tmux`.
2. Main **re-derives** the open prompt (section 5) and its `id` equals
   `promptId`. Else `stale` -- Claude moved on or it was answered in the
   terminal. The renderer's copy is never trusted.
3. The answer fits the prompt:
   - `key` is one of the cached `choices`, and `takesText` agrees with the
     answer kind.
   - Question picks: one per question; indexes in range; single-select has
     exactly one option or `other`; multi-select has at least one.
   - `text` / `other` is 1-2000 characters, a **single line**, with no control
     characters. A newline sent by `send-keys` would submit early.
   Else `invalid`.
4. One answer in flight per pid; a second click gets `busy`.
5. **Leave copy-mode first** (`paneInMode` / `cancelMode`), as the message send
   path does.
6. **Screen check before the first key** (section 8): the screen shows this
   prompt, and for permission and plan the parsed choices equal the cached
   ones. Else `unconfirmed`.

### 7.3 Key sequences

Keys go through `src/main/tmux.ts`: `sendKey` for named keys and digits,
`sendLiteral` (`send-keys -l`) for typed text. Each step waits for the screen to
settle, re-using the existing settle pattern (`src/main/ipc.ts`).

- **Permission / plan, `choice`:** the digit. Done.
- **Permission No + text:** `Down` until the cursor is on the No row (verified
  on screen), `Tab`, then check that the row reads `No, and tell Claude what to
  do differently`. Type the text, check it appears in that row, then `Enter`.
- **Plan option 3 + text:** `3`, check the text row is focused, type, check,
  `Enter`.
- **Questions:** for each question in order:
  - single-select: its digit;
  - multi-select: each picked digit, then `Right`;
  - `other`: the free-text sequence from section 3.
  After each question, check the tab row shows it answered and the next one
  current. After the last, **read the review screen and compare every line with
  the card's answers.** Only on a full match press `1`.
- **Chat:** digit `n+2` of the current question.

Before any `Enter` that follows typed text, main re-captures and confirms the
text sits in the prompt's text row, not in Claude's main message box. Otherwise
a mistimed Enter could send the text as a new message. If a mid-sequence check
fails, main stops and returns `unconfirmed_partial`. The card then says answers
may be partly entered and to finish in Terminal.

### 7.4 After sending

The card shows "Sending...". It closes when the status leaves `waiting` or the
prompt `id` changes. If neither happens within 3 s, it shows "Claude didn't take
the answer -- open Terminal".

## 8. Screen reader (main, pure function)

`readPromptScreen(capture: string, expected: PromptView)` returns `{ match:
true, choices? , state? }` or `{ match: false, why }`. It works on the pane text
from `capturePane`.

- **Permission:** finds the dialog block below the last full-width rule: a
  question line ending in `?`, then numbered option lines (continuation lines
  joined), then the `Esc to cancel` footer. It requires the hook's anchor on
  screen: the Bash `command`, or the basename of `file_path` for file tools.
  For other tools, the tool name.
- **Plan:** `Would you like to proceed?` with numbered options.
- **Question:** the tab row with the same headers in order, the current
  question's text, and its option labels. State = which question is current and
  which are ticked. **Review:** each question text paired with an answer.
- **Negatives it must reject:** a busy spinner screen, the idle composer, an
  answered screen, a different question, a review screen where a question
  screen is expected (and the reverse), and a permission dialog whose command
  differs from the hook's.

## 9. Renderer

- **Prompt card** (`PromptCard`, in the conversation pane above the composer,
  following the mockup's `.prompt` CSS). The eyebrow reads "Claude is waiting
  on you". Titles: "Claude has N questions", "Claude wants to run a command"
  (Bash), "Claude wants to edit a file" (file tools), "Claude wants to use
  <tool>" (others), "Claude's plan is ready".
  - Questions: all on one card. Each question is a fieldset of radio or
    checkbox options plus "Other" with a text box. The footer has "Chat about
    this instead" and "Send answers", which stays disabled until every
    question is answered.
  - Permission: the command in `.cmd` (or the file path), Bash's `description`
    as "Claude's description: ...", then `choices` as `.choices` buttons with
    the key shown. A `takesText` choice opens a one-line text box and "Send to
    Claude".
  - Plan: the markdown in the `.plan` scroll box, then the choices; option 3
    opens the feedback box.
  - States: **read-only** (`answerable: false`: content plus Open Terminal and
    the reason in one line); **sending**; **couldn't confirm** (and the
    partial variant); **refused stale** (the card re-renders from the next
    payload).
- The existing `WaitingCard` stays the fallback when `prompt` is null. With
  hooks off it adds "Turn on Quick answers in Settings to answer here."
- The composer stays paused while waiting, as today.
- **Answer on session cards** (`SessionRail`, `MainPane`, Fleet): selects the
  session and switches to the Conversation view, where the card is. This
  replaces the route to Open Terminal. With no prompt the pane shows the
  fallback card, which still offers Open Terminal.
- **Settings:** the Quick answers switch (section 4), with its error line.
  While a request is in flight the switch is disabled.

## 10. Errors

| Situation | What the user sees | Keys pressed |
|---|---|---|
| Hooks off | Waiting card + "Turn on Quick answers in Settings" | none |
| Not an app tmux session | Read-only prompt + Open Terminal | none |
| Choices not readable from screen | Read-only prompt + Open Terminal | none |
| Prompt changed or answered in terminal | Card updates to the new state | none |
| Screen does not show this prompt | "Couldn't confirm -- answer in Terminal" | none |
| A check fails mid-sequence | "Answers may be partly entered -- finish in Terminal" | some |
| Status still `waiting` 3 s after sending | "Claude didn't take the answer -- open Terminal" | all |
| settings.json unparseable / changed during install | Error under the switch; switch stays off | n/a |

No path swallows an error. Every refusal has a reason and is logged without the
answer text or the prompt's content.

## 11. Security

- **The renderer is untrusted.** Main re-derives the prompt, checks the answer
  against it, and types text only with `send-keys -l`, single line and no
  control characters. The existing `session:keys` sanitiser and the "refuse
  typed replies while a prompt is open" guard are unchanged.
- **No key without the screen.** The first key needs a matching screen, and
  every Enter after typed text needs its own check (section 7.3).
- **The user's config.** The app writes `~/.claude/settings.json` only when the
  switch changes: atomically, keeping the file's mode, after a re-read, merging
  only its own exact-command entries. It never writes a file it cannot parse.
- **The hook** stays write-only: no reads of app state, exit 0 always, 5 s
  timeout. It runs a stable, user-owned copy (0700 directory).
- **Data at rest.** Spool and database now hold commands, plans and questions.
  The spool is 0700. The database stays where it is (`~/.llm-workspace`). No
  new network access.
- **Logging** records refusal reasons and prompt ids, never answer text or
  `tool_input`.

## 12. Testing

Use the existing test setup. Fixtures come from `tests/fixtures/quick-answers/`.

- **Screen reader:** every dialog capture parses to the right kind, choices and
  state. Every non-dialog capture (busy, idle, answered, trust, review when a
  question is expected) is rejected. This proves the reader separates the
  outcomes, not merely that it matches one. It also rejects a permission
  capture checked against a different command.
- **Open-prompt rule:** built from the real event files and status logs.
  - A current prompt is found.
  - An answered prompt followed by Stop, a No with nothing after, and a prompt
    from before `waitingSince` are not found.
  - A 1 s timestamp skew is tolerated.
- **Activity (reachable path):** with a stale PermissionRequest and a status
  file saying `idle`, the session reads idle in both `fleetState` and
  `buildSessionLive`. `waitingFor` maps to the two waiting kinds.
- **`session:answer` guards:** each refusal (`not_tmux`, `stale`, `invalid`
  -- multi-line text, control characters, out-of-range option, a single-select
  with two picks -- `busy`, `unconfirmed`) presses no key. The test proves it
  with a recording tmux exec.
- **Key sequences:** each answer kind produces the exact measured sequence
  against a scripted fake pane that replays fixture screens. That includes the
  review compare stopping on a mismatch, and the Enter-after-text check
  refusing when the text is in the main composer.
- **Switch:** on then off against a temporary settings file holding three
  user hooks. The user hooks are byte-for-byte kept, the file mode is kept, an
  unparseable file is refused, and the helper copy is refreshed. The existing
  `tests/cli.test.ts` install tests keep passing.
- **Renderer:** each card state, Send answers disabled until complete, and
  Answer routing to the Conversation view.
- **By eye**, in real throwaway sessions (this spends quota; say so first):
  - one of each prompt kind answered from the app;
  - a No with text;
  - a plan with feedback;
  - a two-question card with an "Other";
  - answering in the terminal while the card is open (the card goes away);
  - the switch on and off, checking `~/.claude/settings.json` each time.

## 13. Out of scope

Folder trust. Codex approvals. MCP elicitations. The mockup's "one at a time"
question layout. A custom "You answered" line: the transcript already records
answers, and the plan checks how the pane shows them. Answer buttons on session
cards. Cmd+number and favourite projects (parked in the handoff doc).
