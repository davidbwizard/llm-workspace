# Known issues

Things that are wrong, or only true under conditions worth naming, with what
is actually known rather than assumed. Each entry says how it was observed,
so the next person does not have to rediscover it.

## FIXED 2026-09-17: a single-line message to Codex sat in its composer, unsubmitted

**Observed by David on 2026-09-16 at 21:28**, sending `Test`. The message
landed in Codex's composer and was never submitted; the app reported `sent`
and cleared the box. Codex's session log shows `Test` submitted at 21:30:44 --
by an Enter sent by hand, not the app's.

**The cause.** Codex's composer has a paste-burst heuristic (`paste_burst` in
the 0.154 binary, switchable with `disable_paste_burst`). A run of characters
arriving at once reads as a paste, and an Enter right behind it reads as part
of that paste rather than a submit. The app typed single-line text with
`send-keys -l` and sent Enter immediately after -- exactly that shape.

**Measured**, with Codex's own rollout file as the verdict, and the detector
proven first against a known submit and a known strand:

| send | submitted on the first Enter |
|---|---|
| `send-keys -l`, Enter immediately (the old single-line path) | **2 of 13** |
| `send-keys -l`, Enter 25ms or more later | 17 of 17 |
| bracketed paste, Enter 0-100ms later | 16 of 16 |

Claude Code, measured the same way, submitted every send on every path.

**The fix.** `sendKeysFor` delivers every message as a bracketed paste, single
line included. A bracketed paste declares itself, so there is no heuristic
left to trip -- this removes the race rather than out-waiting a threshold
Codex could change. Verified end to end by driving the real `sendKeysFor`,
production defaults throughout, into live sessions: Codex 10/10 single-line
and 3/3 multi-line, Claude Code 6/6 and 2/2.

**Still unexplained: the first report, 13:40 the same day.** That message was
multi-line, went out on the paste path, and stranded on a fresh, idle
session -- the paste path never stranded once in any measurement above.
Copy-mode (below) reproduces it exactly, but the pane's mode was not checked
at the time. If a multi-line send strands again, capture `#{pane_in_mode}`
and the session's rollout file before changing anything.

**Method note.** Probe runs on 2026-09-16 reported this failure reproducing
at every delay and on the paste path. They were void: the detector grepped
the screen for `› <text>`, which Codex also renders for a *submitted*
message; Escape presses between runs put Codex in backtrack mode; and a busy
Codex does not submit on Enter at all ("tab to queue message"). Codex's own
session log settled what the screen could not.

## FIXED 2026-09-17: an interrupted Codex turn read as working forever

Codex emits `turn_aborted` instead of `task_complete` when a turn is
interrupted (Esc), and never sends `task_complete` afterwards. The parser
did not recognize `turn_aborted` as a turn end, so the session's last kind
was never a turn end, and the card read "working" for as long as the Codex
process stayed alive.

**The fix.** The `event_msg` switch now treats `turn_aborted` as a turn end
too, emitting `turn.completed` with `aborted: true` and the reason from the
payload (`src/providers/codex/parse.ts`).

**The parser version was deliberately not bumped.** A version bump would
force a full re-read of every historical Codex file on next launch -- 33.5
seconds of blocked main process, measured against 617 files (260 MB) on
2026-09-17. Skipping it means a `turn_aborted` record written before this
fix stays stored under the old, unparsed reading. That cannot matter in
practice: a session only reads as "working" while its last event is within
`ACTIVE_MS` (30 minutes, `src/fleet/state.ts`) of now, so a session old
enough to carry a pre-fix `turn_aborted` has already aged out of "working"
by the time the fix lands.

Commit: `3effd6d`.

## Sending to a busy Codex (measured 2026-09-17)

The entry above's method note found that a busy Codex does not submit on
Enter at all, and that Codex's own UI says "tab to queue message". Measured
today whether Tab actually queues, and what it does on an idle session --
by the same rule as before, from Codex's own rollout file, never the
screen.

