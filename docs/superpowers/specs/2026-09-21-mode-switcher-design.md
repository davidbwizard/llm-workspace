# Design: switch the agent's permission mode from the conversation

Status: approved and fully measured, not yet built. Nothing is open. David
picked layout **C** from
https://claude.ai/artifact/PhGP95ikmcor75D6KnZar3 (2026-09-21) and asked that
Codex be specced in the same pass rather than deferred; §3's measurements were
then taken against live panes, and §3.2's first draft turned out to be wrong.

## 1. The problem

The app can read a session, answer its prompt cards and type into it, but the
one thing you always want to change before letting an agent run -- how much it
is allowed to do without asking -- can only be changed in the terminal. Today
that means switching to the Terminal view and pressing Shift+Tab, counting the
presses by eye.

## 2. Layout C: a chip beside the composer hint

The chip sits in `.composer .foot`, to the left of the "Enter to send" hint,
where Claude Code itself prints the mode in the terminal and where the eye
already is when about to send. The pane header is untouched: it already carries
the back button, path, favourite star, context chip and the view toggle, and a
sixth control wraps it at a narrow window.

- Closed: a coloured dot, the mode name, a caret. Same size as `.chip-ctx`.
- Open: a menu of that provider's modes, each with a one-line description and
  the current one marked (`role="menuitemradio"`, `aria-checked`).
- Colour by mode, so the state reads without the word: neutral `--muted` for
  the ask-first mode, `--accent` for edits, `--ag-purple` for plan/read-only,
  `--critical` for the unrestricted one.
- Escape and an outside click close it; focus returns to the chip.

C on its own leaves the mode invisible from the Fleet screen and the session
cards. §7.1 answers that with an optional badge; read it with this section.

The mockup's CSS is the source for `.modechip` / `.modemenu`; port it rather
than re-deriving it from the picture.

## 3. Both providers

Neither CLI has a "set mode X" command; both move on Shift+Tab, so the app
presses and re-reads until the pane reports the requested mode. They do not
move the same way, and the difference is measured, not assumed: **Claude cycles
four states, Codex toggles two.** One press is always enough for Codex; Claude
may need up to three.

### 3.1 Claude Code -- MEASURED 2026-09-21

Against a live throwaway pane, Claude Code v2.1.278, pressing Shift+Tab six
times from a fresh session:

```
auto mode on  ->  manual mode on  ->  accept edits on  ->  plan mode on  ->  auto mode on  -> ...
```

**Auto is in the cycle.** The open question is closed: the menu carries all
four of David's modes and nothing is disabled.

Two things the detector must respect, both measured, not assumed:

- **`manual mode on` prints WITHOUT the `(shift+tab to cycle)` hint** the other
  three carry. Match the mode name; never key on the hint being present.
- The leading glyph splits the states into pairs, not four: `auto` and `accept
  edits` show a double play mark, `manual` and `plan` a pause mark. The glyph
  alone identifies nothing, so it is not the thing to read either.

### 3.2 Codex -- MEASURED 2026-09-21, and this section's first draft was wrong

The earlier draft read Read Only / Auto / Full Access out of the binary's
strings and assumed Shift+Tab cycled them. A live `codex-cli 0.154.0` pane says
otherwise. Six presses produced exactly three round trips of:

```
Default mode  <->  Plan mode
```

