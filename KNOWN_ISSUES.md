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
