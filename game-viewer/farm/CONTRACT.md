# Standalone farm contracts

Native browser/Node ES modules using the existing catalog and Vitest. No host
imports, provider calls, agent prompts, external services, or dependencies.

## Simulation

`model.mjs` exports:

- `createFarm(balance?)` returns a new version3 farm with 3 unlocked plots and 35
  coins. An optional validated balance is copied in, never shared between farms.
- `advanceFarm(state, seconds)` accepts finite 0..60 seconds and advances fixed
  50 ms steps. A disconnected farm does not advance. No wall-clock catch-up.
- `moveFarmer(state, dx, dy, seconds)` accepts finite direction components -1..1
  and 0..2 real seconds. It normalizes diagonals, respects terrain/enemy bodies,
  returns whether the position changed, and freezes below a tenth of configured
  maximum health, or when disconnected. Movement speed comes from the balance.
- `command(state, action)` validates actions; definitions set costs/yields.
- `getInteractionTarget(state)` returns `{type:'attack'|'harvest'|'collect',id,x,y,name}`
  or null. It shares geometry with interaction commands and live UI hints.
- `nearPlot(state, plotId)` / `nearAnimal(state, animalId)` report whether the farmer
  is within the same reach `getInteractionTarget` uses (30, distinct from the tunable
  sword reach in balance.mjs). `command` uses them to gate the player-only Tend,
  Harvest, Collect, Slaughter and animal Heal cases; helpers, automation and healing
  the farmer or a protector are unaffected.
- `applySessionSnapshot(state, snapshot)` reconciles complete session snapshots;
  returns false for duplicate/older revisions, true when applied.
- `validateFarm(state)` validates v1, v2 or v3 without mutation. A v3 save is
  checked against its own balance limits, earlier versions against shipped ones.
- `upgradeFarm(state)` validates and clones/migrates v1 or v2 forward, or returns a
  validated v3 object. The browser mount calls it for injected save adapters too.
  Migration installs shipped default balance; a stale field on a legacy save is
  discarded, never trusted.

Version3 retains every version2 field and adds a validated `balance`:

```js
{
 version: 3, balance: { version: 1, farmer: {...}, plots: {...}, animals: {...},
                        guards: {...}, monsters: {...} }, //see Balance below
 time: 0, remainder: 0, harvests: 0, coins: 35,
 mainHealth: 100, mainCooldown: 0,
 farmer: { x: 166, y: 105, facing: 'down', action: 'idle', actionTime: 0 },
 nextId: 100, raidTimer: 150, wave: 0,
 connected: true, sessionRevision: -1,
 plots: [{ id: 'p1', crop: 'parsnip', unlocked: true, stage: 'empty',
           growth: 0, water: 0, health: 100, neglect: 0, weeds: 0 }], //12
 animals: [{ id: 'cow-1', name: 'Clover', kind: 'cow', health: 100,
             hunger: 80, production: 0, produce: 0 }],
 guards: [{ id: 'guard-1', kind: 'scout', level: 1, health: 60, maxHealth: 60,
            mode: 'patrol', post: 'farm', progress: 0, patrolIndex: 1,
            x: 190, y: 135, facing: 'down', cooldown: 0, targetId: null,
            strikeId: 0, strikeX: 190, strikeY: 135, strikeTargetId: null }],
 monsters: [{ id: 'monster-100', kind: 'slime', spawn: 'west', health: 22,
              maxHealth: 22, x: 0, y: 182, facing: 'down', cooldown: 0,
              targetId: null, strikeId: 0, strikeX: 0, strikeY: 182,
              strikeTargetId: null }],
 workers: [{ id: 'session-1', name: 'Rowan', provider: 'demo', activity: 'working',
             attention: null, assignment: 'auto', action: 'Looking for work', job: null,
             x: 61, y: 154, facing: 'down', moving: false }], //position is transient, never saved
 inventory: { parsnip: 0, wheat: 0, milk: 0, wool: 0, meat: 0, hide: 0,
              seeds: 6, feed: 8, medicine: 1 },
 policy: { autoHarvest: false, autoSell: false, autoCollect: true, autoHeal: true },
 events: [{ id: 1, time: 0, text: 'Welcome home.' }]
}
```

