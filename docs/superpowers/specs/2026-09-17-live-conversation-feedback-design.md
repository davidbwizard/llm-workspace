# Live Conversation Feedback (design)

**Date:** 2026-09-17
**Status:** design, approved section by section by David on 2026-09-17. No
implementation plan yet.
**Part of:** priority 1 in `2026-09-17-part-2-followups-handoff.md`, ahead of
Part 4 (quick responses) and Part 3 (iTerm).
**Designs:**
- Conversation Pane Mockup (waiting card, message box, sent messages):
  https://claude.ai/artifact/3dRyJz6S4B42orSZsM8osz
- Live Feedback Options (working indicator; David picked option C):
  https://claude.ai/artifact/FBES9xFVShPSVmpyZwosay

Read both designs' CSS for exact values. Do not work from screenshots.

---

## 1. What this delivers

- **Your message shows at once.** Enter puts your message in the conversation
  straight away. Today it appears only after the next 5-second check.
- **You can see the agent working.** A strip above the message box says
  "Claude is working" (or Codex) with a timer.
- **You can see when Claude is waiting on you.** A card above the message box
  sends you to the Terminal, and the box is turned off until you answer.
- **A stuck message cannot go unnoticed.** If the agent stays idle and the
  message never reaches its log, the entry says so.
- **Two Codex fixes.** An interrupted Codex no longer shows as working
  forever, and a message sent to a busy Codex is queued instead of left
  unsubmitted in its input line.
- **Faster updates for the open session.** About a quarter second instead of
  up to 5 seconds, for both new replies and the working state.

## 2. Decisions (David, 2026-09-17)

| Question | Decision |
|---|---|
| Message sent to a busy Codex | Queue it the way Codex does (Tab instead of Enter). Measure first; if it does not queue reliably, refuse instead (§7.3). |
| Send refused by the app | Remove the entry; text and attachments go back in the box with the reason. |
| Sent but never in the log | "Not seen by <agent>" plus Open Terminal after 15 seconds of known idle. |
| Update speed | Faster for the open session; the 5-second check stays as a backstop. |
| Waiting on you | As the Conversation Pane Mockup: card above the box, box turned off. Until Part 4 the card only offers Open Terminal. |
| Sent message look | As the mockup: an ordinary message of yours, no "Sending" or "Sent" label. |
| Working indicator | Option C, a strip above the message box. |

## 3. Facts this design rests on

Measured or read on 2026-09-17 unless noted.

- `OpenSession.activity` and `events` reach the renderer only on the 5-second
  discovery sweep (`pushAfterDiscoverySweep`, `src/main/index.ts`).
  `pushFleet` sends a cache, so watcher events do not refresh them.
- A refused send never reaches the session: `sendKeysFor`
  (`src/main/ipc.ts`) checks before it types anything. The message box already
  keeps the text on a refusal.
- Codex's working state is derived from the last event kind
  (`deriveActivity`, `src/fleet/state.ts`): working until `turn.completed` or
  `session.ended`, while a process is matched.
- **Bug:** Codex writes `event_msg` `turn_aborted` (with `reason:
  "interrupted"`) when interrupted, and no `task_complete`. The parser does
  not know it and stores `unparsed`, so the last kind is not a turn end and
  the session shows as working until the next turn completes. Confirmed in
  the index for session `01a0ada2-2ffa-...`.
- A busy Codex does not submit on Enter ("tab to queue message";
  `KNOWN_ISSUES.md`, 2026-09-16). The app still reports `sent` today.
- Claude's `~/.claude/sessions/<pid>.json` has `status` and
  `statusUpdatedAt` (epoch ms) (Claude Code 2.1.274).
- A message typed while Claude is busy is stored as a `queued_command`
  attachment and already parsed into a user turn
  (`src/providers/claude/parse.ts`).
- `ConversationTurn` is `{ id, ts, role, text }`.
- The watcher's `onOutcome` receives the ingested events, so main can tell
  which session a log change belongs to.
- Each event row has `source_file`, so a session's rollout path can be
  looked up.
- Only these read `turn.completed`: `TURN_END_KINDS` (`src/fleet/state.ts`), the
  `NOISY` filter (`src/config.ts`), and the conversation query, which excludes
  it. Nothing reads `durationMs` outside the parsers.
- A `CODEX_PARSER_VERSION` bump re-reads every Codex file once
  (`src/watch/watcher.ts`): 617 files, 260 MB on this machine.

## 4. Pending messages (renderer)

### 4.1 Lifecycle