Locating the right rollout file needed a correction too. `~/.codex/sessions/
<date>/` is shared machine-wide; a real, unrelated session was actively
writing new files there while this ran, so "sort filenames, take the
newest" would have picked up someone else's session, not this measurement's
own. `~/.codex/state_5.sqlite` has a `threads` table with `cwd` and
`rollout_path` columns kept in sync live -- looking up the row for this
session's own tmux cwd gives the exact file instead.

**Detector validated first**, against a real busy/idle pair on one session:
a tagged message sent on a 900-line counting turn (confirmed genuinely
still running throughout -- the screen's own "Working (...)" indicator, and
an unchanged task_complete count in the rollout), and again once idle.

| condition | Enter | Tab |
|---|---|---|
| busy (confirmed still running) | submitted **~9s later**, while the original turn was still in progress -- not dropped | **queued** -- shown immediately in Codex's own "Queued follow-up inputs" panel, submitted within ~1s of the turn ending |
| idle | submitted ~2s later | submitted ~1s later -- same as Enter, no indentation or completion popup |

**Tab queues reliably.** On a confirmed-busy session it never showed as
submitted while the turn was still running, and the queued message went
out within about a second of the turn ending -- matching Codex's own
hint. On an idle session Tab behaves like Enter: it submits.

**busy+Enter no longer strands the message.** That is a change from the
entry above, measured the same reported version (`0.154.0`) as
2026-09-16. Not chased further here -- Task 3's question was about Tab, not
re-litigating Enter -- but it means a busy Codex reached by the wrong path
today risks the message landing in the live turn rather than being either
queued or safely dropped, worth keeping in mind if that path is ever relied
on again.

**Method note.** Codex's own UI does render "queued" recognizably
differently from "submitted" here (the "Queued follow-up inputs" panel),
unlike the submitted/unsubmitted case the entry above warns about. The
verdict was still the rollout file throughout, per the standing rule --
the screen was read only to sanity-check it, never to replace it.

## A slow trust-prompt accept can permanently hide a session's waiting card

**FIXED 2026-09-18**: `startTimeAgrees` (`src/providers/claude/
liveSession.ts`) now also accepts when the file's `procStart` string --
parsed into `procStartMs`, which Claude does not rewrite on a folder-trust
accept -- agrees with the process's real start within 2 s, so a rewritten
`startedAt` no longer blinds the session for its whole life.

Found live on 2026-09-17, driving two throwaway Claude sessions in `tmux`.

