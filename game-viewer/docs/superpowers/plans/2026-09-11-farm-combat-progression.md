# Farm combat and progression implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Preserve
> other workers' edits. Root owns simulation; UI worker owns rendering/interface.

**Goal:** Turn the farm into a paced, defendable economy with responsive combat.
**Architecture:** Position-based simulation in a separate combat module, shared
world geometry, presentation-only combat effects and versioned save migration.
**Tech Stack:** Existing native ES modules, Canvas2D, DOM, Node24, Vitest/jsdom.
**Spec:** `docs/superpowers/specs/2026-09-11-farm-combat-progression-design.md`

## Constraints and ownership

No dependencies or host app edits. Preserve old saves. No automatic reset.
Root: definitions/world/model/combat/validation/storage/combat-view/serve,
core tests, docs. UI worker: app/scene/art/style, UI/scene tests. Review read-only.
Stay in the existing scoped game-viewer folder so the user's running server sees
changes; parent app has concurrent work. No branch switching or automatic commits.

## Tasks

- [x] Core rules and version2 schema: add failing balance/migration tests; new
  farm only 3 unlocked plots; successful harvest increments counter; unlockPlot
  charges server-defined cost; upgradeGuard checks level/cost; migrate v1 intact.
- [x] Spatial combat: failing contact/target/spawn/progression tests; implement
 50ms movement, collision/reach, cooldown attacks, patrol posts, terrain targets,
 same-tick cleanup, reduced rewards and ranged/armored variants.
- [x] Interface: visually inspect available enemy assets; locked plot art and
 expansion button; threat meter/milestones; patrol and upgrade controls; actual
 model positions, strike/hit/death animations, player reach hint; nearby livestock Space collection, explicit milk/shear controls
  and countdowns/auto-collection explanation; confirmed new
 farm/export flow. Maintain keyboard, disposal and adapter tests.
- [x] Integration: adapt presentation helper to strike IDs and model positions;
 update explicit server modules; update balance-dependent tests/docs; run full
 suite and deterministic extended simulation; scoped independent review and fixes.

## UI contract

Root exports `upgradeFarm(state)` from validation/model, returning v2 clone of
validated v1 state, or the existing validated v2 state. Mount normalizes loaded
state before subscribing. State adds `harvests`, `plots[].unlocked` and spatial
combat fields. `monsterPosition(m)` returns model x/y; `animalPosition(index)`
returns 32px sprite origin. All actors use 32px logical coordinates.

Definitions export `MONSTERS`, `POSTS`, `raidProfile(harvests)`, `landCost(state)`,
`upgradeCost(guard)`, `guardStats(guard)`. Monster kinds: slime, raider, spitter,
brute. UI chooses corresponding existing sprites and tells root mappings.

Commands: `unlockPlot {plotId}` any locked plot; `guardPost {guardId,post}`;
`upgradeGuard {guardId}`. Existing commands remain. `getInteractionTarget(state)`
returns `{type:'attack'|'harvest'|'collect', id, x,y,name}` or null for hints. Guard fields
include x/y/facing/post/level/cooldown/targetId/patrolIndex/strikeId/strikeX/
strikeY/strikeTargetId. Monster has kind/x/y/facing/spawn/cooldown/targetId and
same strike fields. Helper returns guards/monsters with attacking/targetX/Y/hit;
defeats include kind/reward/x/y/age/duration. Helper never moves combatants.

## Progress and rulings

- Interfaces reviewed: UI consumes root-owned definitions and state; no shared
  file edits. Storage owns migration; UI calls it for custom adapters as well.
- Existing saves retain all 12 plots; new balance requires explicitly starting a
  new farm to experience initial land scarcity. No silent rollback of earned assets.
- Standalone only; user asks for implementation. Proceed with the stated tuning
  and use playtest feedback for later balancing, without another permission gate.

## Verification result

- All 136 existing and new tests pass across 12 files.
- Forty simulated minutes validated state each second and round-tripped saves
  every five minutes; limited basic defenders eventually lost livestock, as
  expected without upgrades or renewed patrol orders.
- Independent review reproduced and verified fixes for obstacle routing and
  player/enemy overlap. No open material findings.
- Farm module syntax and diff whitespace checks pass. Local server restarted
  with the new combat route. Browser visual playthrough remains unverified.