1. **Enter.** A pending entry is created with the text, the attachments
   (name, kind, image thumbnail) and `sentAt = Date.now()`. The box clears and
   the pane scrolls to the bottom. The entry renders as an ordinary user turn
   with its time and attachments. No label while the send is in flight.
2. **Main replies `sent`.** The entry is kept. If the reply says
   `queued: true`, the entry shows **Queued** under the text.
3. **Main refuses, or the call rejects.** The entry is removed. The text and
   attachments return to the box and the reason shows under it, exactly as a
   refusal does today. A rejection is logged with its cause.
4. **The log has it.** The entry is removed when a real turn matches it
   (§4.2).
5. **Not seen.** §4.3.

### 4.2 Matching

The oldest unmatched pending entry is matched by the first user turn that is
not yet matched and satisfies both:

- `Date.parse(turn.ts) >= sentAt - 2000`, and
- the turn's text contains the entry's text, both with whitespace runs
  collapsed to one space and trimmed. An entry with no text (attachments
  only) matches on the time rule alone.

"Contains", not "equals", because the log can add to the text: attached file
paths (Codex), `[Image #N]` (Claude). Each turn matches at most one entry, so
two quick sends match in order.

### 4.3 Not seen

- A countdown runs only while the session's state is known to be `idle`. It
  pauses while working, waiting or unknown, so a queued message is never
  flagged while it waits.
- After 15 seconds of idle in total, the entry's label becomes **Not seen by
  Claude** / **Not seen by Codex** with an **Open Terminal** link (switches
  the pane to the Terminal view).
- A later match still removes the entry.

### 4.4 Storage

- A module-level map keyed by pid, like the draft store, so a remount (view
  or session switch) keeps entries.
- Dropped when the pid leaves the fleet. Not persisted across app restarts.
- Pending entries always render after the real turns.

## 5. Session state for the open conversation (main to renderer)

### 5.1 Contract

- Renderer to main: `session:watch(pid)` when a conversation opens, and
  `session:watch(null)` when it closes. One watched session per window.
- Main validates the pid: a positive integer that is a live process in the
  current discovery cache. Anything else is refused and logged. Watching a
  new pid replaces the previous watch.
- Main to renderer: `session:live` with
  `{ version: 1, pid, sessionId, activity, since, events }`:
  - `activity`: `working` | `idle` | `waiting` | `null` (unknown).
  - `since`: epoch ms the current working period began, or `null`.
    Claude: `statusUpdatedAt` while `status` is `busy`. Codex: `ts` of the
    session's latest `prompt.submitted` while working.
  - `events`: the session's event count. ConversationView refreshes on the
    newer of this and the fleet payload's count.

### 5.2 Triggers

- A watcher outcome whose events belong to the watched session, coalesced to
  one push per 250 ms.
- For Claude, `fs.watch` on `~/.claude/sessions/<pid>.json`, where the path is
  built only from the validated integer pid. Also coalesced to one push per
  250 ms.
- Every 5-second discovery sweep.

### 5.3 Computation

- Uses `deriveActivity` so the pane and the cards cannot disagree.
- One single-session query: count, last `ts`, last kind, latest
  `prompt.submitted` `ts`.
- Claude status comes from `freshLiveSession`, which keeps the existing
  start-time guard and file checks.
- `waiting_input` and `waiting_permission` both map to `waiting`.

### 5.4 Cleanup

The file watch and any pending coalesce timer are released:

- on `session:watch(null)` or a new pid,
- when the watched pid leaves the discovery cache,
- when the window closes.

Nothing is left running.

## 6. The strip and the waiting card (renderer)

### 6.1 Working strip (option C)

- Shown only when `activity === 'working'` for a running session.
- Content: a pulsing accent dot, the provider logo, "Claude is working" /
  "Codex is working", and a timer from `since` (`14s`, `2m 5s`, `1h 3m`). With
  no `since`, no timer.
- Sits between the conversation and the message box, outside the scroll area,
  so it stays in view when scrolled up.
- `role="status"` on the words only; the ticking timer is not announced.
  No pulse under `prefers-reduced-motion`.
- Styles from the Live Feedback Options artifact (`.strip`), using the app's
  theme tokens.

### 6.2 Waiting card

- Shown when `activity === 'waiting'`.
- Styles from the Conversation Pane Mockup (`.prompt`): red top edge, the
  eyebrow "Claude is waiting on you" with the Claude logo. The name and logo
  come from the session's provider. Only Claude reports `waiting` today.
