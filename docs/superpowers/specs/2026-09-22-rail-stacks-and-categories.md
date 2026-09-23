# Spec: rail stacks and categories

Date: 2026-09-22. Decided with David in session
`980246b6-896d-459d-b999-8d71d1ae2108`. Mockups:
https://claude.ai/artifact/1HopwDNdD1fRRR7ZKzzra7 (board "A - opens in place"
is the chosen mechanic).

## The problem

Two complaints, one cause.

1. "Having the cards shift is annoying actually." The rail re-sorts on every
   fleet push, so a card moves while you are looking at it, and Cmd+3 means
   something different a minute later.
2. Several sessions in one folder each take their own slot, scattered across
   the rail by activity tier rather than sitting together.

## What is being built

**Two independent layers.** Folder grouping is automatic and derived;
categories are manual and named by David.

### Layer 1 -- folder stacks

Sessions that share a `cwd` collapse into one rail row. Clicking the row
unfolds it in place, pushing the rows below it down; clicking again folds it.
The open/closed state persists.

- A folder with one session is a plain card, exactly as today. A stack is
  only what 2+ sessions in one folder look like.
- A session whose `cwd` is `null` is never grouped.
- Sorting **inside** a stack reuses `compareOpenSessions` unchanged. There is
  no second ordering concept.
- Behind a setting. **Off means no stacks, not a rollback of this spec** --
  co-located sessions render as separate rows again, while categories and
  manual row order go on applying. See the ruling under "What persists".

### Layer 2 -- categories

A name attached to a SESSION. Categories render as section headers in the
rail.

- **One category per session.** Not tags, not many-to-many.
- **A name and nothing else.** No colours, no icons, no hierarchy.
- **Uncategorised is the normal state.** Those rows sit at the bottom with no
  header and no "Other" label -- they look exactly like the rail does today.

