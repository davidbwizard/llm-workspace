# Standalone farm contracts

This is the approved standalone implementation. No real app imports, connections,
session commands, prompts, or provider access. Plain browser/Node ES modules,
existing asset catalog and Vitest, no dependencies. Run `node farm/serve.mjs`.

## Simulation (`model.mjs`, owned by root)

Exports `createFarm()`, `advanceFarm(state, seconds)`, `command(state, action)`,
`applySessionSnapshot(state, snapshot)`, `validateFarm(state)`.
`moveFarmer(state, dx, dy, seconds)` accepts finite direction components in -1..1
and 0..2 real seconds, normalizes diagonals, applies terrain collision, and returns
whether position changed. Pass unscaled time; it freezes while disconnected or
below 10 health. The mount gates movement on focus/visibility/pause.
Functions mutate the passed state. Commands throw descriptive errors on invalid
input and do not partially apply invalid actions. Advance accepts 0..60 seconds,
uses fixed quarter-second steps, and freezes if `state.connected === false`.
Snapshot application returns false for older/duplicate revisions, true if applied.

State fields:

```js
{
 version: 1, time: 0, remainder: 0, coins: 120, mainHealth: 100,
 nextId: 100, raidTimer: 180, wave: 0, mainCooldown: 0,
 farmer: { x: 166, y: 105, facing: 'down', action: 'idle', actionTime: 0 },
 connected: true, sessionRevision: -1,
 plots: [{ id: 'p1', crop: 'parsnip', stage: 'empty', growth: 0,
           water: 0, health: 100, neglect: 0, weeds: 0 }], // 12, p1..p12
 animals: [{ id: 'cow-1', name: 'Clover', kind: 'cow', health: 100,
             hunger: 80, production: 0, produce: 0 }], // initial cow and sheep
 guards: [{ id: 'guard-1', kind: 'scout', health: 60, maxHealth: 60,
            mode: 'patrol', progress: 0 }],
 monsters: [{ id: '...', health: 30, maxHealth: 30, progress: 0 }],
 workers: [{ id: '...', name: '...', provider: 'demo', activity: 'working',
             attention: null, assignment: 'auto', action: 'Looking for work',
             job: null }],
 inventory: { parsnip: 0, wheat: 0, milk: 0, wool: 0, meat: 0, hide: 0,
              seeds: 20, feed: 20, medicine: 3 },
 policy: { autoHarvest: false, autoSell: false, autoCollect: true, autoHeal: true },
 events: [{ id: 1, time: 0, text: 'Welcome to the farm.' }]
}
```

Stages: empty, tilled, growing, ready, dead. Growth is seconds (parsnip 75, wheat
120). Stats water/health/hunger/weeds are 0..100. Production is seconds; milk/wool
become ready every 90 seconds with good care. Produce is integer ready units.
Jobs: `{ targetId, kind, progress, duration }`, durations in seconds. Kinds till,
plant, water, weed, clear, harvest, feed, collect. Workers can target any job;
only working farmers contribute. Events bounded to 40 newest, newest first.

Commands:

```js
{ type: 'interact' } // nearby enemy (12 damage), else nearest ripe plot; range44, cooldown
{ type: 'harvest', plotId: 'p1' } // ready only
{ type: 'harvestAll' }
{ type: 'crop', plotId: 'p1', crop: 'wheat' } // empty/dead/tilled only
{ type: 'tend', plotId: 'p1' } // main farmer performs next care action; cooldown
{ type: 'assign', workerId: 'session-1', targetId: 'auto' } // auto/livestock/p1..p12
{ type: 'policy', key: 'autoHarvest', value: true }
{ type: 'buy', item: 'seeds' } // seeds: 10 for 8 coins; feed: 10 for 10; medicine: 1 for 15; cow: 80; sheep: 65
{ type: 'sell', item: 'parsnip' } // sell all owned; optional positive integer quantity
{ type: 'collect', animalId: 'cow-1' }
{ type: 'slaughter', animalId: 'cow-1' } // UI confirms; removes animal, adds meat and hides
{ type: 'hire', kind: 'scout' } // scout: 45, knight: 100, ranger: 80
{ type: 'guardMode', guardId: 'guard-1', mode: 'home' } // home/patrol/expedition
{ type: 'heal', targetId: 'main' } // main/animal/guard id, consumes one medicine
{ type: 'raid' } // simulate encounter; label in demo controls
{ type: 'recover' } // free seed starter only when unable to afford seeds and out of seeds
```

