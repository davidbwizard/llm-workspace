# Quick Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer a waiting Claude session's question, tool permission or plan
approval from the app's conversation pane, using data from the app's own hooks
and tmux keystrokes that are checked against the screen.

**Architecture:** Claude's live status file decides whether a prompt is open.
The newest matching `PermissionRequest` hook event supplies its content. A pure
screen reader confirms that the pane shows that prompt before any key is sent.
Main owns every decision and every keystroke; the renderer only draws the card
and sends back a structured choice.

**Tech Stack:** Electron + React + TypeScript, better-sqlite3, vitest, tmux.

**Spec:** `docs/superpowers/specs/2026-09-17-quick-answers-design.md`. Read it
first; section numbers below (§) refer to it.

## Global Constraints

- The hook helper stays write-only: it never reads app state, always exits 0,
  and has a 5 s timeout (§4, §11).
- No key is sent unless `readPromptScreen` matched the current capture (§7.2,
  §8).
- Typed text is single-line, 1-2000 characters, with no control characters,
  and is sent only with `sendLiteral` (`send-keys -l`) (§7.2).
- Logs never contain answer text or `tool_input` (§11).
- `~/.claude/settings.json` is written only by the switch: atomically, keeping
  the file's mode, and never when it does not parse (§4).
- Fixtures: `tests/fixtures/quick-answers/{events,screens}/`, plus
  `status-*.log` (§3).
- Use the existing vitest setup. `npx vitest run` must stay green (1295 tests
  at the start) and `npx tsc --noEmit -p .` must stay clean after each task.
- The four-part plan's decisions stand: the Claude logo, not the word "Agent";
  theme tokens only, no hardcoded hex; and a modal locks background scroll.

## Decisions made while planning

- `waitingSince` = `LiveSessionFile.statusUpdatedAtMs`. Claude writes
  `statusUpdatedAt` only when `status` flips (field doc in
  `src/providers/claude/liveSession.ts`), and the probe's status logs show
  exactly one value per wait. This is the §5.1 fallback, with no watcher state.
- The `signal_session(session_id, occurred_at)` index already exists
  (`src/store/schema.ts:21`). No schema change.
