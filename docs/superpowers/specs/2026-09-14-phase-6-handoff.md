# Phase 6 Handoff — what shipped, what broke, what it cost

**Date:** 2026-09-14 (revised end of day)
**Status:** merged to `main`. The terminal now works and has been confirmed by
eye. 781 tests, 50 files.
**Spec:** `2026-09-12-phase-6-launch-and-reply-design.md`
**Plan:** `../plans/2026-09-12-phase-6-launch-and-reply.md`

---

## Read this part first

**684 passing tests did not catch a single one of the bugs David found by
opening the app.** Not one. Six on the terminal, then a blank screen, then a
conversation view showing the wrong 500 turns. The suite mocks xterm, mocks the
DOM, lays nothing out, and never restarts the process — so it is structurally
blind to the entire class of defect this phase had.

The tests were not bad. They were mutation-tested and the mutations were real.
They were pointed at the wrong thing.

**The rule this phase earned:** for anything with a rendered surface, a green
suite is permission to go look, not evidence that it works.

A second rule, learned the hard way at the end: **tests run under Node, the
renderer does not.** A `node:os` import that resolves perfectly in vitest
throws in a sandboxed renderer and paints a blank window, with a clean log and
a green suite. Nothing in the harness can see that.

## What the app does now

One window. The card grid is home; selecting a session turns it into a
resizable left rail and gives the main area to that session, as **Conversation**
(parsed transcript) or **Terminal** (live). Sessions can be launched from the
app, replied to, scrolled, and — for sessions already running in plain iTerm —
reattached under tmux so they become interactive.

Confirmed working on the real machine: launch with the trust prompt correctly
left unanswered, answering it from the app, a typed reply reaching the agent and
landing in the ordinary transcript, sessions surviving the app quitting, and the
embedded terminal rendering and scrolling.

## The terminal: five bugs, one root cause, then an architecture change

| # | Bug | Cause |
|---|---|---|
| 1 | Stretched, overlapping text | `fontFamily: 'var(--f-mono)'` — canvas text measurement never resolves a CSS custom property |
| 2 | Content clipped, stranded scrollbar | `.term`/`.term-wrap` missing `min-width:0`, so xterm's canvas pinned its own container wide and `fit()` could never shrink back |
| 3 | "Not running inside tmux" after a restart | the pid→tmux registry was in-memory, written only at launch, rebuilt by nothing |
| 4 | Mid-word wrapping on first load | `capture-pane` ran before the program repainted at the new size |
| 5 | Mid-word wrapping on every view switch | attach ran on the mount tick with the pre-fit width, before the corrected fit |

Four of the five are the same root cause in different clothes: **the app was a
fake tmux client.** It copied output out with `pipe-pane` and poked keys in with
`send-keys` but never attached, so it hand-rolled everything a real client gets
free — size negotiation, redraw-on-resize, scrollback — and each hand-rolled
piece broke its own way.

Fixing them one at a time was the wrong strategy and cost most of a day. The
signal to switch was visible after bug 3 and was not acted on until bug 5.

**The fix (`c26faba`):** `tmux attach -t =<session>:` now runs inside a
**node-pty**, and xterm renders that. The app is a real client. `pty.resize()`
makes tmux resize itself; tmux redraws on attach, correctly sized; there is no
backlog to capture at the wrong width because there is no backlog. **546
insertions, 815 deletions** — most of what went was the machinery to fake being
a client, which is where every bug lived.

`node-pty@1.1.0` is compiled against Electron 44.3.0 arm64, and
`scripts/check-native-abi.ts` was generalised from one hardcoded package to a
list so it rebuilds both `better-sqlite3` and `node-pty`.

## The blank screen (`e51b482`) — the sharpest lesson

`SessionRail` imported a comparator **as a value** from `src/fleet/state.ts`,
whose first line is `import { tmpdir } from 'node:os'` and which reaches the
database. A sandboxed renderer has neither: the module threw at load, React
never mounted, the window painted nothing — with a clean dev-server log, both
processes healthy, and 781 tests green.

Ordering now lives in `src/fleet/order.ts`, which imports nothing at all. It
declares the minimal shape it reads rather than importing `OpenSession` — that
import was type-only and erased, but still formed a cycle — and is generic so
callers keep their own types.

**Structural rule:** anything the renderer imports for its VALUE must live in a
module with no Node imports. Nothing in the test harness enforces this. A lint
rule banning `node:*` from anything reachable by `src/renderer/**` would, and is
worth adding.

## What else shipped today

