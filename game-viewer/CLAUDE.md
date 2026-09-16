# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`game-viewer/` holds two local, dependency-free Node + browser programs that share one asset catalog:

- `farm/` — **Little Meadow**, a playable farm game. This is the active work.
- The asset viewer at the top level (`viewer.*`, `serve-viewer.mjs`, `generate-assets.mjs`) — a
  catalog browser for the Farm RPG sprite pack. The game reuses its HTTP server and image API.

Everything is plain ES modules; the browser loads `farm/*.mjs` directly. No bundler, framework,
CDN, build step, or npm dependency. The surrounding `llm-workspace` Electron app is a separate
program — the game never imports from it, and no host code is edited from here.

## Commands

Run from `game-viewer/`. There is no `package.json` here; it borrows the workspace's `node_modules`.

```sh
./run.sh                            # generate the catalog if missing, serve the game, open a browser
./run.sh viewer                     # the asset browser instead
./run.sh --rebuild --port 4180      # force a catalog rebuild; pick a port
./run.sh --test                     # the suite

# What run.sh wraps, if you need a step on its own:
node farm/serve.mjs                 # play at http://127.0.0.1:4175   (--port N)
node serve-viewer.mjs               # asset browser at :4173          (--port N)
node generate-assets.mjs            # rebuild assets-manifest.json + irregularities report

../node_modules/.bin/vitest run --config vitest.config.mjs
../node_modules/.bin/vitest run --config vitest.config.mjs tests/farm-model.test.ts
../node_modules/.bin/vitest run --config vitest.config.mjs -t 'part of a test name'
```

`run.sh` is the whole build: generating `assets-manifest.json` is the only build step
this project has, and it is skipped when the manifest already exists. The script
refuses to start on Node below 24, when `assets/` is absent, or when the port is
taken, and says what to do in each case.

Node 24 (`.nvmrc` at the workspace root). `assets/` and `assets-manifest.json` are gitignored
local prerequisites: a fresh checkout must restore the sprite pack under `assets/` and run
`generate-assets.mjs` before either server starts or `tests/farm-server.test.ts` passes.
HTTP tests bind ephemeral loopback ports, so the environment must allow local binding.

## Architecture of the game (`farm/`)

Simulation and presentation are strictly separated. Bottom-up:

- **`definitions.mjs`** — frozen content/balance tables (`CROPS`, `GUARDS`, `MONSTERS`, `SHOP`,
  `ANIMALS`, raid tiers) plus `guardStats`/`landCost`/`upgradeCost`/`raidProfile`. Every price and
  timing lives here; nothing else hardcodes one.
- **`world.mjs`** — the 640x390 map: fixed plot/animal/patrol coordinates, body radii, reach,
  terrain collision, routing around the farmhouse and pond. Simulation and renderer both read
  positions from here rather than keeping their own.
- **`combat.mjs`** — patrols, spatial target selection, movement, contact/ranged strikes, armor,
  raids, defeat rewards, and cleanup of references to dead actors.
- **`model.mjs`** — the authoritative state machine: `createFarm`, `advanceFarm` (fixed 50 ms
  steps, 0–60 s per call, no wall-clock catch-up), `moveFarmer`, `command(state, action)`,
  `applySessionSnapshot`, `getInteractionTarget`. Pure JS; runs under Node with no DOM.
- **`validation.mjs`** — `validateFarm` / `upgradeFarm`. Validates v1 and v2 saves and migrates v1
  forward. Malformed v2 data fails; it is never repaired with defaults.
- **`storage.mjs`** — versioned save envelope (`serializeFarm`/`parseFarm`) over a synchronous
  localStorage-shaped adapter. Keys `hearthfield.farm.v1` and `.backup`.
- **`sessions.mjs`** — `normalizeSnapshot` validates complete session snapshots;
  `createSessionSimulator` is the demo-only source.
- **`art.mjs`** — `ART` maps sprite keys to verified pack paths, cell sizes, and frame counts;
  `loadArt` fetches them through the catalog API.
