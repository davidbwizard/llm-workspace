# Phase 6 — Launch and Reply (design)

**Date:** 2026-09-12
**Status:** design, approved in brainstorm; implementation plan not yet written.
**Binding spec:** `2026-09-10-llm-workspace-design.md` §10 and §11.
**Read first:** `2026-09-11-phase-4-inherited-risks.md`.
**Supersedes:** the "no terminal emulator is needed" conclusion in
`2026-09-11-phase-6-handoff.md`. That held only for the reply-box reading of
the feature; David chose a real terminal, deliberately, with the cost stated.

---

## 1. What this delivers

One window. The card grid stays the home screen and is untouched when nothing
is selected. Selecting a session turns the grid into a left rail and gives the
main area to that session, shown either as a **Conversation** (parsed
transcript) or a **Terminal** (raw tmux stream). Any *other* card in the rail
can be answered in place from a small popover, without losing your position in
the session you are working in.

Two capabilities, separable:

1. **Launch** — start a session in a chosen directory, from the app.
2. **Reply** — send keystrokes to a tmux-backed session.

Plus one that fell out of the security review and is more useful than what it
replaced:

3. **Reattach** — relaunch an existing non-tmux session inside tmux with
   `claude --resume <session-id>`, making it fully interactive.

## 2. Decisions taken, do not relitigate

- **One window.** No popup, no modal, no second OS window. The terminal is a
  main-area view like any other. David: "I really wanted a seamless all in
  one."
- **Card grid unchanged when nothing is selected.** Identical to today.
- **Rail defaults to the left**, side is a toggle, can be hidden.
- **Conversation / Terminal toggle is kept.** The raw view is one keystroke
  away rather than always on screen. This is what keeps the noise problem
  solved — the project exists because there was too much terminal.
- **Main area is a pluggable pane.** Fleet and Conversation/Terminal now;
  Graph (Phase 4) and Game (§14) slot in later without rework.
- **Existing styles only.** `theme.css` tokens and the existing
  `.card` / `.crow` / `.prov` classes. No new palette, no new font stack.
- **tmux is the substrate.** Inspectable, recoverable by hand, survives the
  app quitting. Naming: `llmws-<provider>-<short-session-id>`.
- **Nothing spawns on its own.** Launch is explicit: choose provider and
  directory.
- **No keystroke injection into non-tmux terminals.** §11 of the binding spec
  forbids it; this design honours it. See §5.
- **Never send a blind Enter at startup.** Claude Code opens on a trust prompt
  with "No, exit" selected by default; one Enter kills the session. The card
  surfaces it and the user answers.

## 3. Verified ground truth (this machine, 2026-09-11/12)

| Fact | Evidence |
|---|---|
| `tmux send-keys` drives a real Claude session end to end | probe 2026-09-11; reply landed in the ordinary transcript |
| `tmux capture-pane`, 2000 lines | < 10 ms, 132 KB |
| `tmux pipe-pane` throughput ceiling | ~30 MB/s (18.6 MB in 0.59 s) |
| Per-session conversation query | 3 ms on the busiest real session (18,683 events), 217,859-row index |
| No tmux server running | all twelve current sessions are non-tmux |
| Naive AppleScript interpolation executes code | reproduced: `do shell script` payload ran |
| Escaping `\` then `"` neutralises it | reproduced: payload returned as inert text |
| `claude --resume <session-id>` exists | `claude --help` |
| Toolchain | tmux 3.7c; `~/.local/bin/claude`; two codex binaries |

## 4. What is replyable

| Session | Conversation | Terminal | Keystrokes |
|---|---|---|---|
| App-launched (tmux) | yes | yes, live | `tmux send-keys` |
| Started by hand inside tmux | yes | yes, live | `tmux send-keys` |
| Plain iTerm2 / Terminal.app | yes | no | **no** — focus, or Reattach |
| VS Code integrated terminal | yes | no | no |

Row 3 is the common case today. It gets **Conversation view + focus + a
"Reattach in app" action**, never typed input.

## 5. Why there is no AppleScript reply path

The binding spec, §11 (`2026-09-10-llm-workspace-design.md:1172-1176`):

> **No keystroke injection.** AppleScript can type into a matched iTerm2 tab.
> We will not. The most common blocker is a permission prompt; injecting into a
> heuristically-matched tab means that when the match is wrong, the app
> approves an action the user never saw. Focus the window instead.

This was proposed in brainstorm, chosen, then withdrawn once the standing
decision was found. Two verified facts make the original reasoning stronger,
not weaker:

1. **`selectTerminalSession` matches on tty string alone, no pid cross-check**
   (`src/main/ipc.ts:343-385`). ttys are recycled — closing a window and
   opening an unrelated one can reuse `ttysNNN`. Correct for focusing a
   window; a wrong match while *typing* means the reply lands in a `sudo`
   prompt, an ssh session, or an editor.