- Shared prompt types live in `src/core/prompt.ts` so main and renderer use one
  definition.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/providers/claude/liveSession.ts` | 1 | parse `waitingFor` |
| `src/store/signals.ts` | 1 | `openPromptEvent`, `currentBlockers` |
| `src/fleet/state.ts`, `src/main/sessionLive.ts` | 1 | status outranks blocker; use `currentBlockers` |
| `src/core/prompt.ts` (new) | 2 | `PromptView`, `PromptChoice`, `Answer`, `ScreenRead` types |
| `src/main/promptScreen.ts` (new) | 2 | pure `readPromptScreen` |
| `src/main/tmux.ts` | 3 | allowlist the answer keys |
| `src/main/answer.ts` (new) | 3 | `buildPromptView`, `answerPrompt` |
| `src/main/sessionLive.ts`, `src/main/ipc.ts`, `src/preload/index.ts` | 3 | `prompt` in payload, `session:answer` |
| `src/hooks/install.ts`, `src/hooks/helper.sh`, `src/hooks/switch.ts` (new) | 4 | stable helper, mode-keeping write, on/off |
| `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/components/SettingsModal.tsx` | 4 | `hooks:get` / `hooks:set`, the switch |
| `src/renderer/components/PromptCard.tsx` + `.css` (new) | 5 | the card and its states |
| `ConversationView.tsx`, `WaitingCard.tsx`, `SessionRail.tsx`, `MainPane.tsx` | 5 | wiring, hooks-off line, Answer routing |

---

### Task 1: Open-prompt rule, and the status file outranks blockers

**Files:**
- Modify: `src/providers/claude/liveSession.ts` (`LiveSessionFile`, `parseLiveSessionFile`)
- Modify: `src/store/signals.ts` (add two exports; `openBlockers` unchanged)
- Modify: `src/fleet/state.ts:145-190` (`deriveActivity`), `:355` and `:952` (blocker maps)
- Modify: `src/main/sessionLive.ts:195` (blocker lookup and `deriveActivity` call)
- Test: `tests/store/prompts.test.ts` (new); extend the existing `deriveActivity`, liveSession and sessionLive tests

**Interfaces:**
- Produces:
  - `LiveSessionFile.waitingFor?: string | null`
  - `openPromptEvent(db: Db, sessionId: string, waitingSinceMs: number): SignalEvent | null`
  - `currentBlockers(db: Db, now?: number): Blocker[]`
  - `deriveActivity` opts gain `liveWaitingFor?: string | null`

- [ ] **Step 1: Failing tests.**
  - `parseLiveSessionFile` returns `waitingFor: "permission prompt"` when the
    field is present, and `null` when absent or not a string.
  - `openPromptEvent`: insert real fixture events into a temp db with
    `ingestSpool`. Copy the fixture files into a temp spool dir wrapped as
    `{event_id, occurred_at, ppid, payload}`, with `occurred_at` set from the
    filename's epoch seconds (whole seconds, as the helper writes). Cases:
    1. The Ask `PermissionRequest` (`1789706218.842-PermissionRequest-89928.json`)
       with `waitingSinceMs = 1789706218800` returns that event.
    2. The same prompt with the following `PostToolUse` and `Stop` also
       ingested returns null (a newer non-Notification event exists).
    3. A `Notification` newer than the `PermissionRequest` does not hide it.
    4. `waitingSinceMs` 3 s after the event returns null (outside the 2 s slack).
    5. A stamp up to 1 s earlier than `waitingSinceMs` still matches (the
       helper's stamp rounds down to the second).
    6. Another session's events are ignored.
    7. The Ask prompt's `PreToolUse` (same second, possibly a higher row id)
       does not hide its `PermissionRequest`. Ingest in both file orders.
  - `currentBlockers`: a `PermissionRequest` followed by a `Stop` in the same
    session is excluded. The same event with nothing after it is included.
  - `deriveActivity`:
    - `blocker` set plus `liveStatus: 'idle'` gives `idle` (status wins).
    - `liveStatus: 'waiting'` + `liveWaitingFor: 'permission prompt'` gives
      `waiting_permission`.
    - `'waiting'` + `'input needed'` gives `waiting_input`.
    - No status + `blocker` keeps today's result.
  - Reachable path: with a stale `PermissionRequest` in the db and a live
    status of `idle`, `buildSessionLive` reports `activity: 'idle'`.

- [ ] **Step 2: Run them.** `npx vitest run tests/store/prompts.test.ts tests/fleet tests/main/sessionLive.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

  In `signals.ts`:

  ```ts
  /** §5.1. The newest PermissionRequest at or after waitingSince - 2 s, and
   *  only if nothing newer (except Notification) happened in the session. */
  export function openPromptEvent(db: Db, sessionId: string, waitingSinceMs: number): SignalEvent | null {
    const rows = db.prepare(
      `SELECT * FROM signal_events WHERE session_id = ?
       ORDER BY occurred_at DESC, id DESC LIMIT 20`).all(sessionId) as any[];
    for (const r of rows) {
      // PreToolUse fires only for AskUserQuestion/ExitPlanMode (the matcher),
      // always just before the same prompt's PermissionRequest, and in the
      // SAME whole second -- ingest order (uuid filenames) cannot break that
      // tie, so it must be skipped rather than read as "newer".
      if (r.kind === 'Notification' || r.kind === 'PreToolUse') continue;
      if (r.kind !== 'PermissionRequest') return null;
      const at = Date.parse(r.occurred_at);
      return at >= waitingSinceMs - 2000 ? rowToSignal(r) : null;
    }
    return null;
  }

  /** openBlockers, minus any blocker its session has moved past: PermissionRequest
   *  carries no tool_use_id and its resolvers are not installed (§5.2). */
  export function currentBlockers(db: Db, now: number = Date.now()): Blocker[] {
    const newest = db.prepare(
      `SELECT occurred_at FROM signal_events WHERE session_id = ? AND kind != 'Notification'
       ORDER BY occurred_at DESC, id DESC LIMIT 1`);
    return openBlockers(db, undefined, now).filter(b =>
      (newest.get(b.sessionId) as { occurred_at: string } | undefined)?.occurred_at === b.occurredAt);
  }
  ```

  Cache the `newest` statement per `Db`, using the `WeakMap` pattern in
  `src/hooks/spool.ts:20`.

  In `deriveActivity`, the status file wins:

  ```ts
  if (fromStatus !== null) {
    activity = fromStatus === 'waiting_input' && opts.liveWaitingFor === 'permission prompt'
      ? 'waiting_permission' : fromStatus;
  } else if (opts.blocker) {
    activity = opts.blocker.kind === 'PermissionRequest' ? 'waiting_permission' : 'waiting_input';
  } else ...
  ```

  Update its doc comment: the status file now outranks a blocker, and give the
  reason (§5.2). Pass `liveWaitingFor` wherever `liveStatus` is passed. Switch
  the three `openBlockers` call sites to `currentBlockers`.

