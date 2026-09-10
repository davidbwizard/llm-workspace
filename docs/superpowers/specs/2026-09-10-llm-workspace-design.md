# LLM Workspace — Design

**Date:** 2026-09-10
**Status:** Approved design, pre-implementation
**Location:** `/Users/davidbrabbins/Documents/David/llm-workspace`

---

## 1. What this is

A native Mac app that shows every Claude Code and Codex session running on this
machine as one fleet, and lets you run sessions inside it.

It exists because of three specific problems:

1. **Prose gets lost in tool noise.** In a running session the agent's actual
   words are buried between `Bash` calls. A measured sample from this project's
   own scrollback: five tool blocks, one sentence of prose, ten lines of pure
   housekeeping (`Shell cwd was reset…`, `Allowed by auto mode classifier`). The
   sentence was the finding.
2. **No view of the agent hierarchy.** A director agent spawning workers is
   invisible as a structure. One real session in this workspace
   (`trellome/phase-1-foundation`) spawned 44 subagents; nothing renders that.
3. **Sessions are scattered across hosts.** At time of writing there were six
   live `claude` processes on this machine — two in iTerm2, one in VS Code, plus
   Codex Desktop and Claude.app running separately. No single view shows all of
   them.

### Why not just use Claude.app

Claude.app (v1.46388.4, installed) is a **work surface**: you go there to do a
task. This is an **ambient fleet display**: you glance at it to know the state of
six sessions. The features that survive that distinction are the ones this app
is for:

| Capability | Claude.app | This app |
|---|---|---|
| Launch and drive a Claude session | ✅ | ✅ |
| Claude **and** Codex in one view | ❌ | ✅ |
| Sessions started in iTerm2 / VS Code / Codex Desktop | ❌ | ✅ |
| Agent → subagent graph | ❌ | ✅ |
| Ambient, glanceable fleet state | ❌ | ✅ |

If a future Claude.app release covers these, this app's value shrinks
accordingly. That is an accepted risk.

## 2. Non-goals for v1

- Full-text search across history (deferred; `claude-sessions-viewer` covers it)
- Deep history browsing and archival
- Remote access **to this app** from another device
- Any form of AI summarization of transcripts (see §7.3)
- Keystroke injection into terminals this app does not own (see §9)

---

## 3. Prior art

### munder-difflin — harvest source

`../munder-difflin` (MIT, © 2026 Chaitanya Giri, v0.4.6) is an Electron
multi-agent harness: 65,495 lines across 224 TypeScript files. We are **not
forking it** — its UI layer is the part that was rejected as confusing, and that
is the layer we replace. We copy proven leaf modules instead.

Dependency edges were verified before selection; every module below imports only
node builtins or other modules in this list:

| Module | Lines | Why |
|---|---|---|
| `src/main/transcript.ts` | 386 | Claude transcript reading, incl. the project-key format change |
| `src/main/pricing.ts` | 73 | Token → cost estimation |
| `src/main/pty.ts` | 848 | PTY spawn and lifecycle |
| `src/main/procKill.ts` | 108 | Reliable process-tree kill |
| `src/main/fs.ts` | 366 | Path/tilde handling |
| `src/main/ptyEnv.ts` | 90 | PTY environment construction |
| `src/main/shellEnv.ts` | 128 | Login-shell PATH capture |
| `tools/ensure-pty-perms.cjs` | 52 | `node-pty` under Electron build glue |
| `tools/patch-node-pty-conpty.cjs` | 41 | ditto |
| `electron.vite.config.ts`, `electron-builder.yml` | — | Working native build config |

**Total: ~2,200 lines — 3.4% of the source codebase.**

`transcript.ts` is worth the copy for one comment alone: it documents a silent
failure where Claude Code changed its project-key spelling and the old resolver
matched nothing, costing "months of dead memory condensation." We would have hit
the same bug.

**Explicitly not taken:** `memoryGraph/forceLayout.ts`. The radial layout in §7.2
is deterministic trigonometry; force simulation would make nodes drift and
degrade clickability.

**License obligation:** MIT requires the copyright notice travel with substantial
portions. Carry a `NOTICE` file crediting Chaitanya Giri and keep license headers
on harvested files.

### claude-sessions-viewer — reference only