- Heading: **Answer in the Terminal**. Line: "Claude is showing a question or
  a permission prompt." Primary button: **Open Terminal**.
- While shown:
  - the message box, attach button, Send and drop target are disabled;
  - the placeholder reads "Answer Claude's prompt above to keep typing"
    (with the provider's name);
  - typed text is kept.
- Main's `prompt_open` refusal stays as the backstop.
- Part 4 replaces the card's body with the real prompt and answer buttons.

## 7. Codex changes (main)

### 7.1 Interrupts

- The parser maps `event_msg` `turn_aborted` to `turn.completed` with payload
  `{ durationMs: null, turnId, aborted: true, reason }`, and adds
  `turn_aborted` to `KNOWN_EVENT_MSG`.
- Bump `CODEX_PARSER_VERSION` to 3. The plan must time the one-off re-read
  of existing Codex files and confirm the app stays responsive during it.

### 7.2 Busy check at send time

- For a Codex pid, `sendKeysFor` finds the session's rollout file
  (`source_file`) and reads at most its last 256 KB.
- Busy means: of the `event_msg` records `task_started`, `task_complete` and
  `turn_aborted`, the last one is `task_started`.
- If the file cannot be found or read, send as today (Enter). Log the reason.
  The Not seen warning covers a failure.
- A busy Codex gets the paste followed by Tab instead of Enter, and the reply
  is `{ status: 'sent', queued: true }`.
- For Claude, `queued` is true when `freshLiveSession` reports `busy`. Keys
  are unchanged, because Claude queues on Enter.

### 7.3 Measurement gate (first build task)

Against a real Codex in a throwaway tmux session, driving production
`sendKeysFor` code, verdict from the rollout (not the screen):

- **(c)** Busy Codex, paste then Enter: confirm the message is stranded. This
  proves the detector separates the outcomes.
- **(a)** Busy Codex, paste then Tab: is the message submitted after the turn
  ends (`user_message` after `task_complete`)?
- **(b)** Idle Codex, paste then Tab: what happens?

Decision:

- If (a) queues reliably, ship §7.2. Record (b) in `KNOWN_ISSUES.md`. It only
  matters when Codex finishes between the busy check and the key press.
- If (a) does not queue reliably, a busy Codex is refused with a new reason
  `agent_busy`: "Codex is working. Send when it finishes."

Use unique tags per run. Never send Escape between runs (it puts Codex in
backtrack mode).

## 8. Errors

- Every failure is logged with its cause. Anything that affects David is
  shown on screen. No silent failures and no broad catch-alls.
- An unreadable status file means `activity: null`: no strip, no countdown.
- An `fs.watch` error is logged and the session falls back to the 5-second
  sweep.
- An unknown or dead pid on `session:watch` is refused and logged.

## 9. Security

- `session:watch` takes only a validated integer pid that is already in the
  discovery cache. The watched file path is built from that integer, never
  from renderer text.
- Status and rollout reads keep bounded sizes (the existing live-session
  reader's checks; 256 KB for the rollout tail).
- `session:live` carries no transcript text. The pending entry shows only
  what David typed.
- No change to outbound sanitising. Tab is a fixed key sent by main, not
  renderer input.

## 10. Testing

Uses the existing vitest setup.

- **Unit:**
  - `turn_aborted` parsing;
  - the rollout-tail busy check (samples: busy, idle, interrupted, unreadable);
  - matching (Claude image text, Codex quoted file path, multi-line,
    attachments only, two quick sends, a turn older than `sentAt - 2s`);
  - the countdown running only while idle;
  - timer formatting;
  - `since` for both providers;
  - `session:watch` pid validation, coalescing and cleanup.
- **Component (ConversationView):**
  - the entry appears on Enter;
  - a refusal restores text and attachments;
  - Queued;
  - Not seen after 15 s idle, with fake timers;
  - the strip shows and hides;
  - the waiting card disables the box and keeps the draft.
- **Live:**
  - a throwaway vitest under `<scratchpad>/live/tests/` against real tmux
    Claude and Codex sessions, with the verdict from their logs;
  - the §7.3 measurements;
  - one full queued send to a busy Codex;
  - one send to a busy Claude.
- **Eyes on:** launch the app detached and have David check the strip, the
  waiting card, and the Queued and Not seen labels in both themes. A passing
  suite is not the finish line for a rendered surface.

## 11. Out of scope

- Answering prompts from the app (Part 4).
- Codex waiting states. The app has no reliable Codex waiting signal.
- Persisting pending entries across restarts.
- The rest of the mockup divergences from the Part 2 handoff.
