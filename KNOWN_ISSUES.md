# Known issues

Things that are wrong, or only true under conditions worth naming, with what
is actually known rather than assumed. Each entry says how it was observed,
so the next person does not have to rediscover it.

## FIXED 2026-09-16: a message sent to a pane in copy-mode was never submitted

**Observed 2026-09-16 by David, in the running app**, and recorded here as a
Codex-only bug. It was not. The cause had nothing to do with which CLI was on
the other end, and the original diagnosis below was wrong in three ways worth
keeping, because each one is a trap the next person could fall into again.

**What was reported.** A multi-line message sent to a Codex session pasted into
the terminal's input but never submitted. The Terminal view showed it sitting
there, complete and unsent. The app reported the send as successful and cleared
the message box, so the message looked sent and was not.

**The actual cause.** A pane in tmux **copy-mode** -- its scrollback view --
routes `send-keys` to copy-mode's own key table instead of to the program.
`paste-buffer` is unaffected, because it writes to the pty either way. So the
text landed in the composer normally, and the Enter after it was spent leaving
copy-mode instead of submitting. Both tmux commands exited 0, so `sendKeysFor`
answered `sent` and the renderer cleared the draft.

Every session this app creates sets `mouse on` (`src/main/launch.ts`), so one
wheel scroll in the Terminal view is all it takes to put a pane in copy-mode.

**Measured, not inferred.** On a live Codex session and on a plain `bash` pane,
same pane, same program, only the mode differing:

| pane state | paste lands | Enter reaches the program |
|---|---|---|
| normal | yes | **yes** |
| copy-mode | yes | **no** -- `pane_in_mode` goes 1 -> 0 |

**Three things the original entry got wrong.**

- *"Claude Code sessions are unaffected."* They are affected identically. They
  looked fine because those panes happened not to be in copy-mode.
- *"Workaround: send single-line messages, which use the keystroke path and are
  unaffected."* `send-keys -l` is swallowed by copy-mode exactly as Enter is, so
  the documented workaround was broken too.
- *"Codex may not request bracketed-paste mode (2004) at all."* It does --
  `bracket_paste_flag=1`, the same as Claude Code.

**The fix.** `sendKeysFor` reads `#{pane_in_mode}` and leaves copy-mode before
sending anything. That is not a new liberty with the user's pane: the Enter left
copy-mode anyway, just by burning itself to do it. If the mode cannot be left,
the send is refused *before* anything is pasted, so the draft stays the user's
instead of being cleared for a message that would never have arrived. A pane
whose mode cannot be read is treated as not in one, so an unreadable mode can
never become a new way to refuse a send that would have worked.

**What this says about the method.** Three candidate causes were written down
from the symptom, and all three were wrong. The measurement that settled it took
one command: put a pane in copy-mode and watch `pane_in_mode` go 1 -> 0 as the
Enter is consumed.

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

This is why the copy-mode bug above lost messages silently rather than failing
visibly: the app clears the message box on `sent`, discarding the draft.

**Still open after that fix.** Copy-mode was one way for an Enter to go
nowhere; it is not the only one. `sendKeysFor` still returns `sent` when the
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
