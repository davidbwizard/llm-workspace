# Standalone Farm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a playable local farm with simulated agent labor, complete farming,
livestock, basic trading/defense/healing, saving, and replaceable host connections.

**Architecture:** Portable browser/Node ES-module simulation and commands; Canvas
world and HTML controls; injected session and save adapters. Reuse the existing
read-only asset server and catalog. The real app is not connected or edited.

**Tech Stack:** Existing Node, vanilla JavaScript modules, Canvas 2D, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-farm-companion-design.md`, amended by
the user's standalone-first instruction and the concrete `farm/CONTRACT.md`.

## Global constraints

- No new dependencies, app edits, real agent calls, or changes to original art.
- Closing the standalone game pauses the entire world; no time-away simulation.
- One visible worker per root session, with manual management and automatic care.
- Use the existing test infrastructure; local config avoids parent write scope.
- Work inside game-viewer, already isolated from the host's tracked files by its
  existing ignore rule. Preserve that rule and concurrent host work; no commits
  can include ignored game files without separately arranging version tracking.

## Task 1: Portable simulation

Files: `farm/definitions.mjs`, `farm/model.mjs`, `farm/sessions.mjs`,
`tests/farm-model.test.ts`, `tests/farm-sessions.test.ts`.
Consumes and produces the exact state/actions/snapshot contract in `farm/CONTRACT.md`.

- [x] Write behavior tests for crop lifecycle/handoff, neglect, assignments,
  snapshot deduplication/children, bad commands, livestock outputs, trading,
  protector combat/recovery, and fixed-step determinism. Representative check:
  `expect(state.workers).toHaveLength(1)` after one root and 30 child sessions;
  `expect(state.inventory.meat).toBe(5)` after slaughtering a cow once, followed
  by a rejected second slaughter with unchanged inventory.
- [x] Run `../node_modules/.bin/vitest run --config vitest.config.mjs tests/farm-model.test.ts tests/farm-sessions.test.ts` and observe missing behavior.
- [x] Implement fixed quarter-second advancement, validated complete snapshots,
  exclusive care jobs, commands, production, combat, and finite recovery paths.
  Public invocation: `applySessionSnapshot(farm, source.snapshot()); advanceFarm(farm, 1); command(farm, {type:'harvestAll'});`.
- [x] Run the focused tests until passing; document boundary assumptions.

## Task 2: Playable world and management UI

Files: `farm/index.html`, `farm/style.css`, `farm/app.mjs`, `farm/scene.mjs`,
`farm/art.mjs`, `tests/farm-ui.test.ts`.
Consumes the Task 1 contract and save adapter (Task 3); produces mountFarm/dispose.

- [x] Create behavior tests for mount/dispose, visible question text, manual
  commands, save failures, and disconnected/duplicate mounts where practical.
  Use real model and DOM, not assertions on mocked framework behavior.
- [x] Build a world-first pixel farm with selected plots and HTML management
  controls; use the UI specification and signatures in `farm/CONTRACT.md`.
- [x] Load a small visually verified set of catalog sprites, animate workers
  according to real current jobs, and show actual condition/growth/health.
- [x] Implement explicit demo-session controls and replaceable session/save
  adapters. Keep question resolution local to the simulator.
- [ ] Verify interactions, keyboard focus, narrow screen layout, image loading,
  reload persistence, pause, and screenshot quality in the actual browser.

## Task 3: Persistence, serving, integration guide

Files: `farm/storage.mjs`, `farm/serve.mjs`, `farm/README.md`,
`tests/farm-storage.test.ts`, `tests/farm-server.test.ts`; small allowlist option
in `serve-viewer.mjs`. Existing viewer behavior and security remain intact.

- [x] Test save round trip, no restored labor, corrupt-primary backup recovery,
  unrecoverable corruption, oversized input, and storage write failures.
  `store.save(farm); expect(store.load().state.workers).toEqual([])` must hold.
- [x] Implement versioned validated local snapshots and an injectable storage
  adapter; never use wall-clock timestamps to advance restored state.
- [x] Expose the farm through `node farm/serve.mjs --port 4175` using explicit
  static-file allowlisting and existing catalog/image endpoints. Test HTTP status,
  module content type, cross-origin rejection, traversal, and preserved viewer UI.
- [x] Write running instructions, play guide, and code showing mountFarm with
  a future host source. Include actual standalone limitations and save location.
- [x] Run all local Vitest tests, JS syntax checks, and browser play verification.
- [x] Request an independent review, resolve correctness/security findings,
  and report the running URL, checks performed, and any limits.

## Progress

- Design approved; standalone amendment accepted. No real app integration.
- Baseline initially blocked by Vite writing a temporary file beside the parent
  config. Added a local config using the same installed Vitest; no new test system.
- UI work is delegated independently against the fixed contract while the root
  implements model/storage/server. Only one implementation subagent runs at a time.
- Portable model, session simulator, persistence, HTTP serving, and UI are built.
  Core review found and resolved two save-validity edge cases with red/green
  regression tests. One-hour simulation exercised 31 encounters and repeated saves.
- UI includes all management commands and an injectable artwork loader. Connected
  browser unavailable (discovery returned no browsers); final visual playtest is
  recorded as outstanding. DOM, HTTP, sprite-region, and model checks are runnable.

- Final verification: 79 tests passed across eight files; all farm modules and
  the asset server pass Node syntax checks. Running standalone URL returned HTTP
  200. Core review and scoped UI re-review have no open findings. The checked
  tasks record completed automated work; the browser visual check above remains
  incomplete because no connected browser was available.