Claude rewrites `~/.claude/sessions/<pid>.json`'s `startedAt` when the
folder-trust prompt is accepted, to the moment session identity was
re-established, not the moment the OS process actually started.
`readLiveSession`'s `startTimeAgrees` check (`src/providers/claude/
liveSession.ts`) compares that `startedAt` against the process's real age
from `ps`, with a 5-second tolerance. If the trust screen is left open
longer than that, the check never agrees again, for the life of the
process -- `freshLiveSession` returns `null` for that pid permanently, so
`liveStatus` never reaches `deriveActivity`, and that session never shows a
waiting card for a permission prompt, a plan approval, or a question. It is
logged (`session file ignored (start time does not match the process)`)
and nothing else surfaces it.

**Measured**: accepting the trust prompt in ~1.5s left the session reading
correctly for its whole life; accepting it in ~15s (reading the security
notice, getting distracted -- plausible on a first run) broke it
permanently.

**Likely fix, not yet tried.** The same status file carries a separate
`procStart` field holding the process's actual start time. Comparing
against that instead of the rewritten `startedAt` would not be fooled by a
slow accept. Needs its own measurement before changing anything.

This is Part 1's exact-session-identity code, not this feature's, and
predates this branch.

## RESOLVED 2026-09-18: Claude hooks are not installed on this machine

Settings now has a **Quick answers** switch (`src/hooks/switch.ts`) that installs
and removes the app's hooks, pointing at a stable helper copy in
`~/.llm-workspace/bin/helper.sh`. With hooks on, a live status file outranks any
hook blocker (`deriveActivity`, `src/fleet/state.ts`), because a PermissionRequest
carries no tool_use_id and a No or Esc fires no event. Original note below.


`probeCapabilities()` reports `hooksInstalled: false`. The hooks in
`~/.claude/settings.json` are all the user's own (`block-env-read.sh`,
`block-destructive-bash.sh`, `claude-notify.sh`); none match
`isOwnedHookCommand`. That means `openBlockers` (`src/store/signals.ts`)
never has a row to find, for any session, so on this machine `waiting` can
only ever come from Claude's own live-session status file, never from the
hook-based blocker path the code also supports. Part 4 (quick responses)
needs a decision on this.

## FIXED 2026-09-16: a message sent to a pane in copy-mode was never submitted

Found while investigating the Codex issue above. It reproduces that symptom
exactly, but it is **not** what happened in the 21:28 occurrence, whose pane was
not in copy-mode.

**The cause.** A pane in tmux **copy-mode** -- its scrollback view -- routes
`send-keys` to copy-mode's own key table instead of to the program.
`paste-buffer` is unaffected, because it writes to the pty either way. So the
text lands in the composer normally, and the Enter after it is spent leaving
copy-mode instead of submitting. Both tmux commands exit 0, so `sendKeysFor`
answered `sent` and the renderer cleared the draft.

Every session this app creates sets `mouse on` (`src/main/launch.ts`), so one
wheel scroll in the Terminal view is all it takes to put a pane in copy-mode.

**Measured with an objective detector** -- a marker file the program creates,
not a reading of the screen. On a plain `bash` pane, same pane, same program,
only the mode differing:

| pane state | paste lands | Enter reaches the program |
|---|---|---|
| normal | yes | **yes** |
| copy-mode | yes | **no** -- `pane_in_mode` goes 1 -> 0 |

It is not provider-specific. Claude Code panes are affected identically, and
the single-line keystroke path is swallowed the same way (`send-keys -l` goes
to copy-mode too), so "send single-line messages instead" was never a
workaround for this.

**The fix.** `sendKeysFor` reads `#{pane_in_mode}` and leaves copy-mode before
sending anything. That is not a new liberty with the user's pane: the Enter left
copy-mode anyway, just by burning itself to do it. If the mode cannot be left,
the send is refused *before* anything is pasted, so the draft stays the user's
instead of being cleared for a message that would never have arrived. A pane
whose mode cannot be read is treated as not in one, so an unreadable mode can
never become a new way to refuse a send that would have worked.

## Bracketed paste depends on the receiving program

A multi-line message is delivered as a tmux bracketed paste. That only behaves
as a paste if the receiving program has requested mode 2004. If it has not, the
text arrives as raw keystrokes with embedded newlines, and every line after the
first runs as its own prompt -- the exact failure the outbound newline refusal
originally existed to prevent.

Measured for Claude Code on 2026-09-15 and for Codex on 2026-09-16: both report
`bracket_paste_flag=1`.

An earlier version of this entry said tmux exposes no format variable for a
pane's mode-2004 state. **It does**, on tmux 3.7c:

    tmux display-message -p -t <target> '#{bracket_paste_flag}'

Nothing reads it before sending today. Adding the check is not obviously the
right move: a program that has not requested bracketed paste is one this app
cannot safely send multi-line text to at all, so the open question is what to do
*instead* of sending -- refuse, or fall back to something else -- not how to
detect it. See the doc comment in `src/main/outbound.ts`.

## A successful send is not proof the message was submitted

`sendKeysFor` returns `{status:'sent'}` when all three tmux commands exit
cleanly. tmux exiting cleanly means tmux accepted the bytes. It says nothing
about whether the receiving program acted on them.

This is why both issues above lost messages silently rather than failing
visibly: the app clears the message box on `sent`, discarding the draft.

