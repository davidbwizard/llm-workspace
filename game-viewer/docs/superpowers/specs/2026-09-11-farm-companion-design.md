# Farm companion: product direction and first build

Date: 2026-09-11
Status: Design approved. Standalone-first amendment approved on 2026-09-11.

## Standalone-first amendment

The user approved this design and asked to build independently until the host app
is ready. The first playable implementation lives in `game-viewer/farm/`, with
simulated session events and no imports from or connections to the real app.
`farm/CONTRACT.md` and `farm/README.md` document the replacement boundaries.

For this standalone delivery, use the project's existing browser/Node ES-module
style rather than introducing a TypeScript build. Keep the simulation portable.
Inject the session source, save store, and attention-opening callback into the UI.
Use browser-local versioned saves with a previous valid backup. The standalone
page pauses when hidden as well as closed; the future host will control its own
background lifetime. These choices replace the proposed Electron clock/save
implementation below for the standalone build only. The broader game direction
and existing app's ownership of real session behavior remain unchanged.

## Purpose

Add a persistent farm game to the existing LLM-workspace app. It gives the user
something enjoyable to watch and manage while real agents complete real tasks.
Routine work is mostly automatic. Management is available without requiring
constant attention. Real agents do not receive game prompts or make game decisions.

The existing app owns session discovery, activity tracking, questions, permissions,
and access to real sessions. The game consumes that information through a small
adapter and owns its simulation, presentation, economy, and save data.

## Confirmed requirements

- The main farmer, farm, and land persist between app launches.
- Real session activity supplies workers who prepare soil, plant, water, and tend
  crops. Care follows a complete lifecycle rather than unrelated animations.
- Work left by a finished agent can be taken over by another worker. Crops retain
  their progress and condition. Prolonged neglect can cause withering and death.
- The user can manage the farm, but most routine work should be automatic.
- Crops, milk, wool, meat, and hides are tradable. Livestock needs care; milking,
  shearing, slaughter, butchering, and skinning are part of the intended game.
- Money buys protectors with different strengths and capabilities. The user can
  hire and deploy them. Monsters provide conflict.
- Protectors and the main farmer have health. Healing and saving are required.
- Closing the app pauses the entire world. Reopening does not simulate time away.
- A farmer may show a speech bubble when its real session needs user input.
- Dozens of subagents must not turn into an unmanageable crowd.

## Proposed automation defaults

These defaults interpret the user's latest request for a mostly automatic game.
They are proposals, not claims that every mechanic has been individually approved.

| System | Automatic behavior | User control |
|---|---|---|
| Workforce | One visible farmer per top-level session; workers take urgent available care jobs | Assign a worker, set priorities, release an assignment |
| Crops | Prepare, plant, water, weed, and resume abandoned care | Select crops, manage plots, harvest; optionally enable auto-harvest |
| Livestock | Feed, water, and perform enabled milking/shearing jobs | Buy animals, manage pens, collect products, select animals for slaughter |
| Trading | Store produced goods; sell only under an enabled policy | Buy/sell manually; configure goods to retain and surplus to sell |
| Protectors | Patrol an assigned area, fight threats in range, retreat when badly hurt | Hire, choose posts, deploy, recall, set retreat thresholds |
| Healing | Recover at home and use supplies under an enabled policy | Buy supplies, heal manually, reserve supplies |
| Saving | Save periodically and after consequential actions | See save failures and explicitly retry |

Harvest and sale automation starts off, preserving the earlier request for user
control. The player can enable each separately. Slaughter remains an explicit
player order for a selected animal; routine livestock automation does not imply
permission to consume animals. Execution can then be an ordinary queued job.

Slaughter, butchering, and skinning operate on one animal/carcass lifecycle.
Product collection is recorded so repeating an action cannot duplicate meat or
hides. A living animal supplies recurring products; slaughter removes that future
production. Eggs and breeding are possible later additions, outside this scope.

Subagents contribute to their parent session's working state when the host can
attribute them reliably. They do not create additional farmers or multiply output
by their count. An open but idle session supplies no active labor. Work rate is
based on elapsed active game time, not token spend, tool-call count, or task length.

## Work and time rules

Workers choose urgent care first, then new planting and enabled production jobs.
Only one worker owns a job at a time. Manual priorities affect this same queue.
Work can be reassigned between actions; crop and animal progress belongs to the
farm, not to a particular session. Sessions finishing a turn stop contributing
labor. The character can rest at the farm until the session resumes or closes.

A session waiting on the user pauses its farmer's labor and shows the appropriate
alert. A configurable neglect grace period prevents a brief question or handoff
from immediately harming a crop. Actual withering remains part of the game.
If every session is idle while the app remains open, unattended care still decays
after that grace period. The main farmer can perform player-directed recovery
work; it does not silently replace the entire session workforce.

The simulation runs while the app is running, including when its farm view is
hidden. Hiding the view stops visual animation work, not simulation time. Quitting
the app and system sleep freeze growth, neglect, combat, and healing. Resume starts
from the saved or suspended state; there is no wall-clock catch-up. Minimize and
window-close behavior follows whether the host application actually remains running.

The game needs a recovery route: a replenishable starter seed allowance and safe
home recovery let the main farmer restart after crop or combat losses. Recovery
must not require money that the player has no remaining way to earn.

## Host integration

Use a small typed adapter between the app's fleet model and the game. Do not put
provider-specific parsing, process discovery, or transcript scans in the game.

The adapter supplies:

- A stable top-level session identity, provider, and display label.
- Whether that session is open and working, idle, waiting for input, waiting for
  permission, in error, or of unknown activity.
- Reliably attributed parent/child activity when the host makes it available.
- An optional current attention item with an identity, kind, safe display text,
  and a host-supported action for opening the relevant session or prompt.