- [ ] **Step 4: Run the tests** above, then `npx vitest run` and `npx tsc --noEmit -p .`. Expected: all PASS.

- [ ] **Step 5: Commit** `fix(fleet): live status outranks hook blockers; add open-prompt rule`.

---

### Task 2: Prompt types and the screen reader

**Files:**
- Create: `src/core/prompt.ts`, `src/main/promptScreen.ts`
- Test: `tests/main/promptScreen.test.ts`

**Interfaces:**
- Produces, in `src/core/prompt.ts` (exact):

  ```ts
  export type PromptKind = 'question' | 'permission' | 'plan';
  export type PromptQuestion = { question: string; header: string; multiSelect: boolean;
    options: { label: string; description: string }[] };
  export type PromptChoice = { key: string; label: string; takesText: boolean };
  export type PromptView = {
    id: string; kind: PromptKind; answerable: boolean;
    reason: null | 'not_tmux' | 'screen_unread';
    questions?: PromptQuestion[];
    toolName?: string; command?: string; filePath?: string; description?: string;
    plan?: string;
    choices?: PromptChoice[];
  };
  export type Answer =
    | { kind: 'choice'; key: string }
    | { kind: 'choice_text'; key: string; text: string }
    | { kind: 'questions'; picks: { options: number[]; other?: string }[] }
    | { kind: 'chat' };
  export type ScreenExpect =
    | { kind: 'permission'; toolName: string; anchor: string }  // command, file basename, or tool name
    | { kind: 'plan' }
    | { kind: 'question'; headers: string[] };
  export type ScreenRead =
    | { match: true; kind: 'permission' | 'plan'; choices: PromptChoice[]; cursor: string | null; textRow: string | null }
    | { match: true; kind: 'question'; current: number; answered: boolean[]; options: string[] }
    | { match: true; kind: 'review'; answers: { question: string; answer: string }[] }
    | { match: false; why: string };
  ```

  - `cursor` is the key of the row marked `❯`.
  - `textRow` is the text typed in a focused free-text row, or null.
  - `takesText` is true for a choice whose screen row becomes a text row:
    Bash/Write option 3 (after `Tab`), and plan option 3.
- Produces, in `src/main/promptScreen.ts`:
  `readPromptScreen(capture: string, expect: ScreenExpect): ScreenRead`.

- [ ] **Step 1: Failing tests, table-driven over fixture screens.** Match cases:
  - `50-perm-bash-dialog` with anchor `touch perm-probe.txt`: permission,
    choices keys `1,2,3`, labels `Yes`, `Yes, and always allow access to …
    from this project` (continuation line joined), `No`; cursor `1`.
  - `60-perm-write-dialog` with anchor `write-probe.txt`: option 2 label
    starts `Yes, and switch to accept edits`.
  - `53-perm-bash2-tab-on-no`: cursor `3`, label `No, and tell Claude what to
    do differently`. `54-perm-bash2-typed-feedback`: `textRow` equals the
    typed text.
  - `80-plan-dialog`, `90-plan2-dialog`: plan, three choices, `3` takesText.
    `81-plan-key3` / `82-plan-typed-feedback`: textRow empty, then the text.
  - `10-ask-q1` with headers `['Color','Pets']`: question, current 0,
    answered `[false,false]`, options `['Red','Green','Blue']`.
    `11-ask-after-key2`: current 1. `19-ask-review`: review with
    `Which color?`→`Blue` and `Which pets?`→`Fish, Cat`. `39-ask2-review`:
    review including the typed text.

  Must reject (`match: false`) -- this proves the reader tells outcomes apart
  (memory: validate the detector):
  - every `*-after-*` screen and `03-after-trust`, `70-s2-start`;
  - `00-trust` (trust prompt);
  - `50-perm-bash-dialog` with anchor `rm -rf x` (wrong command);
  - `10-ask-q1` with headers `['Color','Food']`;
  - `19-ask-review` read with a question expectation must return `review`,
    never `question`;
  - `80-plan-dialog` with a permission expectation.