2. **Naive interpolation into an AppleScript literal is arbitrary code
   execution**, reproduced on this machine. Today's code is safe only because
   `TTY_NAME` (`ipc.ts:324`) cannot contain `"` or `\` — an incidental guard,
   not one designed for free text.

`selectTerminalSession` keeps doing exactly what it does today. It is never
extended to typing.

**Reattach replaces it and gives more.** `claude --resume <session-id>` inside
a new tmux session restores the conversation and yields a real terminal, not a
text box. Cost: the session restarts; history is preserved, in-flight work is
not. Codex resume is **unprobed** — do not assume it matches Claude.

## 6. Architecture

    renderer  ──opaque pid──▶  main  ──argv──▶  tmux  ──▶  claude | codex
       ▲                        │
       └────coalesced bytes─────┘

Main owns everything. The renderer never names a tmux session, a tty, or a
binary — it names a pid, exactly as `session:kill` already does
(`ipc.ts:485-510`), and main re-derives truth itself.

**Session registry.** Main holds an in-memory `pid -> tmux session name` map,
populated at launch time because main is what ran `tmux new-session` and
therefore already knows the name it chose. Names are never regenerated or
guessed from renderer state.

## 7. IPC surface

Seven channels: six request/response, one push. No fire-and-forget — a typed
keystroke must be able to report refusal, so it gets a reply like every other
action.

| Channel | Shape | Purpose |
|---|---|---|
| `session:conversation` | invoke | parsed transcript for one session |
| `session:launch` | invoke | start a session; returns pid |
| `session:reattach` | invoke | close a non-tmux session and relaunch it under tmux with `--resume`, atomically |
| `session:attach` | invoke | begin streaming a session's bytes |
| `session:detach` | invoke | stop streaming |
| `session:keys` | invoke | typed text → keystrokes; returns sent or refused |
| `terminal:data` | push | coalesced bytes, main → renderer |

`session:reattach` is one channel rather than a renderer-orchestrated
kill-then-launch: the renderer must not be able to leave a session killed but
not relaunched, and main is the only side that can hold the two steps together.

Facts that constrain this:

- **The parity test is a regex over `ipcMain.handle('…'` and
  `ipcRenderer.invoke('…'` only** (`tests/main/ipc.test.ts:700-708`). Push and
  fire-and-forget channels are invisible to it; `fleet:update` has no parity
  coverage today. **`terminal:data` needs its own test written, or it ships
  unguarded.**
- **The exhaustiveness gate** (`ipc.ts:98-136`) is hand-written per type over
  object keys. It does not apply to an opaque byte payload. If `terminal:data`
  carries a small struct, copy the recipe; otherwise write a purpose-built
  test asserting the treatment (length cap, encoding).
- **`src/renderer/types.d.ts` is hand-maintained and not covered by the parity
  test.** Every new preload method needs a line there. Existing bug not to
  replicate: it references `RevealResult` without importing it.
- **`fleet:update` is the only push channel that exists** (`ipc.ts:622-627`).
  It sends a full snapshot and throttles at the call sites. Nothing about it
  generalises to an append-only stream — this extends a one-off, not a
  convention.

## 8. Sanitisation — two directions, two rules

These are different problems and must not share a function.

**Inbound (main → renderer, terminal bytes).** `sanitizeForDisplay` **must not
be used**. It strips CSI and OSC sequences (`config.ts:109-115`), which for
prose is correct and for a terminal stream deletes the content itself —
colours, cursor moves, progress bars — leaving the text between them. That
corrupts legitimate output rather than securing it. The emulator interprets
escapes by design; the real surface is the emulator's own (OSC 52 clipboard
write, title set), handled by xterm's own options, not by pre-stripping.

**Outbound (renderer → main → keystrokes).** A genuinely new trust boundary:
nothing today accepts a free-form string from the renderer — every existing
argument is a pid or a clamped offset/limit. Needs its own outbound function:

- strip C0/C1 controls and ESC;
- reject or collapse embedded newlines — a newline submits the current line,
  so multi-line text smuggles extra submissions past what the UI showed as one
  reply;
- length cap;
- never reuse `sanitizeForTerminal`: "safe to display" does not mean "safe to
  type."

## 9. send-keys hardening

Every item below is verified behaviour, not theory.

- **Always pass `-l`** for message text, as its own argv element. Without it
  tmux interprets reserved key *names*: sending the text `C-c` delivered a real
  Ctrl-C rather than three characters. `Enter`, `Escape`, `Tab`, `Up`/`Down`
  and the function keys behave the same way.
- **Enter is a separate call** with a fixed literal string chosen by our code.
  Never concatenate text with a following Enter. The handoff's own probe showed
  a bare Enter selecting "No, exit" and killing a session.
- **Exact targeting**, `-t =<name>`. tmux target syntax does prefix matching
  otherwise, and parses `session:window.pane`.
- **Revalidate before every send**, mirroring `killSession`: fresh
  `tmux has-session -t =<name>`, plus discovery still showing that pid alive
  and bound to that session. A name that merely matches the convention is the
  tmux equivalent of trusting a renderer-supplied pid.
- **Confirm before the first send** to a freshly launched or newly attached
  session.
- **Check what is on screen** via `capture-pane` immediately before sending,
  rather than trusting that the session name still resolves.

`;` inside a single `-l` argument was tested and is typed literally — tmux's
command chaining applies to whole argv elements only, which `execFile` with a
fixed array never permits.

**Threat model.** Transcript and agent output are adversarial by §11.2 of the
binding spec. If quoted transcript text can ever pre-fill the composer, that
text becomes attacker-influenced the moment it is sent as keystrokes. Hence
confirmation, control-char stripping and the newline policy — not because the
user is untrusted, but because what lands in the box may not be theirs.

## 10. Terminal rendering

**No new native module.** All pure browser JS — no dependencies, no install
scripts, no gypfile:

    @xterm/xterm         6.0.0
    @xterm/addon-fit     0.11.0
    @xterm/addon-webgl   0.19.0
    @xterm/addon-canvas  0.7.0    fallback where WebGL is blocklisted

The better-sqlite3 ABI problem (`scripts/check-native-abi.ts`, phase-4 item 6)
does not extend to this phase. **node-pty is not needed** — tmux owns the PTY:

    out    tmux pipe-pane -O -t <pane> <cmd>
    in     tmux send-keys -t =<name> -l "<text>"
    back   tmux capture-pane -p -S <n> -t =<name>
    size   tmux resize-window -t =<name> -x <cols> -y <rows>

**Resize is the piece that is easy to miss.** There is no attached tmux client,
so tmux's "largest attached client" default never learns the size. Without an
explicit `resize-window`, the window stays at its creation size and output
wraps wrongly — which looks exactly like a rendering bug. Pass `-x/-y` at
`new-session` time, and call `resize-window` (debounced) on every FitAddon
`onResize`.

**Vite integration is drop-in.** Renderer-only; `electron.vite.config.ts` needs
no change. Import `@xterm/xterm/css/xterm.css` explicitly — it is not
auto-injected — and never reference these from main or preload, which have no
DOM.

**Drive it imperatively.** `terminal.write(data)` outside React's render cycle.
`FleetView` currently calls `setPayload` per push with no debounce
(`FleetView.tsx:66-67`) — correct at fleet:update's cadence, fatal at a
stream's. Coalesce in main on a ~16 ms tick, cap per-flush size, cap
scrollback.

Memory: ~34 MB is a conservative ceiling (160 cols × 5000 lines, old buffer);
single-digit MB is realistic for a normal pane on the current typed-array
buffer.

WARN: `@xterm/addon-canvas@0.7.0` declares a stale peer dep on
`@xterm/xterm@^5.0.0`. Non-blocking under this repo's npm config; affects only
the fallback addon.

## 11. Conversation view

**No new index.** `events_session_ts(session_id, ts)` (`schema.ts:50`) already
serves it:

    SELECT * FROM events WHERE session_id = ? ORDER BY ts, id

Verified by EXPLAIN QUERY PLAN against the real index —
`SEARCH events USING INDEX events_session_ts` — and timed at 3 ms on the
busiest session. Adding `AND kind IN (...)` does not force a scan because
`session_id` leads the index. The missing `events.kind` index (phase-4 item 8)
costs only cross-session kind queries (320 ms full scan); a single-session
transcript never does one.

**All three pieces are new.** No query, no IPC channel, no component exists.
`FleetView`'s `onOpen` is `() => {}` today (`FleetView.tsx:135`, `:176`), so
the whole "select a session" path is greenfield.

Of 15 declared event kinds only 8 are emitted: `turn.completed`, `prose`,
`tool.used`, `prompt.submitted`, `unparsed`, `session.started`,
`agent.spawned`, `context.compacted`. Build against those, not the enum.

Turn-taking is provider-agnostic and needs no branching: `prompt.submitted` =
user, `prose` = assistant, in both parsers. Note `prose` is assistant-only,
which is why `lastProse` has never shown the user's own words.

Provider branches are needed only for richer detail:

| Field | Claude | Codex |
|---|---|---|
| `turn.completed` | token counts + model | `durationMs`, `turnId` |
| `tool.used` | no `command` | `command` array on shell calls |
| `agent.spawned.parentAgentId` | always null | populated |

**Rendering hazard:** `prompt.submitted` sometimes carries a slash-command
wrapper as literal text — `<command-name>/clear</command-name>` — in 115 Claude
and 83 Codex rows. Rendered verbatim it shows as junk. Both providers do it;
special-case it once.

## 12. Launching and reattaching

Launch is explicit: choose provider and directory. `probeCapabilities`
(`src/config.ts`) already detects tmux and reports it; the launch control
renders from probed capabilities and shows the reason when disabled, so
"install tmux" is a visible explained absence, not a dead button.

**Two Codex binaries exist on this machine.** Per §10.2: probe `PATH`, common
install roots and bundled app resources, record every hit, let the user choose,
remember the choice per provider. Revision 1 of the spec wrongly concluded
Codex was absent by checking one location.

**The trust prompt is the first real use of the reply box.** A launched session
opens on "Is this a project you created or one you trust?" with "No, exit"
selected. The card surfaces it as waiting on a prompt; the user answers. The
launcher never answers it on their behalf.

**Reattach** offers, on a non-tmux card, to relaunch that conversation inside
tmux via `claude --resume <session-id>`.

**Reattach closes the original session as part of the same action**, behind one
confirmation. This is deliberate: `--resume` starts a *new* process reading the
same conversation, so leaving the iTerm process running would put two processes
on one transcript — untested, and likely to interleave writes. One action, one
confirmation, one surviving process. Reuses `session:kill`, which already
revalidates the pid against a fresh sweep (`ipc.ts:485-510`).

The cost is stated plainly in the confirmation: conversation history is
preserved, anything in flight is lost. David accepted this trade explicitly on
2026-09-12.

Codex reattach is gated on probing Codex's own resume support first — unprobed,
and the handoff's warning stands: do not assume it matches Claude.

## 13. Testing

- **Mutation testing before trusting any new test.** Eleven tests shipped on
  Phase 3 unable to fail — satisfied by their own comments, comparing a block
  to itself, defeated by a substring collision. Reading never caught them.
- **Real-machine verification over fixtures.** Every serious defect in three
  phases came from running against real data.
- **One agent on the working tree at a time.** Concurrent mutation testing
  produced phantom failures that nearly sent correct work back for rework.
- **Restart by killing the Electron process, not the dev server.** A stale
  window hot-reloads a new renderer onto an old preload and main, producing
  symptoms indistinguishable from code defects.
- Specific coverage this phase owes: a parity-equivalent test for
  `terminal:data`; an outbound-sanitiser test per rule in §8; a send-keys test
  asserting `-l` is always present and Enter is always a separate call; a
  byte-scan test for the zero-width/bidi characters that four separate parties
  propagated into documents *about* them (phase-4 item 5 — the defence is the
  scan, never care).

## 14. The Game view, and what this phase owes it

Defined by David, 2026-09-12. Not built here — recorded so the pane this phase
creates is the right shape for it.

A session spawns a character: one session, one farmer. The farmer is controlled
in the game. When its session comes back with a question, or finishes, the
farmer signals that the session needs the user. Clicking the farmer shows that
session's prompt.

**It needs no new data and no new IPC.** Every input it wants is already what
the rail consumes:

| Game behaviour | Existing state |
|---|---|
| a farmer exists | one entry in `openSessions` |
| farmer signals "needs you" | `activity` is `waiting_permission` or `waiting_input` — the same `blocked` flag the card computes (`OpenSessionCard.tsx:121`) |
| farmer looks busy | `activity: 'working'` |
| farmer idles | `activity: 'idle'` |
| farmer leaves | pid drops out of `openSessions` |
| click shows the prompt | the same quick-reply popover a rail card opens |

Two constraints this places on Phase 6, both cheap if honoured now and
expensive to retrofit:

1. **The Game view is a peer of the Fleet grid, not a special case.** Both are
   panes rendering the same `openSessions` state with a "select this session"
   callback. If the grid's state handling is written as a private detail of
   `FleetView`, the game pane has to duplicate it.
2. **The quick-reply popover is a standalone component keyed by session id**,
   not something the rail owns. It must be openable from a rail card *or* a
   game character. This is the one piece of Phase 6 UI the game view calls
   directly.

`game-viewer/farm` in this repo is the likely source of the art and the game
loop. Wiring it in is its own phase.

## 15. Out of scope

- Screen-mirroring non-tmux sessions (polling `text of s`). Ruled out on cost
  and on §11.
- Split panes / two terminals at once. The main area can split later; that is
  an addition, not a rewrite.
- A terminal on a second monitor. Follows from the one-window decision.
- The Graph view itself (Phase 4) and whatever "Game" turns out to be. This
  phase only guarantees the pane they will slot into.
