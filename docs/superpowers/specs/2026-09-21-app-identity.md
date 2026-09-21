# Fleet: what it is, and what its icon should be

Status: drafted 2026-09-21, not approved. Written for the download page, the
README and whoever draws the icon. The prose in §1 is meant to be used as-is.

## 1. What the app is

**Fleet watches the coding agents you already run, and puts them in one
window.** It finds every Claude Code and Codex session on your Mac -- the ones
you started in iTerm, in VS Code, in a plain terminal -- and shows them side by
side: what each one is working on, how much of its context is left, and which
ones have stopped and are waiting on you. When an agent asks a question, you
answer it from Fleet instead of hunting for the terminal window it is buried
in.

It is not another agent, and it does not sit between you and the ones you have.
Your sessions keep running exactly as they were, in the terminals they were
started in; Fleet reads their transcripts and talks to them the same way you
would. Close it and nothing stops. It exists because running five agents at
once means four of them are idle and you do not know which four.

**Requires:** macOS, tmux, and the `claude` or `codex` CLI you already use,
signed in as you already are. Fleet does not bundle them and does not want your
API keys -- it drives the tools on your machine, under your account.

*(Second paragraph is optional for short placements. The first stands alone.)*

## 2. Icon

### 2.1 What it has to do

Read at 16px in a Finder list, and at 1024px on a store page, as the same mark.
That is the whole constraint, and it kills most ideas: anything with more than
one clear shape turns to mud in the Dock.

The app's own visual language already answers what the mark should be made of.
From `src/renderer/theme.css`:

- Ground `#1a1918`, a warm near-black -- not a blue-grey.
- Accent `#d9a95f`, warm amber. This is the app's one colour.
- Critical `#c97a6d`, a muted terracotta, used only for "waiting on you".
- Display face Fraunces; mono face IBM Plex Mono.

**Do not put a letter in it.** "F" in Fraunces is tempting and it is the
weakest option available: it says nothing, and at 16px it is a smudge that
looks like every other lettermark in the Dock.

### 2.2 Three directions worth drawing

Each of these is one shape, which is the point.

1. **The status ring.** The app already marks a working session with a broken
   ring -- a circle with a gap in its stroke (`StatusIcon.tsx`). Blown up to
   icon scale in amber on the warm near-black, that mark is already the app's,
   already means "an agent is working", and survives to 16px because it is one
   stroke. My recommendation.

2. **The fleet.** Several small rounded rectangles in loose formation, one
   amber and the rest dim -- the one that needs you, among the ones that do
   not. Says what the app is for more literally. Risk: several shapes, which is
   exactly what dies at small sizes; it would need to be drawn at 16px first
   and scaled up, not the reverse.

3. **The gap.** Just the arc's gap -- a near-complete ring, heavy stroke,
   single opening. Quieter and more abstract than 1, more distinctive in a row
   of app icons, but it means nothing until you have used the app.

### 2.3 Technical spec

- **Master:** 1024x1024 PNG, sRGB, no alpha on the app shape itself (the
  rounded-rect *is* the icon; transparency only outside it).
- **Shape:** macOS draws app icons as a rounded superellipse, and the artwork
  must be inset inside the canvas rather than filling it -- an icon drawn edge
  to edge looks oversized beside every other app. **Use Apple's official macOS
  app icon template for the inset and corner radius rather than eyeballing
  numbers**; the values differ between macOS generations and are not worth
  guessing.
- **No baked shadow, no bevel.** macOS composites its own.
- **Sizes:** 16, 32, 128, 256, 512, each at 1x and 2x, packed into `.icns`.
  `electron-builder` will generate all of them from a single 1024x1024
  `icon.png` -- put it in `resources/`, which `electron-builder.yml` already
  names as `buildResources`.
- **Draw the 16px by hand.** The automatic downscale of a fine stroke turns to
  grey mush. If the mark has a stroke, that stroke needs thickening at the two
  smallest sizes.
- **One icon, both themes.** macOS does not swap app icons for dark mode, so
  the mark must hold on both a light and a dark Finder background. The warm
  near-black ground carries its own contrast, which is why the mark sits *on*
  it rather than being a bare shape.

### 2.4 Not this

- A terminal prompt glyph (`>_`), a robot, a brain, or a chat bubble. Every
  tool in this category uses one of those.
- A gradient mesh. It dates the app to the year it was drawn.
- The Anthropic or OpenAI marks, or anything resembling them. Fleet is not
  theirs, and borrowing their identity misrepresents who made it -- the same
  reason the provider glyphs inside the app are labelled as trademarks of their
  owners (`NOTICE`).

## 3. Open questions

1. Which direction -- the status ring, the fleet, or the gap?
2. Is "Fleet" the shipping name? `electron-builder.yml` says `productName:
   Fleet`, but the repo, the docs and this conversation all say
   "llm-workspace". Two names is one too many before anyone else sees it.
