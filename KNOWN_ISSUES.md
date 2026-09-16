# Known issues

Things that are wrong, or only true under conditions worth naming, with what
is actually known rather than assumed. Each entry says how it was observed,
so the next person does not have to rediscover it.

## Multi-line messages do not submit in Codex

**Observed 2026-09-16 by David, in the running app.** Sending a multi-line
message to a **Codex** session from the conversation pane pastes the text into
the terminal's input but never submits it. Switching to the Terminal view shows
the message sitting there, complete and unsent. The app reports the send as
successful and clears the message box, so the message looks sent and is not.

Claude Code sessions are unaffected: a four-line message was confirmed by hand
the same day to arrive as a single prompt.

**What is known.** `sendKeysFor` (`src/main/ipc.ts`) is not provider-aware. It
sends the same three tmux commands regardless of which CLI is on the other end:

    load-buffer -b <name> -   ->   paste-buffer -p -d   ->   send-keys Enter

That sequence was measured against Claude Code on 2026-09-15 and again on
2026-09-16. **It has never been measured against Codex.** The plan for this work
recorded Codex as unverified on this path, and this is that gap showing up.

**What is not yet known.** Why the Enter does not submit. Candidates, none
confirmed: Codex may not request bracketed-paste mode (2004) at all; it may put
its input into a multi-line editing mode after a multi-line paste, where Enter
inserts a newline and something else submits; or it may need longer than the
paste settle allows before an Enter registers.

**Do not guess a fix.** The next step is a measurement against a real Codex
session -- what it does with a bracketed paste, and what key actually submits.

**Workaround.** Send single-line messages to Codex sessions, which use the
keystroke path (`send-keys -l` then Enter) and are unaffected. Or answer in the
Terminal view.

## Bracketed paste depends on the receiving program

A multi-line message is delivered as a tmux bracketed paste. That only behaves
as a paste if the receiving program has requested mode 2004. If it has not, the
text arrives as raw keystrokes with embedded newlines, and every line after the
first runs as its own prompt -- the exact failure the outbound newline refusal
originally existed to prevent.

Measured for Claude Code on 2026-09-15. Not measured for Codex (see above).

tmux exposes no format variable for a pane's mode-2004 state, so the app cannot
check this before sending. See the doc comment in `src/main/outbound.ts`.

## A successful send is not proof the message was submitted

`sendKeysFor` returns `{status:'sent'}` when all three tmux commands exit
cleanly. tmux exiting cleanly means tmux accepted the bytes. It says nothing
about whether the receiving program acted on them.

This is why the Codex issue above loses messages silently rather than failing
visibly: the app clears the message box on `sent`, discarding the draft.

A paste settle was added on 2026-09-16 (`src/main/ipc.ts`) that waits for the
pane to change before sending Enter, which closed a race against Claude Code.
It does not verify submission, and deliberately never refuses on timeout -- a
false refusal on a paste that did land would make the user resend and duplicate
a message in a live session.
