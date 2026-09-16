# Farm combat and progression

User-requested iteration: varied enemies and entry points, farm patrols, attacks
on crops/livestock, responsive contact combat, harvest-driven difficulty, and a
slower economy. This remains standalone with replaceable session/save adapters.

## Rules

- New farms start with three unlocked plots, 35 coins, six seeds, eight feed,
  one medicine, a cow, sheep and scout. Twelve plots remain on the map. Additional
  plots cost 50 coins plus 25 for each plot already bought beyond the initial three.
- Parsnips: 180 seconds, yield2, price4. Wheat: 240 seconds, yield3, price5.
  Milk/wool sell for6/8 and produce every180 seconds. Seeds6 cost12; feed6 cost12;
  tonic18. Protectors cost60/125/105 (scout/knight/ranger). Expeditions take180
  seconds for modest rewards, rather than producing rapid risk-free income.
- Each successful plot harvest increments a persistent harvest counter once.
  Tiers at0/6/18/36 harvests introduce weak slimes, fast livestock raiders,
  ranged spitters, then armored brutes. Raids contain1/2/3/4 enemies at
  intervals180/160/140/120 seconds, with an initial150-second grace period.
  No unbounded difficulty from idle time; repeated raids rotate entry sides.
- Enemies enter from north/east/south/west. Each moves to an actual crop, animal,
  farmer or protector, stops at its weapon reach and attacks that target only.
  Weak slime22hp/3damage, raider28hp/5damage, spitter40hp/5damage at range,
  brute90hp/12damage with2 armor. Defeat rewards2/3/4/6coins.
- Scout is quick melee, knight is tougher melee with armor, ranger uses a bow.
  Patrol posts Farm/Garden/Pasture spread protection. Guards can be upgraded twice
  for added health/power. Automatic retreat and existing healing remain.
- Simulation owns actor x/y, facing, targets, cooldowns and strike IDs. Fixed50ms
  steps make attacks immediate on reaching range. Rendering uses those same
  coordinates; it does not independently walk fighters into different positions.
  Body radii and reach determine both player hints and actual hit tests. Space
  attacks nearby enemies before harvesting crops or collecting ready milk/wool;
  swinging at empty space is harmless. Show animal product countdowns and explain
  automatic collection; slaughter remains a separate confirmed action.
- Enemy damage can destroy crops and kill livestock; references/jobs are cleaned
  in the same tick. Dead enemies disappear with a short matching defeat effect.
- Version2 saves validate all new fields. Version1 migration keeps coins,
  inventory, crops, animals and all previously accessible plots. New-game balance
  is available through an explicit confirmation with an export of the old farm.
- Existing pause-on-hidden/closed, focus-only controls, session folding, adapter
  isolation and no offline progress remain. No new packages or host app edits.

## Verification

Test contact strikes, no overlap/distant damage, all four spawn sides, distinct
enemy stats/target preferences, crop/livestock losses, protector posts/upgrades,
harvest milestones and paid land, new/old save round-trips and invalid inputs.
Update existing balance-specific tests to the new rules. Exercise actual model
positions through Canvas tests; DOM tests cover expansion/patrol/reset/hints.
Run the existing full Vitest suite and deterministic long simulation. Actual
browser inspection remains dependent on availability of the connected browser.