Plot stages: empty/tilled/growing/ready/dead. Locked plots stay empty and cannot
be assigned, tended, planted or harvested. Health maxima shown above are the shipped
defaults; a tuned farm reads them from its own balance. Every successful plot harvest adds
one to `harvests`, including automatic harvest. Stat and timer fields are bounded.
Guard modes: home/patrol/expedition; posts: farm/garden/pasture; levels 1..3. Only a
patrolling guard is ever attacked; home and expedition guards are never targeted.
Protectors fight to the death: a patrolling guard reduced to zero health in combat
dies and is removed from the roster permanently, upgrades included, with a journal
entry, the same way an animal dies. Only combat kills a guard; expedition return
always costs 18 health, floored at 1, so it cannot. A home guard heals until full,
then automatically resumes patrol; ordering a wounded guard onto patrol or an
expedition is otherwise always allowed, at the player's own risk.
Monster kinds: slime/raider/spitter/brute. Actor origins refer to 32px sprites.
Active target IDs must reference live eligible targets. Historical strike target
IDs may refer to defeated enemies. Every actual strike allocates a new strikeId.

Commands (existing commands retain their names):

```js
{ type: 'interact' } //nearby enemy, else crop/product; empty sword swing is harmless
{ type: 'harvest', plotId: 'p1' } //rejected unless the farmer is near the plot
{ type: 'harvestAll' } //works from anywhere
{ type: 'crop', plotId: 'p1', crop: 'wheat' } //works from anywhere
{ type: 'tend', plotId: 'p1' } //rejected unless the farmer is near the plot
{ type: 'unlockPlot', plotId: 'p4' }
{ type: 'assign', workerId: 'session-1', targetId: 'auto' } //auto/livestock/unlocked plot
{ type: 'policy', key: 'autoHarvest', value: true }
{ type: 'buy', item: 'seeds' } //seeds/feed/medicine/cow/sheep; works from anywhere
{ type: 'sell', item: 'parsnip', quantity: 2 } //omit quantity to sell all owned; works from anywhere
{ type: 'collect', animalId: 'cow-1' } //milk/wool once ready; rejected unless the farmer is near the animal
{ type: 'slaughter', animalId: 'cow-1' } //UI confirms irreversible animal removal; rejected unless near the animal
{ type: 'hire', kind: 'scout' }
{ type: 'guardMode', guardId: 'guard-1', mode: 'home' }
{ type: 'guardPost', guardId: 'guard-1', post: 'pasture' }
{ type: 'upgradeGuard', guardId: 'guard-1' }
{ type: 'heal', targetId: 'main' } //farmer/guard/animal; consumes medicine. Healing an
                                   //animal is rejected unless the farmer is near it;
                                   //healing the farmer or a protector works from anywhere
{ type: 'balance', group: 'monsters', kind: 'brute', field: 'power', value: 20 }
{ type: 'resetBalance' } //restores shipped defaults, keeping health percentages
{ type: 'raid' } //demo encounter using current harvest tier
{ type: 'recover' } //starter seeds only when out of seeds and unable to buy them
```

`definitions.mjs` owns CROPS, GOODS, GUARDS, MONSTERS, POSTS, SHOP, ANIMALS,
EXPEDITION_TIME, `raidProfile(harvests)`, `guardStats(guard, balance?)`,
`landCost(state)` and `upgradeCost(guard)` (null at maximum level). Read definitions
for prices/timing. `guardStats` without a balance returns shipped stats, so existing
catalog and integration callers keep working; every gameplay and UI call passes
`state.balance`, and level upgrades still multiply the configured base.

## Balance

`balance.mjs` owns per-farm tuning for every damageable type. It exports
`DEFAULT_BALANCE`, `BALANCE_FIELDS`, `BALANCE_GROUPS`, `fieldsFor(group, kind)`,
`createBalance(input?)`, `validateBalance(config)`, `validateBalanceValue(...)`,
`statsFor(state, group, kind)` and `retuneFarm(state, next)`. Names, costs, rewards,
radii, vision, crop growth and harvest progression stay in definitions; only the
stats a player retunes live here, so a tuned farm never rewrites shared definitions.

```js
{ version: 1,
  farmer:   { main: { maxHealth: 100, armor: 0, power: 12, interval: .65, reach: 30, speed: 80 } },
  plots:    { land: { maxHealth: 100, armor: 0 } },
  animals:  { cow: {...}, sheep: {...} },              //maxHealth and armor only
  guards:   { scout: {...}, knight: {...}, ranger: {...} },
  monsters: { slime: {...}, raider: {...}, spitter: {...}, brute: {...} } }
```

Bounds: maxHealth 1..10000 integer, armor 0..1000 integer, power 0..1000 integer,
interval 0.05..10, reach 0..250, speed 0..250. Unknown groups/kinds/fields, missing
or extra keys, and nonfinite numbers fail. Plots and livestock have no attack fields.
Validation runs before any state is touched, so a rejected edit changes nothing.

Defense subtracts a flat amount from each incoming hit, down to zero damage. It does
not protect against thirst or starvation. Applying a configuration carries every
living entity across by health percentage and caps existing attack cooldowns to the
new interval: nothing is revived, healed, resurrected or rewarded, and a ruined plot
stays ruined. Guards and monsters keep an explicit `maxHealth`; the farmer, land and
livestock read theirs from the configuration.

