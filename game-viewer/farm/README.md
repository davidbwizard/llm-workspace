# Little Meadow

A standalone, local farm game built from the existing Farm RPG asset catalog.
Demo sessions supply farm workers. It does not inspect, call, or control real
agents, and does not import or modify the host app.

## Run

From `game-viewer/`:

```sh
./run.sh
```

That generates the asset catalog if it is missing, starts the server, and opens a
browser. `./run.sh --rebuild` regenerates the catalog first, `--port 4180` picks a
port, `--no-open` skips the browser, and `--test` runs the suite instead. To start
the server on its own, with the pack and manifest already in place:

```sh
node farm/serve.mjs
```

The sprite pack and generated catalogs are local prerequisites, excluded from
the source commit. On a fresh checkout, restore the pack under `assets/` and run
`node generate-assets.mjs` from `game-viewer/` before starting the server.

Open **http://127.0.0.1:4175**. `--port 4180` selects another port. Use the same
host and port when returning to an existing browser save. Node 24 is supported
and was used for verification. No installation, build step, network service,
credentials, or new dependencies are required.

The original asset viewer remains available through its existing separate
`node serve-viewer.mjs` command. The farm server reuses its catalog and image API
with an explicit list of extra static files. It remains loopback-only and
read-only; save data is in the browser, not written through HTTP.

## Play

A new farm starts with three unlocked plots, three working demo farmers, a cow,
a sheep, one scout, six seeds, eight feed, one tonic, and 35 coins. Nine more
plots can be bought individually: 50 coins for the first, then 25 more per plot.

- Farmers automatically prepare, plant, water, weed, feed animals, and collect
  ready milk/wool. Choose an assignment to reserve a farmer for a plot or livestock.
  A helper physically walks to the plot or the specific animal it is caring for —
  routed around the farmhouse and pond, and scaling with 1×/2×/4× like the rest of
  the simulation — before its work actually progresses; a plot destroyed by a
  monster stays ruined until a helper walks over to clear and replant it. Planting
  a seed uses a throwing-items pose instead of the hoe.
- Select a plot in the scene or with its numbered button. The main farmer can
  help manually. Parsnips need 180 seconds of good conditions; wheat needs 240.
  Tend and Harvest need your farmer standing next to that plot; Milk/Shear, Heal
  and Slaughter need it standing next to that animal. Too far, and the button
  disables itself with its own label, e.g. "Walk closer to tend" — it re-enables
  the moment you arrive, no popup. Buying, selling, choosing a crop, healing
  yourself or a protector, and Harvest all ready all work from anywhere.
- Click or Tab into the canvas, then use arrow keys to move your farmer. Press
  Space near a ripe crop to harvest, near ready livestock to collect milk/wool,
  or near a monster to swing a sword. An enemy within reach takes priority. Actions have a short cooldown.
  Moving away from the canvas releases the keys; other app controls keep their
  normal keyboard behavior. Movement pauses with the game and stays at the same
  speed under 1×/2×/4×. Buildings, the pond, map edges, and enemy bodies block movement.
  The nearby-action hint updates as you move. Empty swings are harmless.
- Harvest ready crops yourself, or enable automatic harvest in Farm settings.
  Sell goods from Store & trade, or separately enable automatic selling.
- Buy seeds, feed, medicine, cows, and sheep. Milk and wool are recurring outputs.
  Milk and wool take 180 seconds to replenish; the Livestock panel shows the
  countdown and Milk/Shear buttons. With automatic collection enabled, helpers
  may already have moved ready products into Store & trade.
  Slaughter requires selecting and confirming one animal; it produces meat/hides
  and permanently removes that animal and its future production.
- Scouts carry swords, knights carry swords and shields, and rangers use bows.
  They differ in price, health, and strength. Assign patrols to Farm, Garden, or Pasture. Upgrade a protector twice to
  improve health and attack power. Fighters use their actual on-screen positions
  and strike as soon as they enter reach. Defeated enemies dissolve and show
  their reward (2–6 coins, depending on type). Deploy a protector on an expedition for money or send it
  home to heal. Expeditions take three minutes and always leave a protector with at
  least a little health. Protectors fight to the death and never retreat on their own;
  a protector reduced to zero health in combat is lost for good, upgrades included. Send
  a wounded protector home yourself, or leave it on patrol at your own risk. A protector
  sent home returns to patrol automatically once fully healed. Medicine heals the farmer,
  animals, or protectors; automatic healing can be disabled.
