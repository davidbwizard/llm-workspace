# Phase 6 Handoff — what shipped, what broke, what it cost

**Date:** 2026-09-14
**Status:** Phase 6 is merged to `main` (35 commits past `ff0762c`). The
terminal works in tests and has never once been confirmed working by eye.
**Spec:** `2026-09-12-phase-6-launch-and-reply-design.md`
**Plan:** `../plans/2026-09-12-phase-6-launch-and-reply.md`

---

## Read this part first

**684 passing tests did not catch a single one of the six bugs David found by
opening the app.** Not one. The suite mocks xterm, mocks the DOM, never lays
anything out, and never restarts the process — so it is structurally blind to
the entire class of defect this phase actually had.

The tests were not bad. They were mutation-tested, and the mutations were real.
They were simply pointed at the wrong thing. Phase 4's inherited-risks doc says
"every serious defect in three phases was found by running against real data."
That held again, and it will hold next time.

**The practical rule this phase earned:** for anything with a rendered surface,
a green suite is permission to go look, not evidence that it works.

## What was built

One window. The card grid is the home screen; selecting a session turns it into
a left rail and gives the main area to that session, as Conversation (parsed
transcript) or Terminal (live). A session can be launched from the app, replied
to, and — for sessions already running in plain iTerm — reattached under tmux
so it becomes interactive.

Working and confirmed on the real machine:

- launch, with the trust prompt correctly left unanswered
- answering that prompt through the app
- a typed reply reaching the agent and landing in the ordinary transcript
- sessions surviving the app quitting
- the fifo directory at 0700

Not confirmed by eye, ever: the terminal rendering correctly.

## The six bugs, and what they have in common

| # | Bug | Cause |
|---|---|---|
| 1 | Stretched, overlapping text | `fontFamily: 'var(--f-mono)'` — canvas text measurement never resolves a CSS custom property |
| 2 | Content clipped, stranded scrollbar | `.term`/`.term-wrap` missing `min-width:0`, so xterm's canvas pinned its own container wide and `fit()` could never shrink back |
| 3 | "Not running inside tmux" after a restart | the pid→tmux registry was in-memory, written only at launch, rebuilt by nothing |
| 4 | "Several open sessions share this directory" with one session open | one message used for two different match failures; the ambiguity is against *recorded* sessions, not open ones |
| 5 | Mid-word wrapping on first load | `capture-pane` ran before the program repainted at the new size |
| 6 | Mid-word wrapping on every view switch | attach ran on the mount tick with the pre-fit width, before the corrected fit |

Five of the six are the same root cause wearing different clothes: **the app was
a fake tmux client.** It copied output out with `pipe-pane` and poked keys in
with `send-keys`, but never attached. So it had to hand-roll everything a real
client gets free — size negotiation, redraw-on-resize, scrollback — and each
hand-rolled piece broke in its own way.

Fixing them one at a time was the wrong strategy and cost most of a day. The
signal to switch was visible after bug 3 and was not acted on until bug 6.

## The architecture change (commit `c26faba`)

`tmux attach -t =<session>:` now runs inside a **node-pty**, and xterm renders
that. The app is a real client:

- `pty.resize()` → tmux resizes the window itself. No `resize-window`, no race.
- tmux redraws on attach, correctly sized. No `capture-pane` backlog at all.
- pty bytes go straight to xterm. No fifo, no permissions, no ordering queue.
- the tmux session still outlives the app, so detach/reattach still work.

**546 insertions, 815 deletions.** Most of what went was machinery to fake being
a client — which is where every bug lived.

`node-pty@1.1.0` is compiled against Electron 44.3.0 arm64.
`scripts/check-native-abi.ts` was generalised from one hardcoded package to a
list, and now rebuilds both `better-sqlite3` and `node-pty`.

**This change is unverified by eye.** It is the first thing the next session
should confirm. The check that does not need a screen:

```bash
tmux list-clients -F '#{client_tty} -> #{client_session} (#{client_width}x#{client_height})'
```

A real client with dimensions matching the visible terminal means the
architecture is working. An empty list means attach is failing.

## Open items

**Blocking a confident "done":**

1. Confirm the node-pty terminal renders correctly, by looking at it.
2. `resizeWindow`, `paneSize` and `pipePane` in `src/main/tmux.ts` now have
   **zero production callers** — verified. Their only remaining callers are
   their own unit tests, which is worse than no tests: it reads as coverage
   while testing nothing anyone runs. Delete all three and their test blocks
   once the pty path is confirmed. Phase 4's doc records this exact pattern
   shipping last time.

**Known races, both reachable, neither fixed:**

3. `attachTerminal` is async, so two concurrent `session:attach` calls for the
   same pid can both pass the idempotency check. React StrictMode double-mounts
   in dev, so this is reachable here, not theoretical.
4. `session:resize` and `session:raw` refuse with `session_gone` when a pid
   resolves as live tmux but has no attachment yet. The widget's first
   fit-triggered resize can beat attach, so a refusal on mount is normal —
   harmless today, misleading when debugging.

**Deferred with reasons, not forgotten:**

5. Spec §12's Codex multi-binary probe/choose/remember. Launch resolves via
   PATH, so Codex works; on this machine two binaries exist
   (`/opt/homebrew/bin/codex` and the ChatGPT.app bundled copy) and there is no
   way to pick. No IPC contract was ever specified for the chooser.
6. History cards have no click target. Selecting one needs a different
   selection shape — keyed by session id, no pid, conversation-only, since
   there is no live process to attach a terminal to.
7. `src/renderer/types.d.ts` references `RevealResult` without importing it.
   Pre-existing, masked by `skipLibCheck`. Left alone deliberately.

## The process leak, and why it matters beyond itself

The dev server was killed twice by memory pressure. The cause was **538
orphaned `sh -c cat >> …fifo` processes, 3.5 GB**, some two days old — the
`pipe-pane` writers from the fifo transport. Every run of
`stream-bridge.test.ts` leaked one: the test killed its tmux session without
stopping `pipe-pane` first, so the `cat` was reparented to PID 1 and blocked
forever on a pipe with no reader.

The `c26faba` change deletes the fifo, so it cannot recur. But note what
happened: **a resource leak in the code under test degraded the machine running
the tests, and presented as an unrelated tooling failure.** Nothing in the suite
noticed. A test that spawns a process should assert it is gone afterwards.

To clear any survivors — and note `pkill -f "llm-workspace-terminal-pipes"`
is unsafe, because the pattern matches the shell running it:

```bash
ps -Ao pid,ppid,command | awk '$2==1 && /sh -c cat >>/ && /llm-workspace-terminal-pipes/ {print $1}' | xargs kill
```

## Process notes that earned their place today

- **A green suite is permission to go look.** Six bugs, 684 tests, zero overlap.
- **Screenshots beat reasoning.** Three rounds were spent fixing a rendering bug
  remotely from descriptions. Granting the terminal Screen Recording permission
  would let the assistant capture and read the window itself; without it, every
  visual loop costs a round trip through the user.
- **Two implementers on one working tree corrupts evidence.** It happened once:
  one agent "repaired" another's in-flight mutation test, producing exactly the
  phantom failure phase-4 warned about. Reviewers may overlap with an
  implementer — they read a static diff. Implementers may not.
- **Ask what the bug class is, not what the bug is.** After the third variation
  on "the app does not know its own size," the answer was architectural.
- **Measure before diagnosing.** `tmux display-message -p '#{pane_width}'` and
  `tmux list-clients` answered in seconds what several rounds of reasoning got
  wrong. The instrument existed the whole time.