All unlocked, non-dead plots are damageable with or without a crop. One health pool
covers the bed and anything growing in it. Zero health marks the plot dead and
ruined without losing ownership; clearing or tending repairs it. Locked land is
never a target.

## Combat and presentation

`combat.mjs` owns patrols, spatial target selection, movement, contact/ranged
strikes, armor, raids, defeat rewards and active-reference cleanup. Combat uses
immediate hits and cooldowns, not a hidden progress fraction along a lane.
`world.mjs` supplies map/plot/animal positions, shared body radii/reach, terrain
collision and bounded routing around the farmhouse/pond. Fighters stop at reach;
they cannot attack through those obstacles. Renderers do not move combatants.

`createCombatView().update(state, elapsed, {paused,reducedMotion})` returns guards,
monsters and defeats. Guards/monsters copy their model coordinates and add hit,
attacking, strikeAge/strikeDuration and targetX/targetY presentation data. Defeats
include kind, x/y, age/duration and the actual definition reward. Strike pulses
last 0.35s, defeat effects 1.4s in visible real time and freeze on pause. This helper
never awards currency or deals damage and is recreated when a new farm replaces
state. `scene.mjs` chooses per-kind verified animation strips and fallback shapes.

## Sessions

```js
{ version: 1, revision: 1, connected: true, sessions: [
 { id: 'session-1', name: 'Rowan', provider: 'demo', activity: 'working',
   parentId: null, attention: null }
] }
```

Activity: working/idle/waiting_input/waiting_permission/error/unknown. Attention:
null or `{id,kind,text}`. A root and its descendants share one worker. Parent
attention takes precedence; closed sessions are absent from the next complete
snapshot. Bounds: 512 sessions, 64 roots, bounded IDs/labels/questions. Workers hold
one exclusive `{targetId,kind,progress,duration}` job; only working sessions labor.
Each worker also carries a physical `{x,y,facing,moving}` in the model, routed with
the same `moveActor`/`canStand` helpers as guards and monsters, so it paths around
the farmhouse and pond. A job's progress only advances once its helper is within a
few pixels of the job's target — the specific animal it feeds or collects from, not
a generic spot by the pen — so a destroyed plot stays ruined until a helper actually
walks over to clear and replant it. This position is transient like the rest of a
worker: never saved, and rebuilt (at a home spot, or carried over by id) from each
new session snapshot. Renderers copy it like any other actor's; they do not move it.

`createSessionSimulator()` provides snapshot/subscribe/add/setActivity/remove/
addChildren/dispose. Subscription immediately emits and returns unsubscribe.
Simulator questions never claim to represent a real host prompt.

## Saving and mount

`createSaveStore(storage)` accepts synchronous localStorage-shaped getItem/setItem
and returns `{load(),save(state)}`. Load returns `{state,warning}`. Existing keys
`hearthfield.farm.v1` and `.backup` remain so upgrades discover old farms.
`serializeFarm` writes `{version:3,farm}`; `parseFarm` accepts matching 1/1, 2/2 or
3/3 versions. V1 validation uses frozen old balance constants before migration. V1
migration retains all 12 plots, earned assets and fractional crop/animal/expedition
progress, starts unknown harvest history at 0 and discards sub-step clock remainder.
V1 and v2 saves gain shipped default tuning without changing any earned resource,
health value or progression. No defaults repair malformed v2 or v3 data, and a
stored balance outside its bounds fails the load instead of being silently fixed. Corrupt primary recovery is explicit; corrupt
primary+backup stop loading without destroying stored data.

Session identities, workers, questions and live connection are removed on save.
The farmer's current action pose is cleared; no elapsed closed-page time is saved.
The mount waits for a fresh valid session snapshot before advancing.

`mountFarm(root,{sessionSource,saveStore,onAttention,assetLoader})` returns an
idempotent synchronous disposer. The caller owns adapters. onAttention navigates
only; the game never answers prompts. Optional assetLoader accepts `{signal,onError}`
and resolves an image map keyed by ART. Default loader uses the local asset API.

The canvas owns arrow/Space input only while focused. Blur, visibility changes,
pause and disconnection clear keys. Movement uses unscaled seconds; speed 1/2/4
scales simulation only. UI updates interaction hints every 50ms and management
panels every second. Hidden/closed pages and scheduler gaps over 2s earn no time.
Web Locks prevents concurrent standalone tabs from writing the same save.

Commands save immediately; movement saves on release and the periodic 5s interval.
Save failures remain visible. New farm requires explicit confirmation and exports
the previous state before saving the replacement. An export/save error leaves the
live old farm intact; existing sessions remain attached after successful reset.