**A name and an assignment are separate things** (David, 2026-09-22 --
"categories should be creatable but also editable. Deletable if not attached
to a session"). That rule only holds if a name can exist while attached to
nothing, so they are stored separately and have different lifetimes:

| | Lifetime |
|---|---|
| The category NAME | Persisted. Created, renamed and deleted by David. |
| The ASSIGNMENT, session -> name | Persisted, but pruned on every fleet push against the live session list. |

- A name may be **deleted only while no live session is assigned to it.** The
  UI shows why, rather than hiding the option.
- **Renaming a name rewrites the assignments that point at it**, so a rename
  never silently orphans a session.
- Assignments are keyed by session id and are therefore **temporary by
  design** -- David's explicit call: "It can be temp. If clear or session exit
  its lost." Pruning gives exactly that: a session that exits stops being
  live, and `/clear` mints a new id that was never assigned. Both fall out of
  their category with no bookkeeping.

### The two entry points

A category can be set from **both** surfaces that already exist, which is why
the launch control was built as a dropdown holding options rather than a bare
name field:

1. **The card menu** on a running session.
2. **The launch dropdown** -- the split button shipped in `dd304d5` -- so a
   session is categorised as it starts.

**The launch path is NOT the naming path, and cannot be.** The name is handed
to the CLI at spawn (`claude -n <name>`); it lives in the CLI's own state. A
category is app-side only, and at spawn time there is no session id to key it
to: `launch` returns `{ status: 'launched'; pid }` and nothing more.

The gap is not small. Claude Code writes nothing indexable until the first
prompt, measured on David's own machine at **11 seconds for one session and 11
minutes for another** (2026-09-22 handoff). A session that is launched and
never prompted has no session id at all.

**Ruling: a launch-time category is held against the PID and transferred to
the session id when discovery resolves it.** The pid is safe here, and only
here, for two reasons that do not hold anywhere else in this spec: the app
spawned this exact process and holds its pid directly, and the binding is
discarded the moment it resolves or the app exits. It is a handoff, never
storage -- nothing about it survives a restart, and the pid-recycling problem
in the identity ruling needs hours, not the seconds this lives for.

If the process dies before a session id is ever known, the pending binding is
dropped. Nothing is shown for it and nothing is retried.

**The category field is enabled for Codex, unlike the name field.** The name
is disabled there because Codex has no launch-time name flag; a category never
touches the CLI, so that limitation does not apply to it.

### Where the two layers meet

Folder stacks are keyed by folder; categories are keyed by session. A session
inside a stack can therefore be categorised while its neighbours are not.

**Ruling: categorising pulls a session OUT of its stack.** A folder holding
three sessions, one of them categorised "Review", renders as a Review section
containing that one card, plus a stack of the remaining two. If only one
session is left in the folder, there is no stack at all -- it is a plain card,
per the stacking rule above.

The rejected alternative was showing the whole stack under a category when any
member carries it, which puts one row in two places at once.

## The identity ruling, and why

A row's manual position must attach to something that survives. Verified on
David's machine, 2026-09-22:

| Anchor | What actually happens | Verdict |
|---|---|---|
| pid | macOS assigns pids upward and wraps at 99999. `kern.maxproc` is 8000 but live pids were already at **99129**, so the wrap is ~870 away. A pid is recycled onto an unrelated process within hours. | **No.** It does not vanish, it silently transfers. A feature showing the wrong answer looks like it works. |
| session id | Stable and persisted (`~/.claude/projects/<slug>/<uuid>.jsonl`), but scoped to one sitting. `/clear` mints a new one -- observed directly: `c81e7d19` stopped at 13:15 when David cleared, `980246b6` began. | **No.** David clears several times a day, so membership would be dropped constantly. |
| **folder path** | Stable. Already on every session row as `cwd`. Already the key `favourites.ts` uses. | **Yes.** |

Attaching to the folder also means **stack membership is never stored at
all** -- it is a `groupBy` over a list the app already has, recomputed on
every push. Nothing needs reconciling when a session dies.

**Category assignments are the deliberate exception.** They are keyed by
session id, which the table above rules out for anything meant to last --
David's explicit call, made after reading it: "to session id. It can be temp.
If clear or session exit its lost." So a category assignment is scoped to one
sitting, on purpose, and the pruning rule in Layer 2 is what makes that
automatic rather than a leak. Category NAMES are not affected; they persist.

## What persists

| Thing | Stored? | Keyed by |
|---|---|---|
| Stack membership | No -- derived from `cwd` on every push | -- |
| Stack open/closed | Yes | Folder path |
| Row order | Yes | Row key: a folder path, or `pid:<n>` for a row that is not a folder (a categorised session pulled out of its stack, or a session with no cwd). Keyed by PID, never by session id -- a categorised row's key must not change when a pending launch binding upgrades to a session id, or React remounts the card and it loses its slot. |
| Category NAME | Yes | The name itself |
| Category ASSIGNMENT | Yes, pruned against the live fleet every push | Session id |
| Launch-time pending category | **No** -- in memory, dropped on app exit | Pid, until discovery resolves it |
| Stacking on/off | Yes, in `settings.ts` | -- |

**The setting governs folder stacking ONLY.** Categories and manual row order
apply whether it is on or off -- "not auto movement for the cards" was stated
unconditionally, and a category David set should not disappear because he
turned stacking off. So "off" means no stacks, not a rollback of this whole
spec.

## Ordering

**Rows do not move on their own.** David: "not auto movement for the cards."

Order comes from a persisted list of row keys. A key is appended the first
time the rail sees it and keeps that slot afterwards, so a session starting
to wait changes how its row *looks*, never where it *is*.

This replaces activity-driven position at the row level. `compareOpenSessions`
still runs -- it orders members inside a stack, and it decides where a
brand-new key lands when it is first appended.

### Dragging

David, 2026-09-22: "Add dragging. You can drag whole groups."

**A whole row is the drag unit** -- a stack moves with its members, and a lone
card moves alone. You cannot drag a session out of a stack; folder membership
is derived from `cwd` and is not David's to rearrange. (Pulling a session out
of a stack is what giving it a category does.)

Dropping rewrites the persisted order array and nothing else. That array is
already the single source of row position, so drag adds no second ordering
concept and no new stored state.

Two constraints that are not free:

- **No drag library.** A vertical list of ten rows does not justify a
  dependency. Native HTML5 drag events (`draggable`, `dragstart`, `dragover`,
  `drop`) are enough.
- **Drag alone is unreachable by keyboard**, which nothing else in this rail
  is -- the resize handle already takes arrow keys. Reordering therefore also
  appears as Move up / Move down in the row's own menu, driving the same
  store function the drop does.

## Surfacing, with grouping on

The app exists to show you what is waiting on you, so folding must not hide
that.

- A folded stack's face states its members' status: "1 waiting on you ·
  1 working · 1 idle", and carries the card's existing attention treatment
  when any member is waiting.
- A folded stack with **exactly one** waiting member shows that member's
  Answer button on the face.
- A folded stack with **two or more** waiting members shows no Answer button
  -- which one it would answer is ambiguous. It shows the count; open it.

## Explicitly out of scope

- **Cmd+1-9 is not touched.** `cmdIndexByPid` is computed in `useFleet.ts` and
  shared with FleetView, whose grid does not group. Redefining it from rail
  order would silently change what Cmd+3 opens in both places. Separate
  decision, separate change.
- Dragging a session OUT of its stack (above -- categorise it instead).
- Hiding sessions, category colours, nested categories.