`../claude-sessions-viewer` (own work) already indexes `~/.claude/projects` into
SQLite, including subagent transcripts. Its parser and incremental-index approach
inform §5; no code is copied, since its schema serves search rather than events.

---

## 4. Architecture

```
Electron main process
├── watcher/      chokidar over ~/.claude/projects, ~/.codex/sessions
├── parser/       jsonl → typed events  (claude.ts, codex.ts)
├── store/        better-sqlite3, append-only event log
├── pty/          node-pty → tmux → claude|codex   (attached sessions only)
├── discovery/    pgrep + lsof → live process ↔ tty ↔ cwd
└── ipc/          event stream + commands to renderer

Electron renderer (React 18 + TypeScript)
├── FleetView     session cards (home)
├── SessionView   spider graph + beat feed + composer
├── NeedsYouRail  global, cross-session
└── TerminalPane  xterm.js, attached sessions only
```

**Stack:** Electron + electron-vite + electron-builder, React 18, TypeScript,
`better-sqlite3`, `node-pty`, `@xterm/xterm`, `chokidar`.

### 4.1 Data flow

Everything is one direction: **files → events → store → UI.**

```
transcript .jsonl ──watch──▶ parse ──▶ append event ──▶ SQLite
                                                          │
                                       ┌──────────────────┼──────────────────┐
                                       ▼                  ▼                  ▼
                                  spider graph        beat feed        Needs You rail
```

The PTY is *not* a data source. Attached sessions are read from their transcript
files exactly like observed ones; the PTY only carries bytes to the terminal pane
and keystrokes back. This keeps one parsing path, and means an attached session
that crashes still has complete history.

---

## 5. Data model

### 5.1 Event log is the core

An **append-only** event table. Never updated, never deleted. Current state is
derived by folding events.

This is a v1 decision made for a v2 feature: the farm sim (§11) needs *actions
over time*, and the spider graph needs the same stream. Storing only current
state would force a data-layer rewrite later.

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  agent_id    TEXT,              -- NULL = root/director
  ts          TEXT NOT NULL,     -- ISO8601 from the transcript
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,     -- JSON
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_source ON events(source_file, source_line);
CREATE INDEX events_session_ts ON events(session_id, ts);
```

`(source_file, source_line)` is the idempotency key: re-reading a file can never
double-insert. Required because watchers fire redundantly.

**Event kinds:**

| kind | payload | emitted when |
|---|---|---|
| `session.started` | provider, cwd, git_branch, model, host | first line of a transcript |
| `agent.spawned` | name, agent_type, model, color, spawn_depth | subagent `.meta.json` appears |
| `prose` | text, role | assistant text block / Codex `agent_message` |
| `tool.used` | name, target, is_error | `tool_use` block / `function_call` |
| `turn.completed` | duration_ms, tokens, cost_usd | assistant turn ends |
| `agent.ended` | duration_ms, tool_count, files_touched | subagent transcript goes quiet |
| `session.blocked` | question, reason, confidence | see §8.3 |
| `session.ended` | duration_ms, totals | process gone + transcript quiet |

Derived state (session status, live agent list, graph nodes) is computed in
memory from the fold and cached; it is never the source of truth.

### 5.2 Reading Claude Code transcripts

```
~/.claude/projects/<project-key>/<session-id>.jsonl              ← main
~/.claude/projects/<project-key>/<session-id>/subagents/
    agent-<name>-<hash>.jsonl                                    ← subagent
    agent-<name>-<hash>.meta.json                                ← subagent metadata
```

`project-key` = `cwd.replace(/[^a-zA-Z0-9]/g, '-')`, with the pre-2026 legacy
spelling as fallback. Harvested from `transcript.ts`; do not re-derive.

Per-line fields used: `type` (`user`/`assistant`), `message.content` blocks,
`timestamp`, `uuid`, `parentUuid`, `isSidechain`, `agentId`, `sessionId`, `cwd`,
`gitBranch`, `version`.

`.meta.json` fields used: `name`, `agentType`, `spawnDepth`, `model`, `color`,
`taskKind`, `teamName`.

Verified: transcripts are appended **live**. A check against this project's own
session showed the last written line's timestamp one second behind wall clock.

### 5.3 Reading Codex transcripts

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
```