Launch bar gained a native folder picker. Conversations show the newest turns
(they showed the **oldest 500** — on a 2,812-turn session that is the opening
18%, from days ago, with no indication anything was hidden), lazy-load 50 at a
time on a keyset cursor, carry per-turn timestamps, and distinguish the user's
turns structurally rather than by colour alone. Cards sort by relevance
— blocked on the user, then unread, then recent activity, junk last — rather
than by process age, which is what "how are you sorting what's relevant?"
revealed. Unread cards carry their own treatment, subordinate to "waiting on
you". The rail is resizable and persists its width. tmux's status line is off
and mouse scrolling is on, both per-session, never `-g`.

## Open items

**Do these first:**

1. **Delete `resizeWindow`, `paneSize` and `pipePane` from `src/main/tmux.ts`.**
   Verified: **zero production callers**. Their only remaining callers are their
   own unit tests, which is worse than no tests — it reads as coverage while
   covering nothing anyone runs. The pty path replaced all three. Phase 4's doc
   records this exact pattern shipping last time.
2. **Add a lint rule** banning `node:*` imports from anything reachable by
   `src/renderer/**`. This is the only defence against the blank-screen class,
   and it is a structural check, not a test.

**Known races, reachable, unfixed:**

3. `attachTerminal` is async, so two concurrent `session:attach` calls for one
   pid can both pass the idempotency check. React StrictMode double-mounts in
   dev, so this is reachable here.
4. `session:resize` and `session:raw` refuse with `session_gone` when a pid
   resolves as live tmux but has no attachment yet — the widget's first
   fit-triggered resize can beat attach. Harmless, misleading when debugging.

**Deferred with reasons:**

5. Spec §12's Codex multi-binary probe. Launch resolves via PATH, so Codex
   works; on this machine two binaries exist and there is no way to choose.
6. History cards have no click target. Selecting one needs a different selection
   shape — keyed by session id, no pid, conversation-only.
7. `src/renderer/types.d.ts` references `RevealResult` without importing it.
   Pre-existing, masked by `skipLibCheck`.
8. `lastProse` card previews render markdown literally and join without
   separators (`collide.**Lazy loading** uses…`). Cosmetic, affects every card.

## Two failure modes that cost real time

**A resource leak in the code under test degraded the machine running the
tests.** 538 orphaned `sh -c cat >> …fifo` processes, 3.5 GB, some two days
old — the `pipe-pane` writers. Every run of `stream-bridge.test.ts` leaked one:
the test killed its tmux session without stopping `pipe-pane`, so the `cat` was
reparented to PID 1 and blocked forever on a pipe with no reader. It presented
as the dev server being killed by memory pressure, which looks like unrelated
tooling failure. The node-pty change deletes the fifo, so it cannot recur — but
nothing in the suite noticed, and **a test that spawns a process should assert
it is gone afterwards.**

Note `pkill -f "llm-workspace-terminal-pipes"` is unsafe: the pattern matches
the shell running it. Use:

```bash
ps -Ao pid,ppid,command | awk '$2==1 && /sh -c cat >>/ && /llm-workspace-terminal-pipes/ {print $1}' | xargs kill
```

**`tests/fleet/state.test.ts` intermittently takes its vitest worker down** with
a V8 GC crash inside `better-sqlite3`'s native addon — the Node 24.19.0
regression phase-4 records (nodejs/node#63642). Roughly one run in three.
Reproduced on unmodified HEAD. It presents as "Worker exited unexpectedly",
**zero tests run, no assertion error**, and a test count silently short of the
total — which reads exactly like your own change breaking something. Electron is
unaffected; this is the test runner only.

## Process notes that earned their place

- **A green suite is permission to go look.** Eight bugs, 781 tests, zero
  overlap.
- **Measure before diagnosing.** `tmux display-message -p '#{pane_width}'`,
  `tmux list-clients`, and a `sqlite3` count answered in seconds what several
  rounds of reasoning got wrong. The instruments existed the whole time.
- **Screenshots beat reasoning, and the assistant cannot take them.** Three
  rounds were spent fixing a rendering bug remotely from descriptions. Granting
  the terminal Screen Recording permission would close that loop.
- **Two implementers on one working tree corrupts evidence.** One agent
  "repaired" another's in-flight mutation test, producing the phantom failure
  phase-4 warned about. Reviewers may overlap with an implementer — they read a
  static diff. Implementers may not.
- **Ask what the bug CLASS is, not what the bug is.** After the third variation
  on "the app does not know its own size", the answer was architectural.
- **`git checkout --` reverts to HEAD, not to before your edit.** An agent
  used it to undo a mutation and wiped its own uncommitted work. Copy the file
  aside instead.
- **A boundary value needs coercing, not comparing.** `junk` crosses IPC; an
  absent field arrives as `undefined`, and `undefined !== false` is true, which
  misfires a sort tier silently rather than failing loudly.
