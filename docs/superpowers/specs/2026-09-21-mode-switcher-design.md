# Design: switch the agent's permission mode from the conversation

Status: approved shape, not yet built. David picked layout **C** from
https://claude.ai/artifact/PhGP95ikmcor75D6KnZar3 (2026-09-21) and asked that
Codex be specced in the same pass rather than deferred.

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

Cost, accepted: the mode is not visible from the Fleet screen or a session
card, so a session left unrestricted is only obvious once opened. Revisit after
use, not before.

The mockup's CSS is the source for `.modechip` / `.modemenu`; port it rather
than re-deriving it from the picture.

## 3. Both providers

Neither CLI has a "set mode X" command. Both **cycle** on Shift+Tab, so the app
presses and re-reads until the pane reports the requested mode.

### 3.1 Claude Code

Modes as David named them: Manual, Accept edits, Plan, Auto.

**Unverified, and it changes the UI:** whether Auto (bypass permissions) is in
the Shift+Tab cycle at all, or only reachable when the session was started with
`--dangerously-skip-permissions`. Measure against a live pane before building
the menu. If it is not in the cycle, the menu shows three modes and Auto is
disabled with the reason.

### 3.2 Codex

Measured 2026-09-21 against the installed `codex-cli 0.154.0`
(`/opt/homebrew/Caskroom/codex/0.154.0/bin/codex`):

- Its TUI carries the strings `to change mode` and `shift+tab to cycle`, so the
  same cycle-and-read approach applies. Shortcuts are user-remappable there
  (`/keymap`), which the failure path below already covers.
- Preset labels in the binary: **Read Only**, **Auto**, **Full Access**, plus
  **Custom permissions** and "with network access" variants.
- Underneath, Codex has two axes, not one: `--sandbox` (`read-only`,
  `workspace-write`, `danger-full-access`, `external-sandbox`) and
  `--ask-for-approval` (`on-failure`, `on-request`, `never`, `granular`). The
  presets are combinations of the two.

Consequences for the chip:

- Codex gets **three** entries, not four: Read Only, Auto, Full Access. The
  menu is built per provider, never one shared list of four.
- A session in a combination that matches no preset reads **Custom**. The chip
  shows it, the menu marks nothing as current, and switching from it is still
  allowed. The app must never silently relabel a custom state as a preset.
- Still to measure on a live Codex pane: the exact cycle order, whether the
  cycle passes through Custom, and the exact on-screen text the detector keys
  on.

## 4. How the switch runs

1. Refuse outright if the pane is mid-turn or a prompt card is up: Shift+Tab
   into a question does something else entirely. The chip is disabled with a
   reason while the session is working.
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
of a real pane -- one fixture per mode, per provider, Custom included.

Fixtures go in the repo with usernames and project names redacted
(`Bluewizard` -> `ExampleOrg`), as the rest of the fixtures are.

A mode the reader cannot identify is reported as unknown. The chip then shows
nothing rather than a guess: claiming "Manual" on a session that is actually on
Full Access is the worst failure this feature has.

## 6. Verification

- Unit: the reader, one fixture per mode per provider plus an unrecognised
  capture; the press loop hits its cap and fails rather than looping.
- Integration: a real tmux pane per provider -- switch into each mode, confirm
  the pane and the chip agree.
- By eye, in the running app, per "GUI needs eyes, not tests": switch a live
  Claude session and a live Codex session, and confirm the terminal view shows
  the same mode the chip claims.

## 7. Open questions for David

1. Show the mode on session cards and in the Fleet screen too, or only in the
   conversation? (C's accepted cost.)
2. Confirm before switching into Claude's Auto / Codex's Full Access, or switch
   straight away?
3. Should the app remember a preferred mode per folder and offer it at launch,
   or is this strictly a live control?