Each line is `{timestamp, type, payload}` where `type` is `session_meta`,
`event_msg`, or `response_item`.

| Codex | maps to |
|---|---|
| `session_meta` (`session_id`, `cwd`, `originator`, `cli_version`) | `session.started` |
| `event_msg/user_message` | user prompt |
| `event_msg/agent_message` | `prose` |
| `response_item/function_call` | `tool.used` |
| `event_msg/token_count` | token totals |
| `event_msg/task_started` / `task_complete` | `turn.completed` |

Codex separates prose and tool calls explicitly, so the §7.3 filter is exact
rather than heuristic. Codex has no subagent concept — Codex sessions render as a
single-node graph.

### 5.4 Incremental reads

Track byte offset per file; read only the tail on change. `transcript.ts` already
implements this (`openSync`/`readSync`/`fstatSync`) — reuse it. Never re-parse a
whole file on a watch event.

---

## 6. Session discovery and the two tiers

Every session appears. The tier only determines whether you can type into it.

| | Attached | Observed |
|---|---|---|
| Started by | This app | iTerm2, VS Code, Claude.app, Codex Desktop, cron |
| Graph, beats, alerts | Full | Full — identical |
| Terminal pane | Yes | No |
| Answer a prompt in-app | Yes | No — jump to its terminal |
| Status | Exact (tmux + exit code) | Inferred (§6.1) |

### 6.1 Locating observed sessions

Verified working on this machine across all six live sessions:

```
pgrep -x claude              → pid
ps -o tty= -p <pid>          → ttys004
lsof -a -p <pid> -d cwd -Fn  → /Users/…/trip-planner
ps -o ppid= …                → parent chain → host app
```

`cwd` is exactly what Claude Code hashes into the project key, closing the loop
**process → tty → cwd → transcript file**.

Observed status inference: process alive + transcript appended in the last N
seconds = working; process alive + quiet = idle or blocked; process gone =
ended. This is a heuristic and is labelled as inferred in the UI.

### 6.2 Terminal host capability tiers

Verified: `osascript -e 'tell application "Terminal" to get tty of every tab of
every window'` returns `/dev/ttys013`. iTerm2 exposes `tty` per session.

| Host | Jump-to-session |
|---|---|
| iTerm2 | Match tty → raise that window/tab |
| Terminal.app | Match tty → raise that window/tab |
| VS Code | **Not possible** for a specific tab. Focus the window and say so in the UI |
| Claude.app / Codex Desktop | Focus the app |

The UI must state the VS Code limitation rather than offer a button that lands on
the wrong tab.

---

## 7. Interface

### 7.1 Fleet view — session cards (home)

One card per **session**. Beat cards live one level down; a session with 44
agents is still one card here.

Each card shows: provider badge (Claude/Codex) · project name and branch · host
(`▣ in app` / `⌨ iTerm2` / `⌨ VS Code` / `⌨ Desktop`) · current one-line status
from the latest `prose` event · worker pips (`2/8` live) · status dot · a
notification badge when blocked.

Clicking a card opens the session view.

### 7.2 Session view — spider graph

Director at the centre, workers on **one ring**. Depth encoding is unnecessary:
the observed usage pattern is a director orchestrating workers, and the 44-agent
sample confirmed `spawnDepth: 0` for every agent.

- **Angle** = spawn order, clockwise from 12 o'clock
- **Radius** = spawn depth (constant in practice, so one ring)
- **Node size** = work done (tool count, scaled)
- **Node colour** = the `color` field from `.meta.json`
- **Running** = full opacity + pulse ring; **finished** = dimmed and shrunk
- **Click a node** = filter the beat feed to that agent; click the centre = all

Pure `Math.cos`/`Math.sin` over `agent.spawned` events. No physics simulation.

### 7.3 Session view — beat cards

A **beat** is one turn by one agent, defined deterministically as *a contiguous
run of assistant messages in that agent's transcript, bounded by a user message
on either side* (or by the start/end of the transcript). No timing threshold is
involved, so the same transcript always produces the same beats.

Rendered as a card, newest first, all agents interleaved and tagged.

**Headline selection is deterministic. No LLM involvement.** Rules:

1. Headline = first 1–2 sentences of the **last** assistant text block in the
   beat (agents summarize at the end).
