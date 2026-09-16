# Live base-stat editor

**Goal:** Inspect and edit every damageable type's base stats in-game, persist
settings locally, and make owned plots damageable even without a growing crop.
**Architecture:** Per-farm validated balance configuration; no mutable global
definitions. Config is embedded in the version3 farm save (existing localStorage
adapter/key), copied into new farms, and consumed by spawning, damage, movement,
healing, validation and presentation. Old v1/v2 saves migrate with defaults.
**Tools:** Existing native modules and Vitest/jsdom; no dependencies/host edits.

## Rules and contract

- `balance.mjs` exports `DEFAULT_BALANCE`, `BALANCE_FIELDS`, `BALANCE_GROUPS`,
  `createBalance()`, `validateBalance(config)`, `statsFor(state,group,kind)`.
- Full configuration `{version:1, farmer:{main:{...}}, plots:{land:{...}},
  animals:{cow:{...},sheep:{...}}, guards:{scout:{...},knight:{...},ranger:{...}},
  monsters:{slime:{...},raider:{...},spitter:{...},brute:{...}}}`.
- All entries have maxHealth and armor. Farmer/guards/monsters also have power,
  interval, reach, speed. Base defaults match the current game. Names, rewards,
  costs, radii, crop growth and harvest progression remain in definitions.
- Bounds: health1..10000 integer, armor0..1000 integer, power0..1000 integer,
  interval0.05..10, reach0..250, speed0..250. Unknown/missing keys or nonfinite
  numbers fail validation; invalid edits are atomic and leave gameplay untouched.
- Defense subtracts a flat amount from each hit, down to zero. It does not protect
  against thirst/starvation. Noncombatants have no attack controls.
- `command(state,{type:'balance',group,kind,field,value})` validates and applies
  one number. `command(state,{type:'resetBalance'})` restores all defaults.
  Existing actors preserve health percentage when maxHP changes; no resurrection,
  crop progress loss, currency reward, or full heal. Guard upgrades still multiply
  the configured base. Lower attack intervals also cap existing cooldowns.
- `guardStats(guard,balance?)` accepts the per-farm balance as optional second
  argument; every gameplay/UI call supplies `state.balance`. Static exports stay
  intact for existing catalog/integration code.
- `createFarm(balance?)` validates/copies optional settings and creates healthy
  new entities using them. New-farm reset retains current balance. Serialization
  includes config, saves remain private/session-free, and multiple mounts do not
  share mutable settings.
- Plots use one health pool for the cultivated bed and its crop. All unlocked,
  non-dead plots can be targeted. Zero HP marks the plot dead/ruined without losing
  ownership; normal clearing/tending repairs it. Locked land is not damageable.

## Tasks and ownership

- [ ] Root: tests first for config bounds/isolation/live changes, health ratios,
  all defense paths, empty-plot damage/repair, and old/new persistence. Implement
  balance definitions/model/combat/validation/storage/world and server routes.
- [ ] UI worker: own app/scene/style plus UI/scene tests. Add Balance management
  tab containing rows for all11 types; show editable current values and shipped
  defaults, units, and explanation of defense/health-percentage preservation.
  Use input change events for immediate valid updates without replacing focused
  controls; blank/invalid values show errors without applying. Reset defaults is
  reversible. Show actual current/maxHP in panels, normalized bars in Canvas,
  and defense where helpful. Read statsFor for farmer/plots/animals and
  guardStats(guard,state.balance) for upgraded protectors. Existing monsters and
  guards keep explicit maxHealth. New-farm action calls createFarm(state.balance).
  Clear damaged-plot wording: Tend repairs/clears ruined land; growth health and
  bed integrity share one pool. Never reset the farm to apply tuning.
- [ ] Root: integration, current full tests, long custom-balance simulation,
  independent review, migration/docs and final verification. No automatic commit.

## Review constraints

Prior combat/progression changes are uncommitted user work; preserve them.
Only edit game-viewer. Keep existing pause, focus, session, save and reset
protections. Guard/monster view effects use model coordinates and strike IDs.
Do not spawn subagents from a worker. Browser QA depends on tool availability.