- [ ] **Step 2: Run** `npx vitest run tests/main/promptScreen.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**
  - Work on the text below the last full-width `─` rule that is followed by a
    numbered option line, or, for questions, on the block that starts at the
    `←  … →` tab row.
  - Option lines match `/^\s*(❯\s*)?(\d)\.\s+(.*)$/`. A following indented
    line with no number is a continuation, except a known hint line (`shift+tab
    to approve with this feedback`) and description lines under question
    options. Join continuations with one space.
  - Permission requires a line ending in `?` above the options and the anchor
    somewhere in the block.
  - Plan requires `Would you like to proceed?`.
  - Tab-row marks: `☐` unanswered, `☒` answered.
  - Review requires `Review your answers`, `● <question>` / `→ <answer>`
    pairs, and `Ready to submit your answers?`.
  - No regex may take user text as a pattern. Escape the anchor or use
    `includes`.

- [ ] **Step 4: Run the tests**, then the full suite and tsc. Expected: PASS.

- [ ] **Step 5: Commit** `feat(prompts): shared prompt types and a pure screen reader`.

---

### Task 3: Prompt view in the live payload, and answering

**Files:**
- Modify: `src/main/tmux.ts:127-143` (allowlist)
- Create: `src/main/answer.ts`
- Modify: `src/main/sessionLive.ts` (`SessionLivePayload.prompt`, built in `buildSessionLive`)
- Modify: `src/main/ipc.ts` (register `session:answer`), `src/preload/index.ts` (`answerPrompt`)
- Test: `tests/main/answer.test.ts`; extend `tests/main/sessionLive.test.ts`

**Interfaces:**
- Consumes: Task 1's `openPromptEvent` and `waitingFor`; Task 2's types and `readPromptScreen`.
- Produces:
  - `KeyName` = `'Enter' | 'Tab' | 'Down' | 'Right' | '1' | '2' | '3' | '4' | '5' | '6'`
    (the runtime list is updated to match).
  - `buildPromptView(event: SignalEvent, tmuxName: string | null, deps: AnswerDeps): PromptView`
  - `answerPrompt(pid: unknown, promptId: unknown, answer: unknown, deps?: AnswerDeps): AnswerResult`
  - `AnswerResult = { status: 'sent' } | { status: 'refused'; reason: 'invalid_pid' | 'not_tmux' | 'session_gone' | 'stale' | 'invalid' | 'busy' | 'unconfirmed' | 'unconfirmed_partial' }`
  - `SessionLivePayload.prompt: PromptView | null`
  - preload `answerPrompt(pid: number, promptId: string, answer: Answer): Promise<AnswerResult>`
  - `AnswerDeps` injects `send: TmuxExec`, `capture`, `sleep`,
    `currentPrompt(pid) => PromptView | null`, and `has`. Mirror `KeysDeps` in
    `ipc.ts:684`.

- [ ] **Step 1: Failing tests.**
  - **Guards**, using a recording `send` exec that must record **zero** calls
    for each refusal:
    - `pid` not a positive integer gives `invalid_pid`;
    - an unregistered pid gives `not_tmux`;
    - `promptId` different from `currentPrompt(pid).id` gives `stale`;
    - `invalid`: `key` not among `choices`; `choice` on a `takesText` key;
      text with `\n`, with `\x1b`, empty, or 2001 characters; a single-select
      question with two picks; an index out of range;
    - a second call while one is in flight gives `busy`;
    - a capture that `readPromptScreen` rejects gives `unconfirmed`.
  - **Sequences**, using a fake pane: `capture` returns the next fixture screen
    each time the recorded keys advance.
    - Bash `choice` key `1` sends exactly `['1']`.
    - Bash `choice_text` sends `Down`, `Down` until the capture shows cursor
      `3`, then `Tab`, then the literal text, then `Enter`, only after the
      capture's `textRow` equals the text (screens 52→53→54).
    - Plan `choice_text` sends `3`, the literal text, then `Enter` (80→81→82).
    - Questions `{picks:[{options:[2]},{options:[2,0]}]}` sends `3`, `3`, `1`,
      `Right`, then `1` only after the review matches (screens 10→…→19).
    - With a review capture whose answer differs from the card, the result is
      `unconfirmed_partial` and no final `1` is sent.
    - With `textRow` still empty when Enter would be sent, the result is
      `unconfirmed_partial` and no `Enter` is sent.
  - `buildSessionLive`, status `waiting` with a matching event:
    - `prompt.kind` and content come from the event;
    - a non-tmux pid gives `answerable: false`, `reason: 'not_tmux'`;
    - a tmux pid whose capture fails to parse gives `'screen_unread'`.

- [ ] **Step 2: Run** `npx vitest run tests/main/answer.test.ts tests/main/sessionLive.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `buildPromptView` maps `tool_name` to a kind (§5.1). It copies `questions`
    / `command` / `description` / `file_path` / `plan` from `payload.tool_input`,
    taking strings only and dropping anything else.
  - For permission and plan it calls `capture` and `readPromptScreen`,
    retrying every 100 ms for up to 1 s, and caches the result by event id in a
    module `Map` (cap it at 50 entries).
  - `buildSessionLive` computes
    `prompt = status === 'waiting' && sessionId ? openPromptEvent(db, sessionId, statusUpdatedAtMs ?? 0) → buildPromptView : null`.
  - `answerPrompt` runs the §7.2 guards in order. Validation lives in one
    function, `validateAnswer(view, answer): Answer | null`. Resolve tmux the
    same way `sendKeysFor` does (`tmuxNameForPid`, `resolveLiveTmux` from
    `src/main/sessions.ts`). Leave copy-mode with `paneInMode` and
    `cancelCopyMode` from `src/main/tmux.ts` (`ipc.ts`'s `paneIsInCopyMode` is
    private; do not import from `ipc.ts`, since it would create a cycle).
  - Each step captures with `capturePane(name, null)` and re-reads before its
    next key (§7.3). Settle: poll every 50 ms, up to 1.5 s, until the read
    changes as expected.
  - Log refusals as `console.error('session:answer refused', { pid, promptId, reason })`.
    Never log text.
  - Register `ipcMain.handle('session:answer', (_e, pid, promptId, answer) => answerPrompt(pid, promptId, answer))`.
    Expose `answerPrompt` in preload.

