# Little Meadow

A standalone, local farm game built from the existing Farm RPG asset catalog.
Demo sessions supply farm workers. It does not inspect, call, or control real
agents, and does not import or modify the host app.

## Run

From `game-viewer/` with the existing asset pack and generated manifest:

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

The farm starts with twelve plots, three working demo farmers, a cow, a sheep,
a scout, seeds, feed, medicine, and 120 coins.

- Farmers automatically prepare, plant, water, weed, feed animals, and collect
  ready milk/wool. Choose an assignment to reserve a farmer for a plot or livestock.
- Select a plot in the scene or with its numbered button. The main farmer can
  help manually. Parsnips grow in 75 seconds of good conditions; wheat takes 120.
- Click or Tab into the canvas, then use arrow keys to move your farmer. Press
  Space near a ripe crop to harvest, or near a slime to swing a sword. An enemy
  within reach takes priority over a crop. Actions have a short cooldown.
  Moving away from the canvas releases the keys; other app controls keep their
  normal keyboard behavior. Movement pauses with the game and stays at the same
  speed under 1×/2×/4×. Buildings, the pond, and map edges block movement.
- Harvest ready crops yourself, or enable automatic harvest in Farm settings.
  Sell goods from Store & trade, or separately enable automatic selling.
- Buy seeds, feed, medicine, cows, and sheep. Milk and wool are recurring outputs.
  Slaughter requires selecting and confirming one animal; it produces meat/hides
  and permanently removes that animal and its future production.
- Scouts carry swords, knights carry swords and shields, and rangers use bows.
  They differ in price, health, and strength. Patrols intercept approaching slimes
  with visible attacks; each protector focuses one threat. Defeated slimes dissolve
  and show the 12-coin reward. Deploy a protector on an expedition for money or send it
  home to recover. Injured protectors retreat. Medicine heals the farmer, animals,
  or protectors; automatic healing can be disabled.
- Expand Session simulator to add/finish a session, change working/idle states,
  ask or resolve a demo question, add child agents, or trigger an encounter.
  A root and its children appear as one farmer. Demo question controls affect
  only the simulator. Farmers show a question bubble and a Read question action.
- Use Pause and the 1×/2×/4× speed selector. Hidden pages, sleeping computers,
  and closed pages accrue no elapsed game time. Idle sessions supply no labor:
  crops can wither when the visible game remains open without care.

Free starter seeds are available only when you have none and cannot afford more.
The main farmer recovers when safe, and can eventually repel an intruder even
without protectors. A loss therefore leaves a route to rebuilding.

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
Your farmer's position and facing are saved too. Earlier v1 saves without a
position remain compatible and start the farmer by the farmhouse.

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
separate: `createFarm`, `command`, `applySessionSnapshot`, and `advanceFarm` also
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
including the attack-reach issue from the first user playtest.

Artwork: Farm RPG by EmanuelleDev, used from the user's existing local asset pack.
Original artwork is not changed or copied into the source deliverable.

Source, tests, and design documents are tracked normally in the surrounding
repository. The local `.gitignore` excludes the sprite pack, generated catalogs,
caches, session memory, and temporary review reports. No host app code was changed.
