# Visual Design

**Date:** 2026-09-10
**Status:** chosen direction, binds Plan 2
**Mockup:** https://claude.ai/code/artifact/01be00cc-c6f6-4084-aa00-98458efb8827
**Rejected alternative:** https://claude.ai/code/artifact/b9d976e1-235f-41fb-826e-8e8d0a0f481f

Two directions were built from real index data and reviewed. The cool one — an
instrument-panel read, cyan-biased neutrals, geometric display face — was
rejected as too severe. This is the chosen one.

---

## 1. The principle that matters most

**Spend the warmth in one place.**

The first warm attempt read as sepia. The cause was warming three layers at
once: ground, text and accent all leaning brown together. Ground `#191310`,
text `#f0e7df` (cream), light-mode ground `#f6f1ea` (parchment).

The fix was not less warmth, it was *concentrated* warmth. Neutrals sit close to
neutral with only a trace; the accent carries it alone.

Any future addition follows the same rule. A new warm surface, a warm border and
a warm text colour together will reintroduce sepia no matter how subtle each one
is individually.

## 2. Tokens

Dark is the default. Light is a designed second theme, not an inversion.

```css
/* dark — bare :root */
--ground:#1a1918;  --surface:#232120;  --raised:#2e2b29;
--line:#3b3735;    --line-soft:#282523;
--ink:#ece9e6;     --ink-2:#c3bdb8;    --muted:#938c86;  --faint:#635d58;
--accent:#d9a95f;  --accent-soft:#33261440;
--signal:#dd9a6a;  --signal-soft:#33221740;
--critical:#c97a6d;--critical-soft:#331d1a40;
--ok:#9fb083;
--r-lg:16px; --r-md:12px; --r-sm:9px;

/* light — @media (prefers-color-scheme: light) guarded as
   :root:not([data-theme="dark"]), and again under :root[data-theme="light"] */
--ground:#f6f5f3;  --surface:#ffffff;  --raised:#ecebe8;
--line:#d9d5d0;    --line-soft:#e8e5e1;
--ink:#1c1a18;     --ink-2:#48443f;    --muted:#736d67;  --faint:#a29b94;
--accent:#9a6a1c;  --signal:#9c5f2c;   --critical:#a04437; --ok:#5d7342;
```

Three theme states, not two. An explicit choice stamps `data-theme`; the default
"system" setting stamps nothing, so `prefers-color-scheme` decides. Every token
is declared in the bare `:root` before any block redefines it, and `body` sets an
explicit background — a transparent body borrows the host's ground and renders
one theme's text on the other's surface.

## 3. Agent colours come from the provider, not from us

Claude Code assigns every spawned agent one of eight colours in its
`.meta.json`: blue, green, yellow, purple, orange, cyan, pink, red. The graph
uses **those**, nudged a few degrees toward the ground so none reads as a stray
cold pixel.

```css
--ag-blue:#78a6d4;  --ag-green:#8fb884;  --ag-yellow:#d9a95f; --ag-purple:#ab93d1;
--ag-orange:#d99568;--ag-cyan:#71bcb4;   --ag-pink:#d18ba8;   --ag-red:#d0776a;
```

This is not decoration. A user who recognises an agent by its colour in the CLI
should recognise the same agent by the same colour here.

## 4. Type

| Role | Face | Notes |
|---|---|---|
| Display | **Fraunces** | Soft serif with `SOFT` and `WONK` variable axes, both pushed up. Headings, project names, panel names. |
| Interface and body | **Karla** | Humanist, slightly irregular. All running text and controls. |
| Data | **IBM Plex Mono** | The humanist mono rather than the engineered one. Counts, ids, paths, timestamps. |

Google Fonts is the only permitted host under the Artifact CSP; in Electron they
ship as local assets. Every stack declares a real fallback.

`font-variant-numeric: tabular-nums` wherever digits align in columns — event
counts, durations, waiting times.

## 5. Icons

- **Interface icons: Phosphor.** Chosen by David. Its weight range carries state
  by weight and fill rather than hue alone, which matters because colour is
  already carrying per-agent identity.
- **Provider marks: Simple Icons** (CC0) — the official single-path Anthropic and
  OpenAI glyphs, rendered monochrome so they inherit the surrounding colour and
  invert correctly between themes with no second asset.
- **No emoji anywhere.** Not in the interface, not in status markers, not in
  copy, not in terminal output. Standing instruction.

**Trademark note:** the Anthropic and OpenAI marks identify which provider a
session belongs to — nominative use. If this is ever distributed publicly, check
both companies' brand guidelines; the constraints are mostly about not implying
endorsement and not altering the marks.

## 6. Interaction

What is interactive looks interactive, and says so before it is clicked.

| Element | Resting | Hover | Focus |
|---|---|---|---|
| Session card | border `--line-soft` | lifts 1px, border warms to accent, project name takes accent (critical when blocked) | 2px accent ring, 3px offset |
| Beat card | flat on `--ground` | background to `--raised`, "open full" affordance fades in | 2px accent ring |
| Agent node | coloured dot | radius grows ~3px, readout fills below the dial | same, via keyboard tab |
| Button | filled / ghost / muted | brightness up, ghost gains a fill | 2px accent ring |

**Hover on the graph is a feature, not polish.** Only the live agents carry
labels, because 44 labels is soup. Hovering or tabbing to a node is how the other
42 are read: the readout strip below the dial shows name, model, tool count and
state, coloured to that agent.

Every node also gets an invisible hit area of at least 12px radius. A 4px dot is
not a click target.

All transitions are 130ms and disabled entirely under
`prefers-reduced-motion: reduce`. Restraint is deliberate — scattered animation
is what makes an interface feel generated.

## 7. Accessibility

Every interactive element carries a role, an accessible label and a visible focus
ring. Agent nodes announce as *"task-8-magiclink, sonnet, 162 tool calls, done"*
rather than as an unnamed circle.

State is never carried by hue alone: a blocked card has a badge, a coloured rule
and a state word, so it survives both colour-vision differences and a grayscale
screenshot.