- [ ] **Step 4: Run the tests**, then the full suite and tsc. Expected: PASS.

- [ ] **Step 5: Commit** `feat(prompts): prompt view in session live state and session:answer`.

---

### Task 4: The Quick answers switch

**Files:**
- Modify: `src/hooks/install.ts` (`writeJsonAtomic` keeps the mode; `uninstall` tolerates a missing file)
- Modify: `src/hooks/helper.sh` (`umask 077` before `mkdir`)
- Create: `src/hooks/switch.ts`
- Modify: `src/main/index.ts` (on startup: tighten the spool mode; refresh the helper copy if installed)
- Modify: `src/main/ipc.ts`, `src/preload/index.ts` (`hooks:get`, `hooks:set`)
- Modify: `src/renderer/components/SettingsModal.tsx` (+ `.css`)
- Test: `tests/hooks/switch.test.ts`; extend the SettingsModal renderer test

**Interfaces:**
- Produces:
  - `hooksState(paths): { installed: boolean; error: string | null }`
  - `setHooks(paths, on: boolean, helperSource: string): { installed: boolean; error: string | null }`
  - `stableHelperPath(home): string` = `<home>/.llm-workspace/bin/helper.sh`
  - preload `hooksGet()` / `hooksSet(on: boolean)`, returning the same shape.

- [ ] **Step 1: Failing tests** in a temp HOME:
  - With a `settings.json` holding the user's three hooks
    (`block-env-read.sh`, `block-destructive-bash.sh`, `claude-notify.sh`) and
    mode 0600:
    - `setHooks(on)` adds fragments whose command is
      `sh '<home>/.llm-workspace/bin/helper.sh'`, keeps the three user entries
      deep-equal, and keeps mode 0600;
    - the helper copy exists, is byte-equal to the source, and sits in a 0700
      `bin` directory;
    - `setHooks(off)` leaves the user entries deep-equal and no owned command.
  - An unparseable `settings.json` returns an error, and the file is
    byte-unchanged.
  - A missing `settings.json` with `on` creates it.
  - `hooksState` reflects the file after a hand edit that removes our entries.
  - The existing `tests/cli.test.ts` install tests still pass.

- [ ] **Step 2: Run** `npx vitest run tests/hooks`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `writeJsonAtomic`: `stat` the original if it exists and `chmod` the temp
    file to that mode before the rename.
  - `setHooks(on)`:
    1. `mkdir` bin 0700;
    2. copy the helper atomically (tmp + rename);
    3. read the settings text; `JSON.parse` failure → error, no write;
    4. `planInstall(parsed, buildHookFragments(stable))`;
    5. `applyInstall`, catching its changed-on-disk throw → "Settings changed
       while installing -- try again".
  - `setHooks(off)`: `uninstall(path, { owned: [], command: <stable command> })`.
  - `helperSource`: in dev, `src/hooks/helper.sh` resolved from the app root.
    Follow how `src/main/index.ts` resolves other bundled files; if nothing is
    bundled yet, use `app.getAppPath()`.
  - Settings UI: a "Quick answers" section with one switch and the §4
    sentence. Show the error line on failure. Disable the switch while a
    request is in flight. Re-read with `hooksGet()` whenever the modal opens.