2. Tally line = tool counts, files touched, duration.
3. Full untruncated text is always one click away.

A beat is flagged **worth reading** when any of:

- a text block contains a question mark addressed to the user
- any `tool_result` has `is_error`
- the text matches: `however`, `note that`, `I assumed`, `blocked`, `can't`,
  `failed`, `warning`, `security`, `no expiry`, `deprecated`

Housekeeping lines (`Shell cwd was reset…`, permission-classifier notices) are
dropped entirely — they carry no information and were a measured 10 of ~25 lines
in the sample.

Rationale for rules over an LLM: an LLM headline can paraphrase an agent into
saying something it did not, and that failure is undetectable by reading the
headline. A dull-but-true headline is recoverable; a fluent-but-wrong one is not.
A "smart headlines" toggle may be added in v2 behind an explicit opt-in.

### 7.4 Needs You rail

Global, visible from any screen, spanning all sessions and projects. An item
stays until resolved.

Each item shows: the question or permission text · session, host, tty · how long
it has been waiting · an action button per §6.2 capability.

For attached sessions the composer answers inline and no rail entry is needed.

### 7.5 Composer

Attached sessions get a prompt box that writes to the PTY. Observed sessions get
the Needs You strip with a jump button in the same position.

---

## 8. Launching and session lifetime

### 8.1 tmux underneath

```
app ──attaches to──▶ tmux session ──runs──▶ claude | codex
```

The app is a **viewer** of a session it does not own. Quitting or crashing the
app leaves the run going; reopening reattaches.

This is a deliberate divergence from munder-difflin, which kills every PTY on
quit — its own comment says terminals must not "linger as orphaned processes
writing to a dead webContents," which is why it needs a quit-warning modal. As
more work moves into this app, that failure mode becomes more expensive.

It also provides genuine remote control: a tmux session can be attached from
iTerm2, or over SSH from another machine.

**Prerequisite:** `tmux` is not currently installed (`brew install tmux`). The
app must detect its absence and say so plainly rather than failing obscurely.

Naming: `llmws-<provider>-<short-session-id>` so the app's sessions are
identifiable in `tmux ls` and recoverable by hand.

### 8.2 Launch buttons

Explicit only — nothing spawns on its own. Choose provider and directory, session
opens attached.

The Codex button is present but **disabled with an explanatory tooltip** until
`codex` is on `PATH` — it is not currently installed (the existing `~/.codex`
sessions come from Codex Desktop, `originator: "Codex Desktop"`). Codex Desktop
sessions still appear in the observed tier regardless.

### 8.3 Detecting a blocked session

There is no "I am waiting for you" marker in either transcript format, so this is
inferred. Each signal carries a confidence, and the rail shows high-confidence
items first.

**Attached sessions (high confidence).** The app owns the PTY, so it reads the
output tail directly and matches the CLIs' own prompt rendering. This is a real
signal, not a guess, and it is why attached sessions get a better experience.

**Observed sessions (lower confidence).** All of:

1. Process still alive (`pgrep`), and
2. Transcript unchanged for > 20s (tunable), and
3. The last assistant text block either ends in a question mark, or the last
   event is a `tool_use` with no matching `tool_result`.

Condition 3 distinguishes *waiting on you* from *thinking*: an agent mid-work
keeps appending, and a completed turn has matched tool results.

**Failure modes, deliberately asymmetric.** A false positive costs one dismissed
rail item. A false negative costs a session sitting stalled — the exact problem
this app exists to solve. Tune toward over-reporting.

An item clears when the transcript advances, the process exits, or the user
dismisses it.

### 8.4 Claude Code's own remote features

The app runs the unmodified `claude` binary in a PTY, so CLI-level features
behave exactly as they do in iTerm2. **To verify against current documentation
before implementation:** whether Claude Code's Remote Control requires anything
of the host terminal.

---

## 9. Security decisions

- **No keystroke injection.** AppleScript can type into a matched iTerm2 tab. We
  will not. The most common blocker is a permission prompt; injecting into a
  heuristically-matched tab means that when the match is wrong, the app approves
  an action in a session the user never saw. Focus the window instead — one extra
  click, no chance of answering the wrong prompt.
