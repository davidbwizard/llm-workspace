# Local Sprite Utility — Design and Roadmap

Date: 2026-09-11

Status: Design draft for user review. Local-browser delivery is approved. This
document does not authorize implementation, dependency installation, paid image
generation, asset uploads, or changes to the original asset pack.

## 1. Product and scope

Build a local utility that can browse sprite packs, combine compatible parts into
complete characters, and eventually assist with creating new artwork. Extend the
existing `game-viewer/` application; do not integrate it into the surrounding
LLM-workspace Electron application or refactor that application.

The user chooses the visual result and approves ambiguous mappings. Scripts do
repeatable scanning, composition, validation, and export. Coding agents can use
the recipe CLI directly; no dedicated agent interface is required initially.

### Approved direction and proposed defaults

- Run locally in a browser, served by the existing Node application.
- Use Farm RPG as the first composition profile, not a universal naming standard.
- Preserve folder-based browsing, filters, lazy previews, and irregularity reports.
- Start character composition with Idle, Walk, and Run only.
- Preserve original files. Store profiles, recipes, drafts, and exports separately.
- Keep scanning and composition usable without AI credentials or network access.
- Implement and demonstrate one milestone before expanding the next.

Not included in the initial release: desktop installers, cloud accounts, ZIP
imports, a general pixel-painting editor, engine-specific importers, all Farm RPG
work/combat/mount animations, arbitrary cross-pack character mixing, or automatic
generation of complete animated characters.

## 2. Existing foundation and gaps

The current application already provides:

- A local PNG scanner, Aseprite canvas/tag reader, classification rules, and JSON
  catalog containing the exact folder hierarchy.
- Per-frame/cell sizes kept separate from whole-image dimensions.
- Missing-metadata, empty-image, layout-conflict, and duplicate-file reports.
- A loopback-only server with bounded result pages and individual asset access.
- Folder filters, on-demand image previews, and a sheet/cell inspector.
- Existing Vitest, HTTP, and jsdom tests in `game-viewer/tests/`.

The current PNG reader already inflates RGBA data and implements all five PNG
scanline filters for inspection, but does not expose decoded pixels. The Aseprite
reader exposes canvas/frame counts and tags, not layer order/frame timing. The
inspector does not play named animations. The server is currently read-only.

A read-only IHDR census on 2026-09-11 found all 5,747 installed PNGs are 8-bit
RGBA (colour type 6), non-interlaced. This describes this copy of the pack, not
future versions or other packs. Make the census repeatable in the scanner report.

Read-only samples of body, eyes, hair, clothing, and accessory PNGs agree on
32×32 frame geometry for the first three actions: Idle strips are 512×32, Walk
768×32, and Run 1024×32. The Idle source tags describe four directional groups.
This establishes candidate compatibility, not verified layer order, exported
direction order, attachment alignment, or a guarantee for every part.

## 3. Architecture

### Selected approach: browser preview, Node export, shared frame mapping

Keep Node ESM and the existing HTML/CSS/JavaScript UI. Extract pack-specific
behavior into versioned profiles incrementally as the milestones require it.
Use JSON files for settings and recipes; no database is needed for the initial
single-user, single-active-pack application.

Validation resolves a recipe into source rectangles, per-direction layer order,
integer offsets, and durations. Both render paths consume this same frame plan:

- Browser preview: stack positioned image backgrounds in a clipped frame and
  step their background positions together using one playback clock. Load only
  selected parts, use nearest-neighbour scaling, and update order with direction.
- Authoritative export: the Node compositor blends the selected pixels and
  writes PNG sheets. Both CLI and browser export requests call this service.

No server-rendered live previews, preview job queue, or custom render cache is
needed. Keep a simple selection/version guard against stale image loads. Validate
again before export; a browser preview does not authorize an invalid recipe.
Test preview/export agreement rather than assuming all art has binary alpha.
Aseprite integration stays optional, not an installation prerequisite.

### File and ownership boundaries

Existing scanner, catalog schema, inspector, and CLI defaults remain compatible.
New modules stay under `game-viewer/` and are added only when their milestone
needs them:

| Responsibility | Proposed location |
|---|---|
| Validated RGBA decoding, composition, PNG encoding | `sprite-pixels.mjs` |
| Profile validation and compatible part resolution | `composition-profile.mjs` |
| Farm RPG composition mappings | `profiles/farm-rpg.composition.json` |
| Recipe validation, resolved frame plan, deterministic export | `compose-character.mjs` |
| Initial terminal entry point | `compose-character-cli.mjs` |
| Builder UI and animation preview | `builder.js` plus existing viewer shell |
| Persisted user data and generated files | `workspace/`, outside `assets/` |

Select `pngjs` for M1 PNG decoding/encoding instead of extending the handwritten
codec. It is pure JavaScript and supports indexed-colour and interlaced input
as well as RGBA ([upstream documentation](https://github.com/pngjs/pngjs)).
Retain `inspectPng()`'s public contract, CRC/error checks, and resource limits;
move its pixel inspection onto the same decoder with regression tests. Do not
claim APNG or every image format is supported. Reject unsupported composition
inputs explicitly. Do not decode the whole catalog into memory.

This selects the dependency for the proposed M1 implementation; it does not
install it. No agent SDK, new framework, or new test system is needed.

## 4. Data contracts

These are separate, versioned documents. They must not overload `type` or
reinterpret the existing catalog's `frames` field.

**Pack profile:** identifies the pack and profile revision; defines logical part
slots, stable part keys, action mappings, explicit frame rectangles, verified
direction names/order, offsets, and timing provenance. Store bottom-to-top
`drawOrder` under `actions[action].directions[direction]`, not once per profile.
Validate that each selected slot appears exactly once; omit explicitly empty
optional slots when resolving the plan. Direction-specific offsets live alongside
that mapping. Per-frame order overrides can wait for a demonstrated need.
Frames remain per action/direction, not the total number of cells. Display labels
can be friendly while paths retain their exact original spelling.

**Character recipe:** records a user name, pack/profile revision, selected part
keys, requested actions, and resolved source paths/hashes. It stores choices, not
copies of source images. Required slots are body, eyes, and clothing. Hair and
accessory each allow an explicit `null`/"none" selection, including bald characters
and hats used without hair. Selecting a hat does not silently remove hair. A
selected part with a missing animation or incompatible mapping is an error, not
a silently omitted layer.

**Validation report:** separates blocking errors from review warnings and names
the affected part/action/direction. Report source changes, unsupported images,
out-of-bounds regions, incompatible mappings, missing parts, and unexpected empty
results. Transparent cells in an optional layer can be intentional; do not reject
every empty accessory cell or discard it and shift the remaining frames.

**Export metadata:** provisionally use Aseprite-style JSON-array metadata per
action sheet: frame names/rectangles, durations in milliseconds, untrimmed source
sizes, and `meta.image`, `meta.size`, `meta.scale`, and `meta.frameTags`. Tags such
as `idle_down` identify each direction's contiguous frame range. Keep source
hashes, recipe/profile/compositor versions, and attribution in a separate recipe
or provenance sidecar, not a competing engine-facing format. Aseprite documents
[JSON arrays and frame tags](https://www.aseprite.org/docs/cli/); actual importer
support must be checked against the user's consuming engine/runtime, currently
unspecified. No blanket claim of native Godot/Unity/Phaser compatibility.

Preserve supported source directions; do not invent a left-facing animation or
silently mirror/drop directions to imitate a premade sheet. Any later mirror
operation must be explicit and recorded.

If a source file or profile changes, flag the recipe as stale before regenerating.
Reproducibility means identical decoded output pixels for identical approved
inputs, not merely identical filenames or a promise of identical future AI output.

## 5. Milestones and completion checks

### Step 0 — Track the utility safely

Before extending code, replace the broad `game-viewer/` Git ignore with narrow
rules that allow source, tests, profile definitions, documentation, and any local
package/lock files. Keep purchased `assets/`, user `workspace/`, generated
catalogs/reports, and dependencies ignored. Check Git's candidate file list before
staging; do not force-add the directory or touch unrelated workspace changes.
This design revision itself does not change ignore rules or stage files.

Record the pack's license and attribution alongside the profile. The bundled
`Documentation.txt` permits modification and project use, requires EmanuelleDev
credit, and prohibits redistribution of the pack, including modified assets.
The [current publisher page](https://maevedevs.itch.io/farm-rpg), checked on
2026-09-11, additionally prohibits AI training and lists different attribution.
Those terms differ; do not silently replace the bundled license or decide which
version governs the purchase. Training and reference-image generation are not
the same operation. Reference-upload permission remains unresolved and must be
clarified before using this art in generation. Local deterministic composition
is separate from that workflow.

### Milestone 1 — Verify and compose one character

Scope: one known recipe using existing Farm RPG parts; Idle, Walk, and Run;
terminal composition command and inspection artifacts. Do not build the general
part picker or invoke image generation in this milestone.

Sequence:

1. Add the header-format census to scanner reporting and introduce `pngjs` with
   decoder regression tests. Inspect representative layers for each action.
   Verify direction order, frame regions, per-direction layer order, and anchors.
   Matching dimensions or filenames alone must not establish these mappings.
2. Record the verified mappings in the initial composition profile. Extract
   source timing where available; otherwise mark a configurable preview timing
   as a default, never as source-authored timing.
3. Add bounded RGBA composition and PNG export, with tiny synthetic pixel fixtures
   testing partial alpha, direction-dependent order, offsets, clipping, and
   transparent-cell preservation. Include indexed and interlaced decoder fixtures.
4. Provide documented recipe validation/render commands with machine-readable
   reports and meaningful exit codes. Export one sheet per action, Aseprite-style
   metadata, a provenance sidecar, and enlarged contact sheets for inspection.
5. Review the composed result at native scale and enlarged scale before marking
   its profile mappings verified for use in the builder.

Completion checks:

- One character can be reproduced from a saved recipe for all three actions.
- Idle has 4 frames, Walk 6, and Run 8 per verified exported direction.
- Automated checks catch mismatched geometry, missing inputs, stale sources,
  bad regions, unsupported pixels, and attempted path escapes/overwrites.
- Synthetic tests prove layer order and alpha behavior independently of the pack.
- Exported metadata selects the intended cells, and all original asset hashes
  are unchanged by composition.
- A person reviews the contact sheets; any unverified mapping stays explicit.
- No image-generation call or external asset upload occurs.

This CLI is also the initial coding-agent interface. Include recipe and batch-use
examples; do not build a separate transport or tool server without a concrete
need the CLI cannot meet.

### Milestone 2 — Interactive character builder

Add a Build view alongside the existing Library view. Offer only parts mapped as
compatible with every selected action. Include explicit no-hair/no-accessory choices.
Show direction selection, play/pause, frame stepping, speed control, and the
validation report. Use browser-stacked layers for live preview; only saving or
exporting calls mutation routes. Persist recipes and create versioned exports.

Completion: switching parts updates the selected animation without fetching all
pack images; saving/reopening reproduces the same choices; 10 representative
recipes render all three actions; failures remain visible and recoverable. Users
can navigate and operate the builder with a keyboard. Check browser preview
against exported frames, including partial alpha, offsets, directional occlusion,
and any colour-profile effects; record discrepancies rather than hiding them.

### Milestone 3 — Reusable pack workflow

Separate Farm RPG classification/source assumptions from the generic scanner.
Allow selecting among pack roots explicitly registered when the local server
starts; use one active pack at a time. Initial registration uses local startup
configuration, not an endpoint that grants AI arbitrary filesystem access.

Unprofiled packs get folder browsing, PNG dimensions, and supported structural
checks. Composition remains unavailable until compatible parts and animation
regions have a verified profile. Add a profile/override review workflow; leave
unknown values unknown.

Completion: the existing Farm RPG catalog retains its classifications, another
small test pack scans without Farm RPG assumptions, and recipes cannot resolve
parts from a different pack accidentally.

### Milestone 4 — AI-assisted new artwork (formerly M5)

First resolve reference rights and provider data-use terms; user approval alone
does not supply missing rights. Do not upload Farm RPG artwork while permission
is unresolved. Independently created or explicitly permitted references are an
alternative. License uncertainty need not block local composition milestones.

Start with static props, icons, and single-pose accessory drafts. Define permitted
references, a palette, target frame geometry, and editable/protected regions.
Keep generation/editing separate from pixel conversion, validation, and approval.
Show native-scale and enlarged before/after views.

A single new hat image is not an animated character part. It becomes eligible
for the builder only after its required poses/directions are mapped and reviewed.
Pixel-size or palette checks alone cannot certify visual quality or good motion.

Completion: generated drafts have recorded inputs, model/settings, returned usage,
local output files, and an explicit review state. Approved images can enter the
catalog without replacing their references. Failed/rejected drafts do not appear
as compatible builder parts.

Provider/account choice, exact pricing, limits, and permitted reference uploads
must be confirmed before implementing or running this milestone. Use a bounded
trial to measure attempts, manual correction, and cost per accepted asset. A full
new animated character is a separate feasibility milestone, not a guaranteed
deliverable of static generation.

## 6. Safety, performance, and storage

- Keep the service bound to loopback. Preserve Host/Origin checks, CSP, safe text
  rendering, static-file allowlists, and canonical input-root restrictions.
- New mutations use dedicated POST routes, exact approved Host and Origin checks,
  strict `application/json` bodies, schema validation, and bounded request sizes.
  Reject missing, `null`, or unapproved Origins on mutations; do not allow
  cross-origin CORS/preflight requests. GET routes retain no write side effects.
  Do not add session authorization or separate CSRF tokens for this single-user
  loopback scope. Revisit authentication if remote/multi-user access is added;
  a hostile local process is not isolated by these browser-origin controls.
- Resolve source identifiers through registered packs, never an arbitrary path
  supplied by the browser or AI. Recheck source hashes before rendering.
- Create outputs in fresh export directories under the configured workspace root.
  Reject path traversal, source-root destinations, and symlink escapes. Write a
  complete export before publishing it. Reserve each destination exclusively,
  write temporary files, and rename within that new directory before marking it
  complete. Never overwrite an existing export. A check-then-rename alone does
  not guarantee no-overwrite safety under concurrent requests.
- Treat profiles and metadata as data, not executable scripts or AI instructions.
  Keep API credentials server-side; never include them in recipes, URLs, logs,
  browser payloads, or exports.
- Preserve source credit/license references and do not bundle purchased artwork
  into a distributed utility. User approval is required before external uploads.
- Retain 36-record metadata pages and the current on-demand preview behavior.
  Browser previews load only selected layers; Node decodes only requested export
  inputs. No preview job infrastructure or speculative caching. Bound aggregate
  decoded data and output size as well as the current 128 MiB per-image ceiling.
- Pause animation when its view is inactive. Release decoded preview resources
  after a pack/recipe change. Do not precompute every possible outfit.
- No unattended generation loop: one explicit draft request at a time, visible
  usage, and bounded attempts. Configure budget enforcement when the provider is
  selected; do not claim a hard monetary cap without enforceable request bounds.

## 7. Verification and delivery

Use the existing test infrastructure and focused command:

```sh
./node_modules/.bin/vitest run --config ../vitest.config.ts --root game-viewer
```

Add synthetic composition fixtures, decoder regression checks, real-pack mapping
checks, recipe round trips, HTTP security tests for mutations, and browser/export
comparison tests as their features are introduced. Separate automated structural
checks from human visual approval.
If an actual browser is unavailable, report that gap rather than treating jsdom
as visual or animation-quality verification.

After each milestone, report the working command/UI flow, tests actually run,
known limitations, and the next milestone's scope. Do not reuse the earlier
human-developer effort estimate as a promise of this agent's elapsed build time.

The next planning deliverable, after this design is approved, is a task-by-task
implementation checklist for Step 0 and Milestone 1 only. Later milestones retain separate
plans so new findings do not invalidate a large speculative build plan.