- [ ] **Step 4: Run the tests**, then the full suite and tsc. Expected: PASS.

- [ ] **Step 5: Commit** `feat(hooks): Quick answers switch with a stable helper and mode-keeping writes`.

---

### Task 5: The prompt card, and Answer opens the pane

**Files:**
- Create: `src/renderer/components/PromptCard.tsx`, `PromptCard.css`
- Modify: `src/renderer/components/ConversationView.tsx` (show `PromptCard` when `live.prompt`, else `WaitingCard`)
- Modify: `src/renderer/components/WaitingCard.tsx` (the hooks-off line; takes `hooksOn: boolean`)
- Modify: `src/renderer/components/SessionRail.tsx`, `MainPane.tsx` (Answer → select the session + Conversation view)
- Test: `tests/renderer/PromptCard.test.tsx`; extend the ConversationView, SessionRail and MainPane tests

**Interfaces:**
- Consumes: `PromptView`, `Answer`, `AnswerResult`, preload `answerPrompt`, `hooksGet`.
- Produces: `PromptCard({ pid, prompt, onOpenTerminal })`.

- [ ] **Step 1: Failing tests.**
  - Question card:
    - renders each question as a fieldset (radio, or checkbox for multiSelect)
      with an "Other" text box;
    - "Send answers" is disabled until every question is answered;
    - clicking it calls `answerPrompt(pid, id, {kind:'questions', picks})` with
      the right indexes;
    - "Chat about this instead" sends `{kind:'chat'}`.
  - Permission card:
    - shows the command and the "Claude's description: …" line;
    - one button per choice, showing its key;
    - a `takesText` choice opens a text box, and Send sends `choice_text`.
  - Plan card: the plan renders through the existing markdown renderer; option
    3 opens the feedback box.
  - `answerable: false`: no choice buttons; content plus Open Terminal plus the
    reason line.
  - Results:
    - `sent` shows "Sending…";
    - `unconfirmed` shows "Couldn't confirm -- answer in Terminal";
    - `unconfirmed_partial` shows "Answers may be partly entered -- finish in
      Terminal";
    - `stale` shows no error (the next payload replaces the card).
  - `WaitingCard` with `hooksOn: false` shows "Turn on Quick answers in
    Settings to answer here."
  - Answer in the rail and on Fleet selects the session and sets the view to
    Conversation, instead of opening the reply popover.
  - Text renders as text: a question label `<b>x</b>` appears literally.

- [ ] **Step 2: Run** `npx vitest run tests/renderer`. Expected: FAIL.

- [ ] **Step 3: Implement** from the mockup's CSS (§9). Read
  https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz and port `.prompt`, `.q`,
  `.opt`, `.choices`, `.cmd`, `.plan` and `.feedback` onto theme tokens; the
  mockup's tokens are the app's. Titles and eyebrow as in §9. After a
  `sent`, show "Claude didn't take the answer -- open Terminal" if the same
  `prompt.id` is still present 3 s later.

- [ ] **Step 4: Run the tests**, then the full suite and tsc. Expected: PASS.

- [ ] **Step 5: Commit** `feat(conversation): prompt card for questions, permissions and plans`.

---

### Task 6: By eye, with David

This spends quota and changes David's `~/.claude/settings.json` through the
switch. Say so first, and let David flip the switch himself.

- [ ] Restart the dev app (memory: stopping dev orphans Electron; confirm zero
  Electron mains). Turn Quick answers on; check `~/.claude/settings.json` has
  the app's entries next to the three user hooks.
- [ ] In an app-launched throwaway Claude session, answer from the app:
  - a Bash permission (Yes);
  - a No with text;
  - a plan with feedback, then approve;
  - a two-question card with an "Other".
- [ ] Answer one prompt in the terminal while the card is open: the card goes
  away, and a late click is refused as stale.
- [ ] Turn the switch off; confirm only the app's entries are gone.
- [ ] Update `KNOWN_ISSUES.md` (the hooks entry) and the handoff doc.