**Shift+Tab in Codex is a two-state toggle, not a cycle through the permission
presets.** The presets are real, but they live behind `/permissions` ("choose
what Codex is allowed to do") -- a typed command that opens a menu. `/approvals`
does not exist in this version; the binary carries that string for other
reasons. This is the standing lesson about strings in a binary: they prove a
word exists somewhere, never that it is a command, a label, or reachable.

**Second measured surprise: the toggle also changes the model.** Every switch
into Plan printed `Model changed to gpt-5.6-sol medium for Plan mode`, and
every switch back restored `xhigh`. A Codex mode switch is not only about
permissions -- it silently changes reasoning effort, and so cost and output
quality.

**Decision (David, 2026-09-21): option B.**

- The Codex chip shows **Default** or **Plan** and flips it with one Shift+Tab.
  Same mechanism as Claude, same reliability, same guards.
- The menu carries a **Permissions...** item that does nothing more than open
  the session in the terminal, for the person to run `/permissions` themselves.
  The app does not type that command and does not drive that menu.
- The menu states, in words, that Plan also lowers the model's effort. A person
  who is never told will only notice it in the bill or in weaker output.

Rejected, and why: driving `/permissions` means typing a command and navigating
a menu by screen-scraping. That is the most fragile surface in a feature whose
class of bug has already bitten four times. The escape hatch is honest; a
brittle menu driver pretending to be reliable is not.

Consequence for the UI: the menu is built per provider and the two providers
do not share a list. Claude has four modes; Codex has two plus a link out.

## 4. How the switch runs

1. Refuse outright if a prompt card is up: Shift+Tab into a question does
   something else entirely. The chip is disabled, with that reason on it.

   **Changed 2026-09-22 -- mid-turn no longer refuses, and this replaces the
   original rule ("refuse outright if the pane is mid-turn or a prompt card is
   up"). Do not reinstate it from the old text.** The mid-turn half was an
   assumption written here before it was measured. Measured against a live
   pane: with the session genuinely streaming a reply (`capture-pane` growing
   4047 -> 4508 bytes between reads), Shift+Tab moved the pane from `accept
   edits` to `plan` while the response kept arriving. So the CLI honours
   Shift+Tab mid-turn, the refusal protected nothing, and its only effect was
   to make the chip dead whenever anyone was watching a session work -- which
   is most of the time. The prompt-card half stands: it was not disproved, and
   it is the dangerous case.

   Consequence in the code: `ModeDeps` (`src/main/mode.ts`) carries no `busy`
   dep at all, `session:mode:set` passes it none, and `ModeBlock` has no
   `busy` value. `tests/main/ipc.test.ts` fails if that dep is wired back in.
2. Leave tmux copy-mode first, the same guard `sendKeysFor` already uses --
   a pane in a mode routes keys to that mode's key table.
3. Read the current mode from `capture-pane`.
4. If it already matches, do nothing and say so.
5. Otherwise send one Shift+Tab, re-read, repeat.
6. Cap the presses at one full cycle plus one. On exhaustion, stop, leave the
   session alone and surface a real failure -- never press on in hope.

`sendKeyName` (`src/main/tmux.ts`) must learn `BTab`. That allowlist is a
deliberate boundary: it exists so an IPC caller cannot smuggle arbitrary key
names into `send-keys`. Adding one constant the app itself chooses keeps the
boundary; widening the function to accept caller-supplied names would remove
it. Add `'BTab'` to both `KeyName` and `ALLOWED_KEY_NAMES`, nothing else.

## 5. The detector has to separate the modes

The mode is screen-scraped, so the standing rule applies: a check that matches
on every mode proves nothing. Before this ships, the reader must be shown to
return a *different* answer for each mode of each provider, from real captures
of a real pane -- one fixture per mode per provider: Claude's four, Codex's
two.

Fixtures go in the repo with usernames and project names redacted
(`Bluewizard` -> `ExampleOrg`), as the rest of the fixtures are.

A mode the reader cannot identify is reported as unknown. The chip never names
a mode it has not read: claiming "Manual" on a session that is actually on Auto
is the worst failure this feature has.

**Changed 2026-09-22 -- the chip no longer disappears when there is no mode.**
The original wording was "the chip then shows nothing rather than a guess", and
hiding was how it was built. That made the control absent in the commonest case
of all: a session started in iTerm or VS Code has no tmux pane, so it has no
mode, so there was no chip and nothing to tell anyone why. A control that is
missing teaches nothing. The chip now stays put, disabled, labelled **Mode** --
which names the control without asserting any state -- with the reason in its
title and aria-label: no pane because this app did not start the session, the
session has ended, or the mode could not be read. Only the rule against naming
an unread mode was ever load-bearing, and it is untouched.

The one case that still draws nothing is the pane before its first live push,
where nothing has been established yet.

## 6. Verification

- Unit: the reader, one fixture per mode per provider plus an unrecognised
  capture; the press loop hits its cap and fails rather than looping.
- Integration: a real tmux pane per provider -- switch into each mode, confirm
  the pane and the chip agree.
- By eye, in the running app, per "GUI needs eyes, not tests": switch a live
  Claude session and a live Codex session, and confirm the terminal view shows
  the same mode the chip claims.

## 7. Decisions (David, 2026-09-21)

### 7.1 The card badge is a setting

Show the mode on session cards and in the Fleet screen, behind a setting.

The control follows "Compact cards" exactly -- same four-way segment, same
section of the settings modal: **Off / Sidebar / Fleet / Both**. No new
pattern, and the two settings answer the same question about the same two
surfaces. The chip in the conversation is not affected by it and always shows.

**Default: Off.** Two reasons, both worth re-testing once it is real:

- *It cannot cover every card.* The mode is read from a tmux pane, so it exists
  only for sessions the app launched. Sessions discovered running in iTerm,
  VS Code or a plain terminal have no pane to capture, and their cards can show
  nothing. On by default would look broken on exactly the sessions the fleet
  view exists to surface. A card with no reading shows no badge -- never a
  guess, and never "Manual" as a stand-in for "not known".
- *It costs reads the app does not currently make.* The fleet sweep is built
  from the sqlite index, process enumeration and one `lsof`; it never captures
  a pane. `capture-pane` today runs only on demand (answering a prompt, the
  paste settle).

So the badge does **not** go in the fleet refresh loop. It reads on its own
slower cadence, app-owned sessions only, plus an immediate read after any
switch the app itself makes. A mode changed by typing Shift+Tab directly in the
terminal is therefore stale until the next slow read; that is the accepted
trade for not spawning a `capture-pane` per session several times a second.
Measure the real cost before picking the interval.

### 7.2 No confirmation before the unrestricted mode

Switching into Claude's Auto happens on the click, with no "are you sure".

This now applies to Claude alone. §3.2's measurement means the Codex chip never
switches into Full Access at all -- Shift+Tab there only toggles Default and
Plan, and the permission presets are reached by the person in the terminal, not
by the app.

What carries the weight instead: the chip is `--critical` coloured in Auto, the
menu entry says what it means in plain words, and 7.1's badge makes it visible
from the fleet for app-launched sessions. The switch is also one click to
reverse. If it turns out a session gets left on Auto without anyone noticing,
revisit -- that is the signal, not a hypothetical.

### 7.3 No remembered mode per folder

Strictly a live control. The app does not store a preferred mode per folder and
does not offer one at launch.