- **Read-only on transcripts.** The app never writes to `~/.claude` or
  `~/.codex`. All app state lives in its own SQLite file.
- **No network.** v1 makes no outbound requests. No telemetry, no update pings.
- **No credential handling.** Auth belongs entirely to the CLIs; the app never
  reads `auth.json` or any token.
- **Shell-out arguments.** Directory paths reaching `tmux`/`osascript` must be
  passed as argument arrays, never interpolated into a shell string.
- **Untrusted transcript content.** Transcript text is data. Render as text, never
  as HTML; never execute or eval it.

---

## 10. Testing

Use `vitest`, matching `claude-sessions-viewer`.

- **Parsers** — fixture-driven, from real anonymized transcripts: a Claude session
  with subagents, a Codex rollout, a truncated final line (live file mid-write), a
  corrupt line, an empty file.
- **Event idempotency** — parsing the same file twice produces no duplicate rows.
- **Fold correctness** — a known event sequence produces the expected session state.
- **Headline rules** — table-driven over real beats, including every flag keyword.
- **Discovery** — `pgrep`/`lsof`/`ps` parsing against captured fixture output.
- **Graph layout** — pure function; assert node coordinates for known inputs.

PTY and tmux integration is manually verified; automated coverage is limited to
the argument construction.

---

## 11. v2 — farm sim

Each session is a farmer in a field. Interactions become field actions; a
finished session triggers a harvest whose bounty reflects the work done.

```
session.started   → farmer walks into the field
agent.spawned     → a hired hand joins
tool.used         → an action (water, weed, hoe)
turn.completed    → a row finished
session.blocked   → farmer waiting at the fence
session.ended     → harvest; bounty = files changed, tokens, cost
```

This maps directly onto the §5.1 event log, which is why that log is v1 work. The
farm is a third renderer over existing data.

**Design rule, carried from the app that was rejected:**

> The sim is a view, never the only route to information. Every fact the farm
> shows must be reachable in one click from a plain functional view. Charm is a
> layer on top of legibility, never a replacement for it.

munder-difflin's pixel office failed this test — the world *was* the interface, so
finding anything meant navigating a game.

---

## 12. Prerequisites and open items

| Item | Status |
|---|---|
| `brew install tmux` | Required, not installed |
| `npm i -g @openai/codex` | Optional; needed only to launch Codex |
| Claude Code Remote Control behaviour | Verify against current docs (§8.4) |
| Claude.app feature overlap | Accepted risk (§1) |

---

## 12.5 Build order

v1 is large enough that it needs a spine. Each phase ends at something runnable,
so the design gets tested against real data early rather than at the end.

| Phase | Ends when |
|---|---|
| **1. Read** | Parsers + event log + fixtures. A CLI command prints the event stream for a real session. No UI. |
| **2. Watch** | chokidar + discovery. The stream updates live, and observed sessions are located via `pgrep`/`lsof`. Still no UI. |
| **3. See** | Electron shell + fleet view. Session cards for all sessions, read-only. **First genuinely useful build.** |
| **4. Read closely** | Session view: beat cards + spider graph + node-click filtering. |
| **5. Alert** | Blocked detection, Needs You rail, capability-tiered jump buttons. |
| **6. Drive** | tmux + PTY + xterm.js. Attached sessions, launch buttons, composer. |

Phases 1–5 are pure observation and carry no risk to running work. Phase 6 is the
only one that owns processes, and it is deliberately last: by then the app is
already useful, so if PTY work proves harder than expected, nothing already built
is wasted.

---

## 13. Summary of decisions

| Decision | Choice |
|---|---|
| Shell | Native Electron app |
| Foundation | ~2,200 harvested lines from munder-difflin (MIT + NOTICE) |
| Session ownership | tmux underneath; app attaches |
| Data core | Append-only SQLite event log |
| Home screen | One card per session |
| Graph | Radial spider, one ring, angle = spawn order, size = work |
| Messages | Beat cards, deterministic headlines, full text one click away |
| Alerts | Global Needs You rail, capability-tiered actions |
| Tiers | Attached (answerable) + observed (read-only + jump) |
| Launching | Explicit buttons; Codex disabled until CLI present |
| Excluded from v1 | Search, deep history, keystroke injection, AI summarization |
| v2 | Farm sim over the same event log |
