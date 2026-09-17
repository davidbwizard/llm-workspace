# Known issues

Things that are wrong, or only true under conditions worth naming, with what
is actually known rather than assumed. Each entry says how it was observed,
so the next person does not have to rediscover it.

## OPEN: a message sent to a Codex session sits in its composer, unsubmitted

**Observed twice by David on 2026-09-16, in the running app.** Cause unknown.

**What happens.** The message lands in Codex's composer, complete, and is never
submitted. The app reports `sent` and clears the message box, so the message
looks sent and is not.

**What was measured on the second occurrence (21:28, single-line `Test`).**
The running bundle already contained the copy-mode fix below. The pane was
*not* in copy-mode (`pane_in_mode=0`), requested bracketed paste
(`bracket_paste_flag=1`), used the default key mode (`pane_key_mode=VT10x`),
and had no attached client. The text arriving means `send-keys -l` succeeded,
and a failed Enter is logged -- nothing was logged, so tmux accepted the Enter
too. A `tmux send-keys -t <target> Enter` sent by hand a few seconds later
submitted the message immediately.

So Codex was able to take an Enter from tmux on that pane. The one the app sent
alongside the text did not submit. Why is not known.

**The first occurrence (13:40, multi-line)** is the one this file originally
recorded. The session was mid-way through a 2m24s task at the time, and the
pane's mode was never checked, so copy-mode may or may not explain it.

**Do not trust the follow-up measurements from that night.** Several probe runs
reported the failure reproducing on a fresh Codex session, at delays up to 2s
and through the paste path too. All of them are void:

- The detector grepped the pane for `› <text>`. Codex renders a *submitted*
  message in exactly that form in its transcript, so the check matched both
  outcomes.
- Probe scripts pressed Escape between runs to "reset". In Codex that enters
  backtrack mode, where typed text goes nowhere and Enter means "edit message".
- Codex was sometimes still working, and a busy Codex footer reads "tab to
  queue message": Enter is not the submit key in that state.

**Next step.** Re-measure with a detector proven to separate the two outcomes
before any run is trusted: check it once against a known submit and once
against a known strand. Codex's own rollout file under `~/.codex/sessions`
gaining the user message is an objective signal that does not depend on reading
the screen. Test idle and busy separately, and never send a "reset" key without
knowing what it does in Codex.

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

This is why both issues above lose messages silently rather than failing
visibly: the app clears the message box on `sent`, discarding the draft.

**Still open.** Copy-mode was one way for an Enter to go nowhere; the Codex
issue above shows it is not the only one. `sendKeysFor` still returns `sent` when the
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