- Successful plot harvests advance the threat tier at 6, 18, and 36 harvests.
  Raids grow from one weak slime to mixed groups with fast spear goblins, ranged
  spore spitters, and armored brutes. Entries rotate among all four sides. Monsters
  attack reachable crops, animals, and fighters; neglected defense can lose a
  harvest or an animal. The threat panel shows the next milestone.
- Expand Session simulator to add/finish a session, change working/idle states,
  ask or resolve a demo question, add child agents, or trigger an encounter.
  A root and its children appear as one farmer. Demo question controls affect
  only the simulator. Farmers show a question bubble and a Read question action.
- **Balance** next to Pause opens a live base-stat editor beside the game, so you can
  tune while you watch. It covers all eleven damageable types: your farmer, a plot of
  land, each animal, each protector, and each monster. Health and defense apply to
  every type; attack, interval, reach, and speed apply to the fighters. Drag a slider
  for a quick feel or type an exact number. Changes take effect immediately and are
  saved with the farm. Anything already alive keeps its current health percentage, so
  raising a cap heals nothing and lowering one kills nothing; a ruined plot stays
  ruined. Defense subtracts a flat amount from each incoming hit, down to no damage,
  and does not protect against thirst or starvation. **Restore default stats** puts
  everything back without touching coins, harvests, or progress.
- Owned land can be attacked whether or not something is growing in it. The bed and
  its crop share one health pool. Land reduced to zero is ruined but still yours:
  tend it to repair the ground, then plant again. Locked land is never attacked.
- Use Pause and the 1×/2×/4× speed selector. Hidden pages, sleeping computers,
  and closed pages accrue no elapsed game time. Idle sessions supply no labor:
  crops can wither when the visible game remains open without care.

Free starter seeds are available only when you have none and cannot afford more.
The main farmer recovers when safe; a protector sent home heals there and returns
to patrol on its own. Starter seeds let you replant after losses. Slaughter, supplies,
land expansion, healing, and better defenders compete for the same limited coins.

## Saves

The game saves after player actions, every five seconds, and when leaving/hiding
the page. Save failures remain visible, with retry and export controls. A previous
valid snapshot is retained and explicitly reported if used for recovery. If both
copies are corrupt, the game preserves them and stops instead of silently resetting.

Browser storage is scoped to the exact origin and browser profile. The save keys
are `hearthfield.farm.v1` and `hearthfield.farm.v1.backup`. Changing the port, using
another browser/profile, or clearing site data means a different or absent save.
Export a save before clearing browser data. Web Locks prevents a second tab on
the same origin from simultaneously running and overwriting the farm.

Saves contain game state, not session identifiers, prompt text, working flags, or
time-away calculations. Workers are reconciled from the current session source
on every mount. An old save never grants work from sessions that no longer exist.
Version3 saves include combat positions, patrols, upgrades, purchased plots,
harvested-plot milestones, and your base-stat settings. Earlier v1 and v2 saves
migrate without losing resources or their accessible plots; crop and animal
production percentages are preserved, and they arrive on the shipped default stats.
Unrecorded harvest history starts at zero.

Use **New farm…** to try the new three-plot opening. The confirmation exports
your current farm before replacing it; cancelling keeps it. Existing saves are
never reset automatically.

## Connect the app later

There are four replacement boundaries. The game never needs provider-specific
transcript or process logic.