- Connection availability, initial snapshot, and ordered subsequent updates.

The game produces farm commands and requests to open host UI. It never launches
real work to keep crops alive, submits answers, approves real permissions, or
executes commands from a speech bubble. Ordinary host session and question views
remain accessible without navigating the game.

Speech bubbles are presentations of actual host signals. Display the real question
when the host supplies it; otherwise use a truthful short label such as "A question
is waiting." Do not infer a question from arbitrary last prose or call another
LLM to invent a summary. Show a short bubble and let the host display full details.
Clear it only when its corresponding attention item resolves or the session ends.

Initial inspection found `listFleet` and `onFleet` in `src/preload/index.ts`, with
working/waiting/idle states in `src/fleet/state.ts`. Internal `Blocker` records in
`src/store/signals.ts` carry correlated prompt identifiers and display text.
The inspected live `OpenSession` payload does not expose the complete blocker,
and the inspected preload has no open-question action. These are integration
points to coordinate with the ongoing host work, not features already available.

Some live process/session matches are ambiguous and their activity is null.
Never attach another session's question or work state by guessing a shared folder
match. Preserve stable identities across snapshot refreshes; a PID alone is not a
durable session identity. Temporary disconnects must not manufacture new workers,
duplicate jobs, or leave stale workers producing indefinitely. Pause the farm with
a connection notice if the host activity feed is unavailable; resume after a valid
snapshot. A known session closure releases its job normally.

The host is being edited concurrently. Recheck its actual types when connecting
the adapter and keep changes small. The sprite utility design is a separate tool
project; this game belongs in the main app. This document supersedes the older
farm sketch in section 14.1 of the app design for subagent crowding, harvest
triggers, and rewards based on token/cost metrics.

## Implementation shape

Recommended approach: a small TypeScript simulation in the existing Electron
app, with Canvas 2D for the world and existing React components for controls.
Use the existing stack and test infrastructure; no new game engine is required
for the first build. The JSON asset catalog resolves artwork, while separate game
definitions specify crop timings, prices, care needs, and character capabilities.

The simulation owns plain serializable state and advances through explicit elapsed
game time and commands. It runs outside React rendering so view changes and frame
rates cannot alter production or combat. A lightweight main-process scheduler
advances it; the renderer animates snapshots when visible. Do not rebuild or send
the entire asset catalog or session history on each game tick.

Suggested responsibility boundaries within the host app:

- `src/game/`: simulation, definitions, jobs, commands, and host adapter.
- `src/renderer/game/`: world rendering, farm controls, and speech bubbles.
- A dedicated main-process game service: scheduling, save/load, and narrow IPC.

Prefer this over driving the simulation entirely from browser animation frames,
which are throttled when hidden and complicate app-wide pause behavior. A separate
game process or engine can be reconsidered only if measured needs justify it.

Persist a versioned snapshot in the host's application-data directory using a
fixed save path, atomic replacement, and a previous valid backup. Keep farm data
separate from the session index. Save crops, animals, inventories, balances,
characters, health, care/production progress, policies, jobs, and simulation time.
Treat live connections as temporary and reconcile workers with current sessions
on load; a saved working flag must not grant labor on restart.

Serialize save writes and validate loads before replacing live state. A failed
load or save is visible and preserves recoverable data. Do not silently reset the
farm. Validate IPC commands, IDs, quantities, prices from trusted definitions,
affordability, and action eligibility in the game service. Render host text as
text, preserve existing sanitization, and keep the existing IPC allowlist model.

The catalog includes farm animals, crops, characters, enemy families, objects,
tilesets, and UI art. Some sprite regions and growth stages remain unverified.
Select and visually verify a small working set; unknown mappings are not usable
animation definitions merely because sheet dimensions divide into a grid.

## Build sequence

1. **Farming and integration:** one small farm, main farmer, session farmers,
   a single crop with the complete care/neglect/harvest lifecycle, automatic job
   takeover, manual assignment, question indicators, pause rules, and save/load.
   This proves the central experience using both simulated host events and the
   real adapter. Include starter inventory and harvest storage.
2. **Economy and livestock:** buying/selling, optional harvest/sale policies,
   feeding, watering, milk, wool, meat, hides, and explicit slaughter orders.
3. **Defense and recovery:** monsters, protector capabilities, hiring, patrols,
   deployment, combat health, retreat, healing, and loss recovery.
4. **Content and tuning:** more crops/animals/protectors, richer environments,
   animations, and balanced production/threat timings based on actual play.

Each stage needs a focused implementation plan. Later systems should not be
scaffolded into the first stage before its farm loop is working.

## First-stage acceptance checks

- One reliably identified top-level session produces one farmer. Dozens of
  child-agent events do not create dozens of farmers.
- Working, waiting, idle, closed, and resumed sessions affect labor correctly.
  Duplicate or stale host updates do not duplicate workers or work.
- A second worker resumes an abandoned crop without resetting its progress.
  Ownership changes cannot award the same action twice.
- Care, growth, withering, death, and manual harvesting produce consistent state
  under an injected clock, independently of animation frame rate.
- Manual assignment overrides automatic selection without losing queued work.
- Waiting indicators use the correct session and clear with the matching signal.
  Unsupported host navigation is not presented as an available action.
- Save/load preserves the farm; quit/reopen and suspend/resume advance no game
  time. Hidden farm views continue simulation while the app remains running.
- Invalid commands, corrupt saves, unavailable host feeds, and unknown session
  matches have explicit, recoverable behavior.
- Verify selected sprite cells and visible animation in the app. Run focused
  tests with the existing Vitest setup and the host's TypeScript check.

This draft specifies direction and acceptance criteria. It does not claim the
game, question-navigation hook, or save system has been implemented or tested.