`definitions.mjs` exports `CROPS` (key -> {name,growTime,price,yield}), `GOODS`
(key -> {name,price}), `GUARDS` (key -> {name,cost,maxHealth,power,weapon,weaponLabel}), `SHOP`
(key -> {name,cost,quantity}), `ANIMALS` (key -> {name,cost,product,meat,hide}).

Snapshot:
```js
{ version: 1, revision: 1, connected: true, sessions: [
 { id: 'session-1', name: 'Rowan', provider: 'demo', activity: 'working',
   parentId: null, attention: null }
] }
```
Activity: working/idle/waiting_input/waiting_permission/error/unknown.
Attention: null or `{id,kind,text}`. Children with a valid parent are folded into
one root farmer; parent attention takes precedence over child working state.
Closed sessions are absent from the next complete snapshot. IDs/labels bounded.

## Browser boundary (`storage.mjs`, owned by root)

`createSaveStore(storage)` takes the localStorage-shaped getItem/setItem API and
returns `{load(), save(state)}`. load returns `{state, warning}` (state null if new).
Validates, keeps a previous valid snapshot, recovers backup explicitly; corrupt
saves with no valid backup throw. Never store workers, questions, session identity,
connection state, or wall-clock elapsed time as future labor.
The additive v1 `farmer` field persists x/y/facing; loading older saves supplies
the home position. Action poses are cleared on load/save. Position, bounds,
terrain, facing, and action fields are validated before use.

`world.mjs` shares map/plot/monster positions between simulation and rendering.
`combat-view.mjs` contains disposable hit/death/weapon presentation state only;
it never grants rewards, changes health, or enters the save. Damage and guard
targets come from the simulation. The renderer retains a removed slime for a
1.4-second death animation and reward caption; pause freezes this transition.

`createSessionSimulator()` from `sessions.mjs` returns `{ snapshot(), subscribe(cb),
add(), setActivity(id, activity, text?), remove(id), addChildren(id, count), dispose() }`.
Starts with three working demo sessions. `subscribe` immediately emits a snapshot;
returns an unsubscribe function. No automatic random state transitions. Simulator
questions are explicitly demo content; resolving them changes only the simulator.

## UI (`index.html`, `style.css`, `app.mjs`, `scene.mjs`, `art.mjs`, owned by UI worker)

Standalone root URL is `/`; JS imports under `/farm/`. Fetch catalog via existing
`/api/assets`, `/api/assets/:id`, and images `/images/:id.png`. Catalog contains
5747 assets; select a small set lazily. Use real premade farmer sprites and crop
art; visually verify actual sheet regions. Map selection into art.mjs. Stage
timings are game definitions, not inferred sprite metadata. No new fonts/assets
downloaded; use local/system typography. Pixel world Canvas 2D, accessible HTML
controls alongside it. Expose equivalent plot selection buttons for keyboard.
The canvas is focusable: arrows move the player and Space harvests or attacks
within reach. Blur, hidden pages, and disconnection clear held directions. No
global keyboard interception; normal form controls retain their key behavior.

The world is the main focus: grass, paths, crop plots, farmhouse, animal pen,
patrolling protectors, approaching slimes, walking/tending farmers, speech bubbles.
Use distinct areas/positions so jobs' targetId has a visible location. Supporting
panels show selected plot, inventory/trading, livestock, guards, and workers.
Settings include optional auto-harvest/sell, auto-collect/heal, pause and 1x/2x/4x.
Session simulator is a secondary collapsible panel. Player can add workers, make
them idle/working/ask a question, finish a session, simulate many child agents, and
trigger an encounter. Question navigation opens a real DOM detail panel with exact
demo text. Never fake a real host link.

Use local save after commands and every five seconds; show save status/errors.
No silent reset on corruption. Export a JSON download is useful. Guard concurrent
tabs with Web Locks (second tab explains farm already open). On hidden page pause
this standalone demo and reset the elapsed-time origin; discard long gaps/sleep.
This standalone pause rule is deliberate; a future host supplies its own clock.
On reload restore farm before subscribing current simulator sessions. Saving and
simulation happen independently from scene animation. Clean up timers/listeners
when disposed. No requestAnimationFrame-based crop progress.

Implement a reusable `mountFarm(root, {sessionSource, saveStore, onAttention, assetLoader})`
entry returning dispose, so future host can replace demo sources without changing
simulation. It must not auto-connect to the real app. app.mjs may bootstrap only
when the known standalone root `[data-farm-app]` exists. Details of UI internals
belong to the UI owner; notify root of extra module paths for server allowlist.
Optional assetLoader accepts `{signal, onError}` and returns a promise of the image
map keyed by ART names. Omit it to load the current local catalog assets.