```js
import { mountFarm } from './farm/app.mjs';

// Adapter implemented by the host when its session APIs are ready.
const source = {
  subscribe(onSnapshot) {
    // Send an initial complete snapshot, then ordered complete replacements.
    onSnapshot({
      version: 1,
      revision: 1,
      connected: true,
      sessions: [{
        id: 'codex:stable-root-session-id',
        parentId: null,
        provider: 'codex',
        name: 'Repository work',
        activity: 'working',
        attention: null,
      }],
    });
    // Replace this example with the host's subscription and return its unsubscribe.
    return () => {};
  },
};

const dispose = mountFarm(document.getElementById('farm-root'), {
  sessionSource: source,
  saveStore: hostFarmSaveStore,
  onAttention: (sessionId, attention) => hostOpenQuestion(sessionId, attention.id),
  // Optional: return the same sprite images from the host's local asset protocol.
  assetLoader: hostLoadFarmArtwork,
});

// When the host removes the view:
dispose();
```

`hostFarmSaveStore`, `hostOpenQuestion`, and `hostLoadFarmArtwork` in this example are host-supplied
objects/functions, not implemented app APIs. The save adapter's synchronous
`load()` returns `{state, warning}`; `save(state)` succeeds synchronously or throws.
A future asynchronous disk/IPC store should maintain a local snapshot cache and
explicitly surface eventual write errors, or extend this adapter contract before
integration. Do not wrap an asynchronous write in `save()` and falsely report
success before it finishes.

`subscribe` must return an unsubscribe function and deliver complete validated
snapshots. Revisions are nonnegative, monotonically increasing safe integers
within a mounted source, including reconnects. Ignore duplicate/older revisions.
Use stable, provider-qualified session IDs, never a bare process ID or a guessed
shared-folder match. Closed sessions are absent; a disconnected source explicitly
emits `connected: false`. The game does not infer a disconnect merely from silence.

Supported activities: `working`, `idle`, `waiting_input`, `waiting_permission`,
`error`, and `unknown`. Attention is null or `{id, kind, text}`. The host owns
correlation and resolution of real prompts. Do not clear an attention item simply
because another unrelated event arrived. Children include their root/ancestor
through `parentId`; an orphan child does not create a visible farmer. Limit each
snapshot to 512 sessions, including at most 64 roots.

`assetLoader({signal, onError})` returns a promise resolving to an image map keyed
by `ART` in `art.mjs`, with the same sprite regions. Observe the abort signal,
report individual failures through `onError`, and reject for total loading failure.
Omit this option to use the current local catalog/image endpoints. The host can
supply its own protocol without editing the game's renderer. UI and simulation are
separate: `createFarm`, `command`, `upgradeFarm`, `applySessionSnapshot`, and `advanceFarm` also
run under Node without a DOM. If the host needs simulation while its farm view is
hidden, run the model with the host's scheduler and adapt the view accordingly;
the standalone mount deliberately owns a visible-page clock.

The full data/action contract is in [CONTRACT.md](./CONTRACT.md). The exported
`serializeFarm` and `parseFarm` functions define the versioned save envelope.

## Verification and limits

Run the existing Vitest installation from `game-viewer/`:

```sh
../node_modules/.bin/vitest run --config vitest.config.mjs
```

HTTP tests bind ephemeral loopback ports. Restricted environments must permit
that local binding. The local config keeps Vite's temporary cache in this folder.

This is a playable first build, with a small set of content and preliminary
economy/combat timings. Protectors use existing sword/bow animation strips, with
a shield marker for knights. Terrain is drawn in Canvas; original character, crop, animal, house,
tree, and slime PNGs come from the local pack. It has no audio, breeding, seasons,
multiplayer, remote accounts, or real app connection.

The connected browser was unavailable during this build. DOM interaction tests,
HTTP checks, asset-region inspection, and simulation tests do not substitute for
a visual playtest in a browser; that final visual check remains outstanding.
Reported gameplay problems are recorded in [KNOWN_ISSUES.md](./KNOWN_ISSUES.md),
including the original attack-reach report and its spatial-combat changes.

Artwork: Farm RPG by EmanuelleDev, used from the user's existing local asset pack.
Original artwork is not changed or copied into the source deliverable.

Source, tests, and design documents are tracked normally in the surrounding
repository. The local `.gitignore` excludes the sprite pack, generated catalogs,
caches, session memory, and temporary review reports. No host app code was changed.
