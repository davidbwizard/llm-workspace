# Asset manifest

## Local viewer

```sh
node game-viewer/serve-viewer.mjs
```

Open **http://127.0.0.1:4173**. Use `--port 4174` to change the port. Ctrl+C stops
the server. It binds only to localhost and serves the generated catalog read-only.
Generate the manifest before first use; restart the viewer after regenerating it.

Filter by asset type, nested folder, content kind, pixel size, search text, or review status.
Select **Characters** to reveal its child folders, then use the arrows to expand
deeper branches. Folder names match the pack exactly, for example:
`Characters → Character → PNG → 1. Idle → Hair's` or
`Characters → Character → Pre-made → Josh`.
Selecting a folder includes all descendants and combines with the other filters.
Folder counts are totals for that type, before size/search/review filters.
Breadcrumbs navigate back up; selecting the type again clears its folder filter.
The URL preserves the selection when you refresh or bookmark it.
Size defaults to **frame/cell size**, with a separate **whole-image size** option.
Unknown sizes stay selectable without guessing a grid.

Folder children are fetched only when their type or parent branch is expanded;
reopening an already loaded branch reuses it. Only the selected folder's ancestors
are expanded when restoring a URL. The folder API sends names, paths, and counts,
not complete sprite records. The type's shared folder prefix is omitted in the
sidebar (for this pack, **Characters** represents the pack's `Character/` folder).

Only 36 metadata records are sent per page. PNGs are fetched as their cards
approach the viewport; full metadata and the selected sheet are fetched when
you open the inspector. Changing pages/filters cancels pending requests and
releases decoded image resources. The full manifest stays on the server.

The inspector provides whole-sheet and single-cell views, 1×–8× zoom, a grid
overlay, a cell slider, source/review information, and an asset-path copy button.
Cells use row-major order; direction names and animation playback are not inferred.
All UI files are local, with no framework, build step, CDN, or new dependencies.

## Generate the catalog

Run from the workspace root:

```sh
node game-viewer/generate-assets.mjs
```

Writes `game-viewer/assets-manifest.json`. Runs entirely locally with Node.js
(tested on Node 24; uses the built-in `zlib.crc32` API);
no packages, AI calls, or network access are needed. Re-run when assets change.

The default JSON (`schemaVersion: 3`, `layout: "folders"`) mirrors the asset folder structure:

```text
Farm RPG - Tiny Asset Pack - (All in One)
├── Animals
│   └── Farm
│       └── Chicken
├── Character
│   └── Character
│       └── Pre-made
│           └── Josh
│               └── Fishing
├── Crops
│   ├── Spring
│   ├── Summer
│   └── Fall
└── ...
```

Each folder has a `path` relative to `assets/` (the root is `""`),
`folders` keyed by its exact child-folder names, an `assets`
array containing only its direct PNG files, and a `summary` counting all PNGs
in that folder and its descendants. Only folders containing PNGs are included.
Each sprite record appears once. Folder names and file locations are preserved.

For example, Josh's sprite entries are under
`manifest.folders[packName].folders.Character.folders.Character.folders['Pre-made'].folders.Josh.assets`.
His fishing sprites are in that node's `folders.Fishing.assets`.

To generate a flat `assets` array (`schemaVersion: 3`, `layout: "flat"`):

```sh
node game-viewer/generate-assets.mjs --flat --out game-viewer/assets-flat.json
```

Each PNG entry keeps `name`, `location` (relative to `assets/`), `type`, `width`,
`height`, `animation`, `frames`, `framesSource`, and `needsReview`. It also includes:

- `kind`: `animation`, `static`, `growth-stages`, `variants`, `tileset`, `mixed`, or `unknown`.
- `imageSize`: dimensions of the entire PNG.
- `frameSize`: the exported animation frame size, or the full image for verified static assets.
- `cellSize`: grid size for non-animation sheets. It is separate from animation frames.
- `columns`, `rows`, `cellCount`: physical grid cells, including transparent cells. These are not counts of unique objects or animation frames.
- `stageCount`: verified growth-stage count, otherwise `null`. Seeds, harvested items, and empty cells are not automatically counted as growth stages.
- `source`, `frameSizeSource`, `rule`: provenance of the mapping, where applicable.
- `empty`, `pixelInspection`, `sha256`: transparency-check result, inspection coverage, and byte identity.
- `metadataNeeded`: remaining classification/mapping work; `warnings`: conflicting metadata or layouts.

Locations uniquely identify files; names can repeat. `needsReview` covers missing
metadata, layout/source warnings, and empty files. Read the report's separate
categories to distinguish incomplete mappings from potential asset defects.

`frames` counts frames per animation and direction. Verified static images have
`frames: 1`; growth/variant/tile sheets have `frames: null` because an animation
count is not applicable. Josh's idle PNG has 4 frames in each of 3 directions:
`imageSize: [128, 96]`, `frameSize: [32, 32]`, `cellCount: 12`.

The generator reads the included `.aseprite` files once. Their canvas sizes and
animation tags are listed under the manifest's top-level `sources`. Playable
character and supported NPC paths are matched to those sources. Directional tags
establish frame counts; named action ranges select the correct section of combined
timelines. Source tags are source metadata, not a claim that every direction was
exported into every PNG. For example, premade characters omit source directions.

PNG dimensions validate each proposed layout. Known export differences are
handled explicitly: 32px modular strips, 32×48 mounted horse frames, and 64×64
padded premade carrying frames. Fishing's full source canvas is 64×64 even though
its modular character layers may export as 32×32. The pack's 16 pixels per unit
and Aseprite editor grid do not determine frame size.

The pack description is a fallback and cross-check. Conflicting frame counts are
reported; a source count that does not fit the exported PNG is withheld. Unknown
files are never assigned 16px/32px frames just because their dimensions divide evenly.

Edit `game-viewer/asset-rules.json` to add verified family mappings. Rules match
asset-relative paths with case-insensitive `*` and `**` globs. The first matching
rule wins, so put specific rules before broad ones. Optional `widths`, `heights`,
and `exclude` limit applicability. Rules can specify `kind`, `frames`, `animation`,
`frameSize`, `cellSize`, `stageCount`, and `metadataNeeded`. Sizes are `[width, height]`,
`"image"`, or pairs containing `"width"`/`"height"` to refer to the PNG dimensions.
Use `--rules FILE.json` to replace the default rules file. Source-derived mappings
are applied first, family rules next, and exact per-file overrides last.

To supply verified counts, create a JSON object keyed by the exact `location`:

```json
{
  "Farm RPG - Tiny Asset Pack - (All in One)/UI/Clock/Clock.png": {
    "kind": "static",
    "frames": 1,
    "frameSize": [32, 32],
    "animation": null
  }
}
```

Then run `node game-viewer/generate-assets.mjs --overrides path/to/overrides.json`.
Overrides accept `kind`, `frames`, `animation`, `frameSize`, `cellSize`, and
`stageCount`. Counts must be positive integers or `null`; sizes must be positive
integer pairs or `null`. Static assets require one frame. Use `cellSize` for
growth/variant/tile sheets and `frameSize` for animations/static images.
Overrides still undergo geometry checks. Source/documentation disagreement remains
visible for auditing. Unknown paths and invalid overrides fail clearly.

Use `--assets DIRECTORY` and `--out FILE.json` to change the input or output.
The output directory must exist. Symlinks are skipped. Unreadable/invalid PNG
files or malformed Aseprite metadata fail the scan without replacing the previous manifest.

Every run also writes `game-viewer/assets-irregularities.json`. Use `--report
FILE.json` to change its location. It includes exact file paths grouped into:

- Incomplete classification, frame sizes, animation regions, and growth-stage roles (metadata needed).
- Unknown animation frame counts, excluding static images and non-animation sheets (metadata needed).
- Fully transparent PNGs (warning; placeholders may be intentional).
- Source/documentation disagreements and incompatible export layouts (warning).
- Unrecognized category folders (warning).
- Widths/heights not divisible by 16 (informational; custom sizes can be valid).
- Byte-identical PNGs, grouped by SHA-256 (informational; modular parts may
  intentionally repeat, and visually identical PNGs with different encodings
  will not be grouped).

The report includes counts and does not modify any assets. The PNG reader checks
chunk boundaries, checksums, image data lengths, and row filters. Transparency
inspection supports non-interlaced 8-bit RGBA, which covers all 5,747 PNGs in this
pack. Other PNG pixel formats and APNG get an explicit unsupported-inspection
entry; they are never assumed empty or fully validated. It is not a visual or
semantic inspection of the artwork. Decompressed pixel data is limited to 128 MiB
per image. On a failed scan the report contains `status: "failed"` and the first
error, and the process exits unsuccessfully while preserving the previous manifest.

Run the focused tests using the workspace's existing Vitest installation:

```sh
./node_modules/.bin/vitest run --config ../vitest.config.ts --root game-viewer
```

The integration tests require the local asset pack. No packages are installed.
Binary format references: [Aseprite file specification](https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md)
and [PNG specification](https://www.w3.org/TR/png-3/).