**Still open.** Copy-mode and Codex's paste-burst heuristic were two ways for
an Enter to go nowhere; there is no reason to think they are the only two. `sendKeysFor` still returns `sent` when the
Enter itself fails -- that failure is logged, never surfaced -- so the same
silent loss remains reachable. It stays deliberate for now: the text has already
been pasted into a live session by then, and refusing would invite a retry that
duplicates it. Closing it properly means verifying submission rather than
reporting delivery, which is a bigger change than this entry's fix.

A paste settle was added on 2026-09-16 (`src/main/ipc.ts`) that waits for the
pane to change before sending Enter, which closed a race against Claude Code.
It does not verify submission, and deliberately never refuses on timeout -- a
false refusal on a paste that did land would make the user resend and duplicate
a message in a live session.

## A preview question refused twice right after the app restarted (2026-09-21)

Unexplained, not reproduced. The first AskUserQuestion carrying previews after
a dev-app restart was refused twice with `reason: 'unconfirmed'` -- the card
was clickable, David clicked, and nothing happened. The same question, word for
word, was answered from the card minutes later, as were two others (one needing
two `Down` presses, one with long wrapping labels). So it is not previews, not
label length, and not moving the focus: all three are covered by passing tests
and were re-verified by hand.

`unconfirmed` means the answer path never got a pane read proving the wanted
option was focused, so it pressed nothing. The guard behaved correctly; the
cost was a click that did nothing, with no explanation offered to the person.

**Suspect, unproven:** on startup the app attaches a pty client to each tmux
session and tmux resizes the pane to that client. A prompt drawn before the
resize and read after it would be laid out at one width and matched at another.
Captures taken during all three later tests show a steady 297-column pane, but
none of those windows covers the failure, so this neither confirms nor kills it.

Worth a look if it recurs: log the captured pane text on `unconfirmed` so the
next occurrence carries its own evidence, and tell the person the click was
refused rather than letting it look inert.

## A `!` bash-mode command sticks in the conversation forever (2026-09-21)

Send `! open .` from the app and the message never resolves: it sits in the
conversation labelled "Not seen by Claude", indefinitely.

**Root cause, confirmed against the transcript.** Claude Code records bash mode
as `<bash-input> open .</bash-input>` -- the `!` stripped, the text wrapped.
`NON_HUMAN_PREFIXES` in `src/providers/claude/parse.ts` lists `<bash-input>`
alongside `<bash-stdout>` and `<bash-stderr>`, so `isHumanPrompt` returns false
and the record never becomes a user turn. The pending matcher looks for a user
turn containing the sent text, never finds one, and the entry sticks.

The classification is wrong for that one entry. stdout and stderr genuinely are
not human -- they are output. `<bash-input>` is the exact characters the person
typed. It was grouped with its own output by name rather than by nature.

**Slash commands are NOT affected.** `<command-name>` is deliberately absent
from that list and `store/conversation.ts` unwraps it for display, which is the
precedent the fix should follow.

**Fix:** treat `<bash-input>` as human and unwrap it for display, as
`<command-name>` already is. Keep `<bash-stdout>` / `<bash-stderr>` non-human.
Consequence to weigh first: bash-mode commands would then appear in the
conversation view, where today they are invisible. That is arguably correct --
the person typed them -- but it is a visible change and David has not ruled on
it. A narrower fix that only resolves the pending entry would leave the message
vanishing rather than showing as sent, which is its own oddity.

## The staged-image sweep tries to unlink directories, forever (2026-09-22)

Every launch logs, twice:

```
sweeping a staged image failed: EPERM: operation not permitted, unlink
  '.../llm-workspace-attachments/9948d14f-...'
```

Not a permissions problem and not two instances competing, which is what it
looks like. `createStager`'s sweep (`src/main/staging.ts:72`) stats each
`readdir` entry and calls `unlink` on anything older than the cutoff, without
checking WHAT it is. Two entries in that directory are directories, not files:

```
drwxr-xr-x@ 2 davidbrabbins staff 64 Sep 21 03:35 9948d14f-a35a-4ace-9dd9-f9dd3378a612
drwxr-xr-x@ 2 davidbrabbins staff 64 Sep 21 03:35 95c9d5aa-14d4-4bd8-9095-9a44d06a354f
```

`unlink` on a directory returns EPERM on macOS. Measured directly: `unlink
a-directory` -> EPERM, `unlink a-file` -> OK. So the sweep fails on the same
two entries on every launch and can never clear them.

**Fix:** check `isDirectory()` before unlinking, and decide deliberately
whether a stray directory should be removed recursively or left alone and
reported once rather than every launch. The wider point is that the catch
swallows every reason equally -- a permission problem, a directory, and a
genuinely undeletable file all log the same line.

## An ingest write that outwaits the busy timeout crashes the main process (2026-09-22)

Found by reading, not by seeing it fail, while investigating whether a packaged
build running beside a dev build contend on `~/.llm-workspace/index.sqlite`.
**They do not**, in practice: WAL is on and better-sqlite3's 5s busy timeout is
already in place, so a second writer waits rather than failing, and these
writes take milliseconds. Measured on a copy, never the live file:

```
journal_mode  = wal
busy_timeout  = 5000
second writer = database is locked  (after 5185ms)
```

The latent gap is what happens if a write ever does exceed that 5 seconds.
`ingestSpool` runs in a bare `setInterval` (`src/main/index.ts:174`) and
`ingestAll` inside `startBackgroundWork`; neither is wrapped, so the throw
becomes an unhandled exception in the main process. Low probability, real
consequence, and it gets more likely the more instances someone runs -- which
a tester with a packaged build beside a dev one is doing by definition.

Unrelated to the above: `Failed to delete the database: Database IO error
(service_worker_storage)` when two builds run together is Chromium's own
storage, not the app's index -- both resolve userData to the same path from the
same package name. Expected, and not something the app controls.

## A Codex prompt never reaches the conversation, and none of them can

**Observed by David on 2026-09-24.** Codex asked `Allow Computer Use to use
"Google Chrome"?` with the usual four-option list (Allow / Allow for this
session / Always allow / Cancel). The prompt sat in the terminal; the app's
conversation view never showed it and the card never went to waiting. David's
read at the time -- "I suspect none of the prompts will be visible" -- is
correct, and it is structural rather than a missed case.

**The cause.** Every prompt this app surfaces arrives as a hook event.
`src/store/signals.ts:27` treats exactly two kinds as blocking:

    const BLOCKING = new Set(['PermissionRequest', 'Elicitation']);

Both are written by hooks that `src/hooks/install.ts` installs into
`~/.claude/settings.json` (`config.ts:30`, `claudeSettings`). Verified on the
dev machine: 15 hook events are installed, all of them Claude Code's.

**Codex has no hook system**, so nothing can write those rows for a Codex
session. `currentBlockers` therefore returns nothing for Codex, the card
never reads `waiting_permission`, and the Conversation view has no prompt to
render. Not one Codex prompt -- any of them, of any kind.

A second gap points the same way: `src/main/sessionLive.ts:319` records that
"Codex writes no live-session file", so the other path that gives a Claude
session its live `waiting_permission` status has no Codex equivalent either.
Both of the app's routes to "this session is waiting on you" are Claude-only.

**What this does NOT affect.** Codex sessions are still discovered, still
listed, and their transcripts still ingest -- the rollout parser
(`src/providers/codex/parse.ts`) is unrelated to this. It is specifically
prompts, and the waiting state that goes with them.

**Not yet investigated**, and the thing to establish before designing a fix:
whether a Codex prompt is detectable from its rollout file, or only from the
pane's own screen. The app already reads a pane's screen for the quick-answers
flow (`src/main/promptScreen.ts`), so a screen-based detector may be the only
route -- in which case it inherits every fragility of screen-scraping, and the
detector has to be proven to separate a real prompt from a session that merely
printed the same words.
