# Phase 6 Handoff — launching and replying from the app

**Date:** 2026-09-11
**Status:** starting point for the next session. Not a plan; a brief.
**Spec:** `2026-09-10-llm-workspace-design.md` section 10 is the binding design.
**Read first:** `2026-09-11-phase-4-inherited-risks.md`.

---

## Why this, ahead of the graph

The plan ordered phases graph (4), Needs You rail (5), then tmux and PTY (6).
David reordered it after a day of using the fleet view, and the reasoning is
worth keeping: the graph is observation, and he has enough of that now. What
changes how he works is acting on a session without leaving the app.

The original ask has three parts. Two are done — noise reduction (the card shows
the last meaningful thing said, not the bash spam) and cross-provider visibility.
The third, the hierarchy graph, is still ahead. This phase is a fourth thing he
arrived at by using it: **reply where you are looking.**

## What it is

    app ──attaches to──▶ tmux session ──runs──▶ claude | codex

The app is a viewer of a run it does not own. Quit or crash the app and the run
continues; reopen and reattach. That is a deliberate divergence from
munder-difflin, which kills every PTY on quit and therefore needs a
quit-warning modal.

Two capabilities, and they are separable — either is useful alone:

1. **Launch** — start a session in a chosen directory, from the app.
2. **Reply** — type into a session the app owns, from its card.

## The hard constraint, stated plainly

**Only sessions the app launches are replyable.** You cannot push input into
another process's stdin from outside. A session already running in iTerm2 outside
tmux cannot be typed into — the best available for those is the jump action built
in Phase 3, which now selects the exact iTerm tab by tty.

So this is forward-looking, not retroactive. David's twelve current sessions stay
observe-and-close. Anything started from the app afterwards is fully interactive,
and over time that becomes most of them. **Say this in the interface**, or a card
with no reply box will read as broken rather than as out of scope.

A session that happens to already be running inside tmux can be sent keys with
`tmux send-keys`. Worth checking whether any of his are; do not assume.

## Ground truth on this machine, verified 2026-09-11

    tmux        NOT INSTALLED  -- `brew install tmux` is a prerequisite
    claude      /Users/davidbrabbins/.local/bin/claude
    codex       /opt/homebrew/bin/codex
    codex       /Applications/ChatGPT.app/Contents/Resources/codex  (also present)

`probeCapabilities` in `src/config.ts` already detects tmux and reports it as a
capability. Launch buttons render from probed capabilities and show the reason
when disabled — so "install tmux" should be a visible, explained absence, not a
dead button.

Note the two Codex binaries. Spec 10.2 is explicit: probe `PATH`, common install
roots and bundled app resources, record every hit, let the user choose, remember
the choice per provider. Revision 1 of the spec wrongly concluded Codex was not
installed by checking only one location.

## What already exists to build on

- `probeCapabilities` (`src/config.ts`) — tmux detection, hook installation state.
- `src/discovery/live.ts` — finds running agent processes, with host, tty, age,
  memory. A launched run will appear here like any other, which is what makes the
  fleet view show it without special-casing.
- The IPC surface (`src/main/ipc.ts`, `src/preload/index.ts`) — four enumerated
  channels, each validated in main, with a parity test pinning the preload against
  main's handlers and an exhaustiveness gate on every field crossing the boundary.
  A PTY stream is a new shape for this surface; it is the first thing that is not
  a request/response.
- `session:kill` is the precedent for a main-side action on a process: the
  renderer sends only a pid, main revalidates against its own fresh discovery.

## Decisions already made, do not relitigate

- **tmux, not a bespoke supervisor.** Inspectable, recoverable by hand, and it
  gives real remote control — a session can be attached from iTerm2 or over SSH.
- **Naming:** `llmws-<provider>-<short-session-id>`, so runs are identifiable in
  `tmux ls` and recoverable manually.
- **Nothing spawns on its own.** Launch is explicit: choose provider and
  directory.
- **The renderer is untrusted.** Everything crossing into it is sanitised in main.
  A PTY stream is agent-authored bytes at high volume — the existing
  `sanitizeForDisplay` handles control characters and bidi overrides, but terminal
  output is a different problem from prose and deserves its own thought.

## Open questions for David, before building

1. **Does the card become a terminal, or a prompt box?** A full terminal emulator
   is a different product from "type a reply and see the answer". He has said he
   likes embedded terminals and wants to do everything from the app eventually —
   but the noise problem that started this project was too much terminal.
2. **What happens to the card's clean view while attached?** The card currently
   shows the last meaningful thing said. If it becomes a terminal, that is gone.
3. **Launch only, first?** Launching without replying is smaller, useful on its
   own, and would tell us whether the tmux plumbing works before the interface
   question is settled.

## Process notes that apply directly here

- **Mockups before building.** A standing instruction, and this phase changes the
  card, which is the most-looked-at surface in the app.
- **Verify on the real machine, not fixtures.** Every serious defect in three
  phases was found by running against real data.
- **Restart the app by killing the Electron process, not the dev server.** A stale
  window hot-reloads the new renderer onto an old preload and main, producing
  symptoms indistinguishable from code defects.
- **Short dispatches.** Brief the goal and the non-obvious constraints; let the
  agent implement, test and secure it; verify the diff afterwards.