- **`combat-view.mjs` / `scene.mjs`** — Canvas drawing and transient effects only. They copy model
  coordinates and strike IDs; they never move an actor, deal damage, or award anything.
- **`app.mjs`** — `mountFarm(root, {sessionSource, saveStore, onAttention, assetLoader})`: DOM
  panels, keyboard/canvas input, the visible-page clock, save scheduling. Returns an idempotent
  synchronous disposer. Re-renders preserve the focused control (`data-focus`).
- **`serve.mjs`** — wraps `createViewer` from `../serve-viewer.mjs` with an explicit allowlist of
  farm files. **Adding a new `farm/*.mjs` module means adding it to `MODULES` in `serve.mjs`**, or
  the browser 404s on it (`tests/farm-server.test.ts` lists the files too).

### Contracts to keep in sync

`farm/CONTRACT.md` is the normative spec: state shape, every `command` action, the session
snapshot format, save/mount rules. `farm/README.md` covers player-facing behaviour and the host
integration API. Update both in the same change as the code — tests assert behaviour described
there. Playtest findings go in `farm/KNOWN_ISSUES.md`.

Invariants that recur through the code and tests:

- Standalone by design: no host imports, no provider/agent/transcript logic, no external network
  calls, no new dependencies.
- Everything from outside arrives through injected adapters (`sessionSource`, `saveStore`,
  `onAttention`, `assetLoader`). The game navigates to prompts; it never answers them.
- Saves are validated and versioned. A corrupt primary falls back to the backup and reports it;
  corrupt primary *and* backup stop loading rather than silently resetting.
- Session identities, questions, activity flags, and connection state are never persisted.
- Time only advances on visible real time: hidden/closed pages and scheduler gaps over 2 s earn
  nothing. The 1x/2x/4x selector scales simulation only, not movement input.
- The HTTP layer stays loopback-only, read-only (GET/HEAD), same-origin checked, strict CSP.

## Asset catalog (the game's data source)

`generate-assets.mjs` walks the PNG pack and its `.aseprite` sources with hand-written parsers
(`asset-readers.mjs`), classifies entries (`asset-classification.mjs`, family globs in
`asset-rules.json`), and writes `assets-manifest.json` plus `assets-irregularities.json`. Frame
sizes are never inferred just because dimensions divide evenly by 16 or 32; unverified assets are
marked `needsReview` instead of being given a layout. `serve-viewer.mjs` indexes the manifest and
serves `/api/options`, `/api/folders`, `/api/assets`, and `/images/<id>.png`; the game consumes the
same endpoints. The root `README.md` documents the manifest schema, rules, and overrides.

## Conventions

- Dense, compact style: short arrow helpers, validate-then-mutate, explicit `throw new Error(...)`
  on invalid input, frozen constant tables, comments only where the reason is not obvious. Match it
  rather than expanding it.
- Tests are TypeScript in `tests/` importing the `.mjs` modules directly. Node environment by
  default; DOM tests opt in with `// @vitest-environment jsdom` on line 1 (`tests/*ui.test.ts` also
  match by glob). Scene tests record calls through a stubbed Canvas 2D context; UI tests click real
  buttons by their visible label. Save fixtures live in `tests/fixtures/`.
- Work here is plan-driven and test-first. Specs and plans are in `docs/superpowers/specs/` and
  `docs/superpowers/plans/`.

## Current state

The suite is green: 161 passing across 13 files. The live base-stat editor
(`docs/superpowers/plans/2026-09-11-live-balance-editor.md`) is implemented — `farm/balance.mjs`
holds per-farm tuning for all 11 damageable types, `command` takes `balance` and `resetBalance`,
saves are version 3, and the editor is a non-modal panel opened from the world toolbar.

None of it has had a browser playtest yet. `farm/KNOWN_ISSUES.md` lists what each change asks
you to confirm by eye — pacing, button labels, and whether the new combat stakes read right.
