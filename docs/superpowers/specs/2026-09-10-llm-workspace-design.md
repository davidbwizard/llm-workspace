# LLM Workspace — Design

**Date:** 2026-09-10
**Status:** Approved design, pre-implementation
**Revision:** 3 — second review round applied (see §15)
**Location:** `/Users/davidbrabbins/Documents/David/llm-workspace`

---

## 1. What this is

**A control room for local coding agents, with provider-specific engines
underneath.**

Not a unified terminal. The UI and the normalized event model must not care
whether a session is Claude or Codex, or whether control happens through a PTY or
a native protocol. Providers evolve independently — Claude adds hooks, Codex adds
app-server and multi-agent threads — and the architecture has to absorb that
without a rewrite.

The three features that constitute the product:

1. **Fleet state** — what every session on this machine is doing, right now
2. **Needs You** — which of them is waiting on you, and how to answer it
3. **Cross-provider agent and worktree visibility** — the agent graph, and
   warnings when two providers work the same tree

Everything else, the farm sim included, sits on top of those.

### The problems it solves

1. **Prose gets lost in tool noise.** A measured sample from this project's own
   scrollback: five tool blocks, one sentence of prose, ten lines of pure
   housekeeping (`Shell cwd was reset…`, `Allowed by auto mode classifier`). The
   sentence was the finding.
2. **No view of the agent hierarchy.** `trellome/phase-1-foundation` spawned 44
   subagents; nothing renders that. Codex spawns subagent threads too (§5.5).
3. **Sessions are scattered across hosts.** Six live `claude` processes at time
   of writing — two in iTerm2, one in VS Code — plus Codex Desktop and Claude.app.
   No single view shows all of them.

### Why not just use Claude.app

Claude.app (v1.46388.4, installed) is a **work surface**: you go there to do a
task. This is an **ambient control room**: you glance at it to know the state of
six sessions.

| Capability | Claude.app | This app |
|---|---|---|
| Launch and drive a Claude session | ✅ | ✅ |
| Claude **and** Codex in one view | ❌ | ✅ |
| Sessions started in iTerm2 / VS Code / Codex Desktop | ❌ | ✅ |
| Cross-provider agent graph | ❌ | ✅ |
| Cross-provider worktree contention | ❌ | ✅ |

If a future Claude.app release covers these, this app's value shrinks
accordingly. Accepted risk.

## 2. Non-goals for v1

- Full-text search across history (`claude-sessions-viewer` covers it)
- Deep history browsing and archival
- Remote access **to this app** from another device
- AI summarization of transcripts (§8.3)
- Keystroke injection into terminals this app does not own (§11)
- File-level contention detection and launch-time worktree selection (§9.5 is v1;
  the rest is v2)

---

## 3. Prior art

### munder-difflin — harvest source

`../munder-difflin` (MIT, © 2026 Chaitanya Giri, v0.4.6): 65,495 lines, 224
TypeScript files. **Not forked** — its UI layer is the rejected part, and that is
the layer we replace. Proven leaf modules are copied instead.

Dependency edges verified: every module below imports only node builtins or other
modules in this list.

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

**~2,200 lines — 3.4% of the source codebase.**

`transcript.ts` earns its place on one comment: it documents a silent failure
where Claude Code changed its project-key spelling and the old resolver matched
nothing, costing "months of dead memory condensation."

**Not taken:** `memoryGraph/forceLayout.ts`. The radial layout in §8.2 is
deterministic trigonometry; force simulation makes nodes drift and degrades
clickability.

**License:** MIT requires the copyright notice travel with substantial portions.
Carry a `NOTICE` crediting Chaitanya Giri; keep license headers on harvested files.

### claude-sessions-viewer — reference only

`../claude-sessions-viewer` (own work) indexes `~/.claude/projects` into SQLite
including subagents. Its incremental-index approach informs §6.6; no code copied,
since its schema serves search rather than events.

---

## 4. Architecture: three planes

The central abstraction. Each provider implements the planes it can; the UI sees
only normalized events.

```
┌─ OBSERVATION ─────────────────────────────────────────────┐
│  transcripts · lifecycle hooks · process discovery         │
│  → what is happening                                       │
└────────────────────────────────────────────────────────────┘
┌─ CONTROL ─────────────────────────────────────────────────┐
│  PTY/tmux · provider-native protocols where available      │
│  → make something happen                                   │
└────────────────────────────────────────────────────────────┘
┌─ PRESENTATION ────────────────────────────────────────────┐
│  normalized events · fleet state · UI                      │
│  → provider-agnostic, by construction                      │
└────────────────────────────────────────────────────────────┘
```

### 4.1 Provider adapters

Capabilities exist at **two levels**. Provider-level answers "could this ever
work here"; target-level answers "can I do it to *this* session, right now".
Revision 2 had only the first, which is too coarse: Claude can simultaneously
have one attached session that accepts input, one observed session with an exact
hook mapping, and a third whose terminal match is ambiguous.

```ts
interface ProviderAdapter {
  id: 'claude' | 'codex';

  // Environment-level: probed at startup. "Is tmux present, is the hook
  // helper installed and active, is a native protocol reachable."
  providerCapabilities(): ProviderCapabilities;

  // OBSERVATION
  discoverSessions(): Promise<SessionRef[]>;
  watch(onEvent: (e: NormalizedEvent) => void): Disposable;

  // Per-target: derived per live session/run from how it was discovered,
  // whether hooks mapped it, and whether its process match is unique.
  effectiveCapabilities(target: TargetRef): EffectiveCapabilities;

  // CONTROL — target is a normalized identity, NOT a process handle.
  // The adapter chooses the transport: owned PTY, native protocol, or none.
  sendInput?(target: TargetRef, text: string): Promise<void>;
  answerPermission?(target: TargetRef, d: Decision): Promise<void>;
  interrupt?(target: TargetRef): Promise<void>;
  launch?(opts: LaunchOpts): Promise<TargetRef>;
}

type TargetRef = { sessionId: string; runId?: string };

interface EffectiveCapabilities {
  canSendInput: boolean;
  canAnswerPermission: boolean;
  canInterrupt: boolean;
  canJumpToTerminal: boolean;
  reason?: string;          // why not — shown in the UI, never hidden
}
```

Targeting identity rather than a `RunHandle` matters for the case revision 2
could not express: an **observed** session reachable through a native protocol
has no app-owned process handle, yet is still controllable. Conversely an
attached run whose tmux session vanished has a handle that no longer works.
Capability is a property of the target now, not of how it was created.

The UI renders from `effectiveCapabilities`. A button that cannot work is
disabled **with its `reason` shown** — never silently missing.

### 4.2 Per-provider plan

| | Claude | Codex |
|---|---|---|
| Observation, exact | Lifecycle hooks (§5) | Transcript `session_meta` |
| Observation, narrative | Transcripts | Transcripts |
| Control | PTY → tmux | PTY → tmux |
| Control, native | Remote Control (§10.4, unverified) | app-server (§4.3, unverified) |

### 4.3 Codex native control — deliberately deferred

Codex reportedly exposes a structured app-server interface (`thread/start`,
`thread/read`, thread listing) intended for machine-readable remote management.

**This could not be verified here.** Scanning
`/Applications/ChatGPT.app/Contents/Resources/codex` (`codex-cli 0.152.1`)
produced no matching method strings — the binary may be stripped, or the protocol
may use different literals. The interface is also described upstream as
experimental with moving documentation.

Therefore: **v1 does not depend on it.** It sits behind `CodexAdapter` as an
optional control path, probed at runtime, with PTY + transcripts as the always-
available fallback. If it proves real and stable, it slots in without touching
the UI or the event model.

### 4.4 Module layout

```
Electron main
├── providers/
│   ├── claude/   { discovery, transcript parser, hooks helper, pty control }
│   ├── codex/    { discovery, rollout parser, pty control, app-server (opt) }
│   └── types.ts  ProviderAdapter, Capabilities, NormalizedEvent
├── store/        better-sqlite3 — rebuildable normalized index (§6)
├── fleet/        fold events → session state machine (§9.2)
├── control/      tmux supervision, run registry
└── ipc/          validated surface to renderer (§11.1)

Electron renderer (React 18 + TypeScript)
├── FleetView     session cards (home)
├── SessionView   agent graph + beat feed + composer
├── NeedsYouRail  global, every session, attached included
└── TerminalPane  xterm.js, attached runs only
```

**Stack:** Electron + electron-vite + electron-builder, React 18, TypeScript,
`better-sqlite3`, `node-pty`, `@xterm/xterm`, `chokidar`.

---

## 5. Signal hierarchy

The rule that governs every state decision:

> **Exact signal → hook or native protocol.
> Narrative and history → transcript.
> Heuristic → only when no exact integration is available.**

### 5.1 Claude lifecycle hooks

Verified present in the installed `claude` binary (2.1.267):

```
PermissionRequest   SubagentStart   SubagentStop    CwdChanged
UserPromptSubmit    SessionEnd      StopFailure     MessageDisplay
PreToolUse          PostToolUse     PreCompact      Notification
```

`Notification` distinguishes `permission_prompt`, `idle_prompt`, and
`agent_needs_input` — all three verified in the binary.

Hooks fire across terminal sessions, IDE extensions, and Claude Desktop. This
matters enormously: it means exact signals for **observed** sessions, not just
attached ones.

Hook payloads include `session_id` and the exact `transcript_path`, which solves
the matching ambiguity in §7.2 outright.

### 5.2 Which hooks we install

Sparse lifecycle only:

| Hook | Gives us |
|---|---|
| `SessionStart` | Exact run boundaries with source: `startup` / `resume` / `clear` / `fork` / `compact` (§6.3) |
| `UserPromptSubmit` | Exact beat boundaries (§8.3) — no heuristic needed |
| `PermissionRequest` | Blocked, the instant it happens, with the request text |
| `Notification` | `permission_prompt` / `idle_prompt` / `agent_needs_input` — see §9.3, these do **not** mean the same thing |
| `Stop` | Turn finished. Fires once per turn, so `working` → `idle` is exact |
| `StopFailure` | Turn ended in an API error. **Not** run death (§9.2) |
| `SubagentStart` / `SubagentStop` | Exact graph node lifecycle |
| `SessionEnd` | Run end |
| `CwdChanged` | Keeps worktree contention (§9.5) correct mid-session |
| `PreToolUse`, matcher `AskUserQuestion\|ExitPlanMode` | Exact "answer this question" / "approve this plan" |
| `Elicitation` / `ElicitationResult` | An MCP server is showing a form — definitionally Needs You |

All of the above are verified present in `claude` 2.1.267, along with the
`Notification` subtypes and payload fields `session_id`, `transcript_path`,
`prompt_id`, `hook_event_name`, `permission_mode`, `cwd`.

**On `PreToolUse` cost:** matcher filtering happens *before* the helper is
spawned, so a matcher of `AskUserQuestion|ExitPlanMode` does not run the helper
for every `Bash`, `Edit`, or `Read` call. `"AskUserQuestion"` and
`"ExitPlanMode"` are verified tool names. Without this, the only signal for "the
agent asked you a multiple-choice question" would be transcript inference.

`Elicitation` is lowest priority of the set — it only fires for MCP servers that
elicit — but it is cheap and exactly on-target for the rail.

**`MessageDisplay` is deliberately not used.** It fires during streaming; one
subprocess per token-flush is unacceptable churn, and transcript watching already
renders prose well. Hooks are for status, not narration.

### 5.3 Hooks are opt-in, and installation is transactional

Installing hooks modifies `~/.claude/settings.json` — a file the user already
uses (`Notification` and `PreToolUse` are configured today). This is the app's
only write into provider configuration, so it gets treated like a database
migration, not a file edit.

Presented as **"Enable enhanced Claude integration"** with an explicit diff and
one-click uninstall. Without it, the app runs in **degraded mode** on §9.3
heuristics and says so in the UI rather than being quietly less accurate.

Requirements:

1. **Re-read before write.** On Apply, re-read `settings.json` and confirm it
   still matches the version the displayed diff was computed against. If another
   tool changed it in between, **recompute and re-show the diff** — never
   overwrite the newer file.
2. **Atomic replacement.** Write a temp file in the same directory, `fsync`,
   then rename over the original. Never truncate-and-write in place.
3. **Ownership manifest.** A sidecar records the exact hook fragments this app
   installed. Uninstall removes only structural matches to that manifest.
   Anything the user edited by hand is left alone and reported.
4. **Merge, never replace.** Existing hooks are preserved. The app never removes
   a hook it did not add.
5. **Configured ≠ active.** Managed settings can disable user-level hooks —
   `allowManagedHooksOnly` is present in the binary. After installing, the app
   must verify signals actually arrive before claiming enhanced mode, and fall
   back to degraded mode with an explanation if they do not.

### 5.4 The hook helper

A tiny executable the hooks invoke. It appends a JSON line to a spool directory
the app watches. Constraints, because it runs inside the user's agent sessions:

- Exits in single-digit milliseconds; never blocks the agent
- Writes only; never reads app state, never prompts
- Stamps every invocation with a **unique event id**, so ingestion is idempotent
  (§6.1) and a re-read of the spool cannot duplicate events
- If the app is not running, lines spool to disk and are ingested on next launch
- The spool is **capped and rotated**. Six months with the app closed must not
  turn it into an accidental log archive

**What hooks make exact — and what they do not.**

Exact: **session ↔ transcript**. Payloads carry `session_id` and
`transcript_path`, plus `prompt_id`, which correlates every event belonging to
one user prompt. Capture `prompt_id` everywhere it appears; it is the join key
that makes beats reconstructable without inference.

*Not* exact: **process identity.** Revision 2 claimed the helper could record the
originating TTY and make process ↔ session "unique by construction." Withdrawn —
command hooks on macOS and Linux run in their own session without a controlling
terminal, so the helper cannot simply read its own TTY.

Instead: record cheap ancestry (the helper's parent identity) and resolve it
outside the hook where possible. **When it cannot be proven, the match stays
`ambiguous`** and §7.2's rules apply. Hooks improve process mapping; they do not
guarantee it.

**Transcript lag.** Transcript writes are asynchronous, so a hook can arrive
before the corresponding transcript record exists. Never block on finding it, and
never treat its absence as a parse failure — reconcile later by `prompt_id`.

### 5.5 Codex signals

Codex has no hook system. Its `session_meta` carries structure directly —
verified on disk:

```json
{ "session_id": "01a043c5-…", "id": "01a043c7-…",
  "parent_thread_id": "01a043c5-…",
  "source": { "subagent": { "other": "guardian" } },
  "thread_source": "guardian_review",
  "cwd": "…", "originator": "codex_work_desktop", "cli_version": "0.150.0-alpha.8" }
```

`parent_thread_id` + `source.subagent` give the spawn tree. Codex subagent
threads are separate rollout files linked by parent id, so the graph is built by
walking that tree.

---

## 6. Data model

### 6.1 SQLite is a rebuildable index, not the record

**The provider transcript is the evidence. SQLite is derived and disposable.**

Transcript schemas are undocumented and change without notice — the project-key
incident in §3 is the precedent. If the parser has a bug today and is fixed
tomorrow, a strict append-only store with a positional identity key makes already-
ingested events uncorrectable. So:

- Everything parsed from transcripts is **derived** — droppable and re-derivable
- `Rebuild index` is a supported, tested operation, not an emergency measure
- **Hook events and app-generated events are NOT derived.** They have no other
  source, so they live in a separate durable table that a rebuild never touches

```sql
-- Durable: no other source exists for these.
CREATE TABLE signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,          -- stamped by the hook helper
  received_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT, run_id TEXT, control_handle_id TEXT, agent_id TEXT,
  prompt_id TEXT,                  -- correlates events within one user prompt
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX signal_identity ON signal_events(event_id);

-- Derived: rebuildable from transcripts at any time.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,        -- persistent conversation identity
  run_id TEXT,                     -- one live invocation (§6.3)
  agent_id TEXT,                   -- NULL = root/director
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  native_id TEXT,                  -- provider-native id when present
  source_file TEXT NOT NULL,
  source_offset INTEGER NOT NULL,  -- byte offset, not line number
  content_hash TEXT NOT NULL,      -- hash of the source record
  parser_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_identity ON events(source_file, source_offset, content_hash);

-- Ingestion bookkeeping: detects truncation, replacement, rotation.
CREATE TABLE ingest_files (
  path TEXT PRIMARY KEY,
  inode INTEGER, size INTEGER, mtime TEXT,
  bytes_consumed INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  provider_cli_version TEXT,
  last_ok_at TEXT
);
```

Identity is `(source_file, source_offset, content_hash)` plus `native_id` where a
provider supplies one. Content hash means a rewritten record re-ingests instead
of being silently skipped.

**Reparse is delete-then-parse, not insert.** Revision 2 said a `parser_version`
bump "forces re-ingest," but the unique key does not contain `parser_version` —
so re-parsing an unchanged file produces byte-identical identities and every row
collides with the one already there. The old, wrongly-parsed rows would survive a
parser fix forever.

Reparse is therefore defined explicitly, and runs in one transaction:

```
BEGIN
  DELETE FROM events WHERE source_file = ?;
  -- re-parse the whole file with the current parser
  INSERT ...;
  UPDATE ingest_files SET parser_version = ?, bytes_consumed = ?;
COMMIT
```

Triggered by: a `parser_version` bump affecting that provider, a detected
truncation or inode change (§6.6), or an explicit rebuild. Deleting derived rows
is consistent with §6.1 — `events` is disposable by design, and `signal_events`
is untouched.

### 6.2 Format drift must fail loudly

`ingest_files` records the CLI version that wrote each file. When the parser meets
an unknown record shape:

1. The unknown record is stored raw with `kind = 'unparsed'`
2. Ingestion **does not** silently continue as if nothing were missing
3. The UI shows **"Claude transcript format changed — some events may be
   missing"**, naming the file and the CLI version

Silent partial parsing is the failure mode that cost munder-difflin months. Loud
degradation is the requirement.

### 6.3 Four identities: session, run, control handle, agent

Revision 2 defined a run as "one process lifetime" and hung PID/TTY/tmux off it.
**That is wrong**, and Claude's own lifecycle proves it: `SessionStart` fires with
source `startup`, `resume`, `clear`, `fork`, or `compact` — all five verified in
the binary. A single live CLI process can leave one conversation and enter
another without its PID or TTY changing.

So a process is a **transport**, not an identity. Four things, not three:

| Identity | Is | Lifetime | Carries |
|---|---|---|---|
| **Session** | Provider conversation / thread id | Days. Survives resume, host change, process death | Provider, cwd history, agents |
| **Run** | One live **activation of one session** | Start → that conversation stops being active | session_id, start/end, end reason |
| **Control handle** | One OS-level transport | One process lifetime | PID, TTY, host app, tmux name, exit code |
| **Agent** | Root or subagent within a session | One spawn → stop | name, type, model, color, parent |

The relationship is many-to-many over time: one control handle hosts a sequence
of runs, and one session accumulates runs across many handles.

```
/resume in the same terminal:
  run(session A) ends → run(session B) starts → SAME control handle

app restart, tmux survives:
  control handle re-established → run continues → SAME run, SAME session

/clear:
  run(session A) ends → run(session A') starts → same handle, NEW session
```

This is what makes resume modelable. It also cleans up the adapter: control
operations address a **run or session identity**, and the adapter decides which
transport carries them (§4.1).

### 6.4 Event kinds

| kind | scope | payload | source |
|---|---|---|---|
| `session.started` | session | provider, cwd, model | transcript |
| `run.started` | run | session_id, control_handle_id, source (`startup`/`resume`/`clear`/`fork`/`compact`) | **`SessionStart` hook**, else transcript |
| `run.ended` | run | duration_ms, reason (`completed`/`exited`/`killed`/`superseded_by_resume`) | `SessionEnd` hook / discovery |
| `control.attached` | handle | pid, tty, host_app, tmux_name, attached | discovery / launch |
| `control.detached` | handle | exit_code, reason | discovery / launch |
| `prompt.submitted` | agent | text | **`UserPromptSubmit` hook**, else transcript |
| `turn.completed` | agent | duration_ms, tokens, cost_usd | transcript |
| `agent.spawned` | agent | name, type, model, color, parent_agent_id, depth | `SubagentStart` / `.meta.json` / `parent_thread_id` |
| `agent.ended` | agent | duration_ms, tool_count, files_touched | `SubagentStop` / transcript |
| `prose` | agent | text, role | transcript |
| `tool.used` | agent | name, target, is_error | transcript |
| `cwd.changed` | session | from, to | **`CwdChanged` hook** |
| `state.changed` | run | state, confidence, source | §9.2 |

`prompt.submitted` is new and non-optional: revision 1 had `turn.completed` with
no corresponding start, which made beats underivable without a heuristic.

### 6.5 Claude transcript layout

```
~/.claude/projects/<project-key>/<session-id>.jsonl              ← main
~/.claude/projects/<project-key>/<session-id>/subagents/
    agent-<name>-<hash>.jsonl                                    ← subagent
    agent-<name>-<hash>.meta.json                                ← metadata
```

`project-key` = `cwd.replace(/[^a-zA-Z0-9]/g, '-')`, with the pre-2026 legacy
spelling as fallback. Harvested from `transcript.ts`; do not re-derive.

Fields used: `type`, `message.content` blocks, `timestamp`, `uuid`, `parentUuid`,
`isSidechain`, `agentId`, `sessionId`, `cwd`, `gitBranch`, `version`.
`.meta.json`: `name`, `agentType`, `spawnDepth`, `model`, `color`, `taskKind`,
`teamName`.

Verified: transcripts are appended **live** — a check against this project's own
session showed the last line one second behind wall clock.

### 6.6 Incremental reads

Track `bytes_consumed` per file; read only the tail. `transcript.ts` implements
this (`openSync`/`readSync`/`fstatSync`) — reuse it. Compare inode and size first:
a shrink or inode change means truncation or replacement, and forces a re-read
from zero rather than appending garbage.

**A trailing partial line is normal** — files are read mid-write. Buffer it; never
count it as corrupt.

---

## 7. Session discovery

### 7.1 Two tiers

| | Attached | Observed |
|---|---|---|
| Started by | This app | iTerm2, VS Code, Claude.app, Codex Desktop, cron |
| Graph, beats, alerts | Full | Full — identical |
| Terminal pane | Yes | No |
| Answer in-app | Yes | Only via provider-native path, else jump |
| State accuracy | Exact | Exact **with hooks**; heuristic without |

### 7.2 Process matching is ambiguous — and must be treated as such

Revision 1 claimed `process → tty → cwd → transcript file` "closes the loop." **It
does not.** `cwd` resolves to the project *directory* that holds transcripts, not
to a specific session file. Two sessions in one repo are indistinguishable this
way — and this machine has exactly that: pids 12014 and 38737 both in
`…/Education/Chocabloc`.

`CwdChanged` makes it worse: a session's cwd can move mid-run, so even a
directory match is time-dependent.

**Rules:**

- A process ↔ session match is `unique`, `ambiguous`, or `unknown`
- Actions requiring precision — jump-to-terminal, send input — are enabled **only
  on `unique`**
- On `ambiguous`, the UI offers **"Locate manually"** and lists the candidates. It
  never guesses
- With the hook helper installed, matches come from hook payloads
  (`session_id` + `transcript_path` + recorded PID/TTY) and are `unique` by
  construction

Discovery chain, verified across all six live sessions here:

```
pgrep -x claude              → pid
ps -o tty= -p <pid>          → ttys004
lsof -a -p <pid> -d cwd -Fn  → /Users/…/trip-planner
ps -o ppid= …                → parent chain → host app
```

### 7.3 Terminal host capability tiers

Verified: `osascript -e 'tell application "Terminal" to get tty of every tab of
every window'` returns `/dev/ttys013`. iTerm2 exposes `tty` per session.

| Host | Jump-to-session |
|---|---|
| iTerm2 | Match tty → raise that window/tab |
| Terminal.app | Match tty → raise that window/tab |
| VS Code | **Not possible** for a specific tab. Focus the window, and say so |
| Claude.app / Codex Desktop | Focus the app |

Gated on a `unique` match per §7.2.

---

## 8. Interface

### 8.1 Fleet view — session cards

One card per **session**; a session with 44 agents is still one card.

Shows: provider badge · project and branch · host (`▣ in app` / `⌨ iTerm2` /
`⌨ VS Code` / `⌨ Desktop`) · latest `prose` one-liner · agent pips (`2/8` live) ·
state dot (§9.2) with confidence · blocked badge · **worktree contention warning
(§9.5)**.

### 8.2 Session view — agent graph

Radial. Director at centre, agents on rings.

- **Angle** = spawn order, clockwise from 12 o'clock
- **Radius** = spawn depth — **multiple depths supported from day one**
- **Ring radius grows with sibling count**, so 44 siblings do not overlap
- **Node size** = work done (tool count, scaled)
- **Node colour** = provider metadata (`color` for Claude, role for Codex)
- Running: full opacity + pulse; finished: dimmed and shrunk
- Click a node = filter the beat feed; click centre = all

Revision 1 hardcoded a single ring because one sample had `spawnDepth: 0`. That
is a property of one workflow, not of the format — Claude supports nesting and
Codex threads nest via `parent_thread_id`. Supporting depth now costs little and
avoids a migration.

Pure `Math.cos`/`Math.sin` over `agent.spawned`. No physics simulation.

### 8.3 Session view — beat cards

**A beat is one human turn: from a human-submitted prompt to the next one.**

With hooks, `prompt.submitted` gives exact boundaries. Without them, the fallback
parser must discriminate, because **Claude records tool results as
`type: "user"`**. Measured on this session's transcript:

```
58  user:tool_result   ← NOT human input
11  user:string        ← actual prompts
 3  user:text
 1  user:image,text
```

Revision 1 bounded beats on any `type: "user"` record, which would have produced
~73 beats where there are ~15 human turns. **Fallback rule:** a record starts a
beat only if its content is a string, or an array containing no `tool_result`
block.

Headline selection is **deterministic; no LLM involvement**:

1. Headline = first 1–2 sentences of the **last** assistant text block in the beat
2. Tally = tool counts, files touched, duration
3. Full untruncated text always one click away

Flagged **worth reading** when any of:

- a text block contains a question mark addressed to the user
- any `tool_result` has `is_error`
- text matches: `however`, `note that`, `I assumed`, `blocked`, `can't`, `failed`,
  `warning`, `security`, `no expiry`, `deprecated`

Housekeeping lines are dropped entirely — a measured 10 of ~25 lines in the sample
carried no information.

*Rationale for rules over an LLM:* a generated headline can paraphrase an agent
into saying something it did not, and that failure is invisible to the reader. A
dull-but-true headline is recoverable; a fluent-but-wrong one is not. An opt-in
"smart headlines" toggle may come in v2.

---

## 9. Fleet state and alerts

### 9.1 Needs You rail includes attached sessions

Revision 1 said the rail was global, then excluded attached sessions because they
answer inline. That defeated the point: the rail exists so that *while you are
looking at Codex project A, Claude project B can tell you it needs you.*

**Every blocker appears in the rail.** Only the action differs:

| Situation | Action |
|---|---|
| Attached | Answer / approve inline |
| Observed, native control available | Provider-native action |
| Observed, `unique` match | Jump to terminal (§7.3) |
| Observed, `ambiguous` match | **"Locate manually"** with candidates — never guess |

### 9.2 State: two axes, not one list

Revision 2's flat seven-state list allowed impossible questions — does
`disconnected` overwrite an outstanding `waiting_permission`? Splitting the axes
removes the class of bug entirely.

**Lifecycle** — is this run reachable?

| | Meaning |
|---|---|
| `active` | Alive and observable |
| `disconnected` | Was known, signal lost, state unclear |
| `ended` | Run over, with `reason` (`completed`, `exited`, `killed`, `superseded_by_resume`) |

**Activity** — what is it doing? Meaningful only while `active`.

| | Meaning |
|---|---|
| `working` | Actively producing |
| `waiting_permission` | Wants approval for a specific action |
| `waiting_input` | Asked the user a question |
| `idle` | Turn complete, nothing pending |
| `error` | Last turn ended in an error; **still alive and promptable** |

Each carries `confidence` (`exact` | `likely` | `guess`) and `source` (`hook` |
`native` | `transcript` | `process`). The UI collapses both axes into one status
dot, but never presents a `guess` with the authority of a `hook`.

**`error` is an activity, not a lifecycle state.** Revision 2 had `failed` as
terminal, mapping `StopFailure` to a dead run. Wrong: `StopFailure` means the
*turn* ended in an API error. The session is still sitting there, ready for
another prompt. A dead run is `ended`; a failed turn is `active` + `error`.

Losing a signal never erases a pending blocker: `disconnected` preserves the last
known activity so an outstanding `waiting_permission` stays visible in the rail,
marked stale rather than silently dropped.

### 9.3 Blocked detection

**With hooks (exact).** No inference:

| Signal | Activity |
|---|---|
| `PermissionRequest` | `waiting_permission`, with the actual request text |
| `Notification/permission_prompt` | `waiting_permission` |
| `PreToolUse` matching `AskUserQuestion` | `waiting_input`, with the question |
| `PreToolUse` matching `ExitPlanMode` | `waiting_input` — plan awaiting approval |
| `Elicitation` | `waiting_input` — an MCP form is open |
| `Notification/agent_needs_input` | `waiting_input` |
| `Stop` | `idle` |
| `StopFailure` | `error` — **still active** (§9.2) |
| `Notification/idle_prompt` | **`idle`. Not a blocker.** |

**`idle_prompt` must not enter the rail.** It is timer-driven, not
agent-driven — the binary sends it as `{ message: "Claude is waiting for your
input", notificationType: "idle_prompt" }` gated by `getIdleNotifThresholdMs`.
It fires because *you* haven't typed for a while, not because the agent needs
anything. Revision 2 mapped it to `waiting_input`, which would have made every
finished turn you didn't answer promptly into an alert — precisely the noise this
rail exists to avoid.

**Without hooks (degraded).** All of: process alive, transcript unchanged > 20s,
and the last assistant text block ends in a question mark → `waiting_input`,
confidence `guess`.

Revision 1 also treated *"a `tool_use` with no matching `tool_result` after 20
seconds"* as blocked. **Removed as a primary signal** — a long-running build or
test does exactly this and is not blocked. It survives only as `guess`-confidence
input to `disconnected` after a much longer threshold.

**Asymmetry, deliberately.** A false positive costs one dismissed rail item. A
false negative costs a stalled session — the problem this app exists to solve.
Tune toward over-reporting, but label confidence honestly.

### 9.4 Clearing

An item clears when the transcript advances, a hook reports resolution, the run
ends, or the user dismisses it.

### 9.5 Worktree contention (v1, minimal)

Neither Claude.app nor Codex Desktop can see the other's sessions, so neither can
warn about this. This app can.

v1: resolve each session's cwd to its git worktree root. When two or more **active
runs** share one root, both cards show:

> ⚠ Claude + Codex active in same working tree

Same-provider collisions get the same badge with the providers named. `CwdChanged`
keeps it accurate mid-session.

Deferred to v2: file-level overlap detection, escalating severity, and offering
"same worktree / isolated worktree" at launch.

---

## 10. Launching and run lifetime

### 10.1 tmux underneath

```
app ──attaches to──▶ tmux session ──runs──▶ claude | codex
```

The app is a **viewer** of a run it does not own. Quit or crash the app and the
run continues; reopen and reattach.

A deliberate divergence from munder-difflin, which kills every PTY on quit — its
own comment says terminals must not "linger as orphaned processes writing to a
dead webContents," which is why it needs a quit-warning modal. As more work moves
into this app, that failure mode gets more expensive.

It also gives real remote control: a tmux session can be attached from iTerm2, or
over SSH from another machine.

Retained deliberately over a bespoke supervisor: tmux is inspectable, recoverable
by hand, and vastly simpler than inventing process supervision.

**Prerequisite:** `tmux` is not installed (`brew install tmux`). Detect its
absence and say so plainly; the launch capability is simply absent until then.

Naming: `llmws-<provider>-<short-session-id>`, so runs are identifiable in
`tmux ls` and recoverable manually.

### 10.2 Executable discovery

**Not** hardcoded to `npm i -g @openai/codex`. Codex ships via standalone
installer, npm, and Homebrew; Claude likewise varies.

Probe in order — `PATH`, common install roots, bundled app resources — and record
every hit. Verified on this machine: `codex-cli 0.152.1` exists at
`/Applications/ChatGPT.app/Contents/Resources/codex`, **not** on `PATH`. Revision
1 wrongly concluded Codex was not installed.

When multiple candidates exist, the user picks; the choice is remembered per
provider. Version is captured for §6.2 drift reporting.

### 10.3 Launch buttons

Explicit only — nothing spawns on its own. Choose provider and directory; the run
opens attached. Buttons render from probed capabilities, with the reason shown
when disabled.

### 10.4 Claude Code's own remote features

The app runs the unmodified `claude` binary in a PTY, so CLI-level features behave
as they do in iTerm2. **Open item:** verify against current documentation whether
Remote Control requires anything of the host terminal.

---

## 11. Security

- **No keystroke injection.** AppleScript can type into a matched iTerm2 tab. We
  will not. The most common blocker is a permission prompt; injecting into a
  heuristically-matched tab means that when the match is wrong, the app approves
  an action the user never saw. Focus the window instead.
- **Read-only on provider data.** Never write to `~/.claude` or `~/.codex`, with
  one audited exception: hook installation (§5.3), which is explicit, diffed,
  merge-only, and reversible.
- **No network.** v1 makes no outbound requests. No telemetry, no update pings.
- **No credential handling.** Auth belongs to the CLIs; never read `auth.json` or
  any token.
- **Argument arrays only.** Paths reaching `tmux`, `osascript`, or any spawn are
  passed as argv, never interpolated into a shell string.

### 11.1 Electron boundary

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Preload exposes a **small, explicitly enumerated** IPC surface. Every payload is
  schema-validated in the main process. No generic "invoke arbitrary method"
- Strict CSP; no remote content; `will-navigate` and `setWindowOpenHandler` deny
  everything not local
- Renderer never touches the filesystem or spawns processes

### 11.2 Hostile terminal content

Transcripts and terminal output contain repository content, which may be
adversarial.

- Transcript text renders as **text**, never HTML, never `eval`
- xterm.js: disable or explicitly allowlist link handlers; a printed URL must not
  become a click target that opens arbitrary schemes
- Sanitize clipboard-manipulating and window-title escape sequences; assume a repo
  can deliberately emit them
- Never interpret agent-authored text as a command to this app

---

## 12. Testing

`vitest`, matching `claude-sessions-viewer`.

**Parsers** — fixture-driven from real anonymized transcripts: Claude session with
subagents; Codex rollout with `parent_thread_id`; **tool-result-as-user records
(§8.3 regression)**; truncated final line; corrupt line; unknown record type
(must surface, not vanish); empty file.

**Ingestion** — re-parsing produces no duplicates; a `parser_version` bump
re-ingests; truncation and inode change force a full re-read; **full rebuild
reproduces identical derived state while leaving `signal_events` untouched**.

**Fold** — a known event sequence yields the expected session state, including
resume across runs.

**Headline rules** — table-driven over real beats, every flag keyword.

**Discovery** — `pgrep`/`lsof`/`ps` parsing against captured fixture output;
ambiguous-match detection using the real two-sessions-in-Chocabloc case.

**Graph layout** — pure function; assert coordinates, including multi-depth and
44-sibling spacing.

**State machine** — every transition, with confidence and source propagation.

### 12.1 PTY and tmux are automated, not manual

The most likely source of "my agent disappeared" bugs, and it needs no network
and no real provider. A deterministic **fake CLI** — a script that prints known
output, waits for known input, and exits with a chosen code — runs inside tmux.

Automated coverage: launch · detach · app restart · reattach · resize · input
delivery · clean exit · killed process · stale tmux session recovery · tmux
absent · tmux session vanished mid-run.

Only genuine end-to-end runs against real providers stay manual.

---

## 13. Build order

Phases 1–5 are pure observation and touch nothing running. Phase 6 is the only one
that owns processes, and is last by design.

| Phase | Ends when |
|---|---|
| **1. Read** | Parsers (both providers) + store + fixtures. A CLI prints the normalized event stream for a real session. No UI. |
| **2. Watch + signals** | chokidar, discovery, **hook helper and capability probing**. Live stream, exact signals where available, degraded mode where not. Still no UI. |
| **3. See** | Electron shell + fleet view. Cards for every session, read-only. **First genuinely useful build.** |
| **4. Read closely** | Session view: beat cards + agent graph + node filtering. |
| **5. Alert** | State machine, Needs You rail, capability-tiered actions, worktree contention. |
| **6. Drive** | tmux + PTY + xterm.js. Attached runs, launch buttons, composer. |

Hooks move into Phase 2 rather than arriving with Alerts: they are foundational
signal infrastructure, and retrofitting them under a heuristic built in their
absence means writing that heuristic twice.

---

## 14. v2 — farm sim

Each session is a farmer in a field. Interactions become field actions; a finished
run triggers a harvest whose bounty reflects work done.

```
session.started   → farmer walks into the field
agent.spawned     → a hired hand joins
tool.used         → an action (water, weed, hoe)
turn.completed    → a row finished
waiting_*         → farmer waiting at the fence
run.ended         → harvest; bounty = files changed, tokens, cost
```

Maps directly onto §6.4, which is why that event model is v1 work. The farm is a
third renderer over existing data.

**Design rule, carried from the app that was rejected:**

> The sim is a view, never the only route to information. Every fact the farm
> shows must be reachable in one click from a plain functional view. Charm is a
> layer on top of legibility, never a replacement for it.

munder-difflin's pixel office failed this test — the world *was* the interface, so
finding anything meant navigating a game.

---

## 15. Revision 2 — what changed and why

External review, with claims verified against this machine before acceptance.

| # | Change | Evidence |
|---|---|---|
| 1 | Three planes + provider adapters (§4) | Providers diverge; a terminal-shaped internal model fights that |
| 2 | Hooks as exact signal source (§5) | **Verified**: all named hook events and `Notification` subtypes present in `claude` 2.1.267 |
| 3 | Session / run / agent split (§6.3) | `session.ended` actually meant `run.ended`; resume was unmodelable |
| 4 | Match ambiguity is first-class (§7.2) | **Verified**: pids 12014 and 38737 share `…/Chocabloc` |
| 5 | Beat = human prompt; `prompt.submitted` added (§8.3) | **Verified bug**: 58 of 73 `user` records here are `tool_result` |
| 6 | Codex has subagents; multi-depth graph (§5.5, §8.2) | **Verified**: `parent_thread_id` + `source.subagent` in rollout files |
| 7 | SQLite rebuildable; `signal_events` durable (§6.1–6.2) | Positional identity blocked re-ingest after a parser fix |
| 8 | Rail covers attached sessions; state machine (§9.1–9.2) | Revision 1 contradicted itself |
| 9 | Worktree contention, minimal (§9.5) | Neither first-party app can see across providers |
| 10 | Electron hardening, automated PTY tests, exec discovery (§10.2, §11.1, §12.1) | **Verified**: `codex-cli 0.152.1` installed but off `PATH` |

**Rejected or trimmed:**

- **Codex app-server as a v1 dependency** — could not verify the interface exists
  in the installed binary (§4.3). Kept behind the adapter as an optional path.
- **File-level contention and launch-time worktree choice** — deferred to v2. The
  worktree-root badge is cheap and applies today; the rest is speculative.
- **`MessageDisplay` hooks for prose** — rejected on churn grounds (§5.2).

### Revision 3 — second review round

Two architectural blockers and five corrections. All claims re-verified against
`claude` 2.1.267 before acceptance.

| # | Change | Evidence |
|---|---|---|
| 1 | **Run redefined** as one activation of one session; PID/TTY/tmux moved to a separate **control handle** (§6.3) | **Verified**: `"SessionStart"` with sources `startup`/`resume`/`clear`/`fork`/`compact` — one process spans many sessions |
| 2 | **Per-target effective capabilities**; control targets identity, not a process handle (§4.1) | Provider-level probing cannot express one attached + one hook-mapped + one ambiguous session at once |
| 3 | Hook set expanded: `SessionStart`, `Stop`, `PreToolUse`(`AskUserQuestion\|ExitPlanMode`), `Elicitation`/`ElicitationResult` (§5.2) | **Verified**: all present, as are `"AskUserQuestion"` and `"ExitPlanMode"` |
| 4 | `idle_prompt` → `idle`, not a blocker; `StopFailure` → `error` while still active; state split into two axes (§9.2–9.3) | **Verified**: `sendIdleNotification` is gated by `getIdleNotifThresholdMs` — timer-driven, not agent-driven |
| 5 | Hook helper's TTY claim **withdrawn**; `prompt_id` captured everywhere; transcript lag handled (§5.4) | Command hooks run without a controlling terminal; `"prompt_id"` verified in payload fields |
| 6 | Hook install made transactional: re-read before write, atomic rename, ownership manifest, configured ≠ active (§5.3) | **Verified**: `"allowManagedHooksOnly"` present — managed settings can disable user hooks |
| 7 | Reparse defined as **delete-then-parse**; `signal_events` given a unique `event_id`; spool capped (§5.4, §6.1–6.2) | Logic bug: the unique key omits `parser_version`, so a fixed parser's output collided with the rows it was meant to replace |

**Correction to revision 2's own evidence:** the earlier check reported
`SessionStart` and `Stop` as absent from the binary. That was a bad grep — `-x`
requires a whole line to match, and the binary is a bundled JS blob where
literals sit inside very long minified lines. Both are present.

---

## 16. Prerequisites and open items

| Item | Status |
|---|---|
| `brew install tmux` | Required for Phase 6; not installed |
| Codex executable | **Installed**, off `PATH`, at `/Applications/ChatGPT.app/Contents/Resources/codex` |
| Codex app-server interface | Unverified (§4.3); optional path only |
| Claude Remote Control behaviour | Verify against current docs (§10.4) |
| Hook payload schemas | Confirm exact field names before writing the helper (§5.4) |
| Claude.app feature overlap | Accepted risk (§1) |

---

## 17. Summary of decisions

| Decision | Choice |
|---|---|
| Product framing | Control room with provider-specific engines, not a unified terminal |
| Shell | Native Electron app |
| Foundation | ~2,200 harvested lines from munder-difflin (MIT + NOTICE) |
| Signal hierarchy | Hooks/native → exact · transcripts → history · heuristics → fallback |
| Identities | Session / run / control handle / agent, modelled separately |
| Capabilities | Provider-level **and** per-target effective capabilities |
| State | Two axes: lifecycle (active/disconnected/ended) × activity |
| Store | SQLite as rebuildable index; `signal_events` durable |
| Run ownership | tmux underneath; app attaches |
| Home screen | One card per session |
| Graph | Radial, multi-depth, angle = spawn order, radius grows with siblings |
| Messages | Beat = human turn; deterministic headlines; full text one click away |
| Alerts | Global rail incl. attached; 7-state machine with confidence + source |
| Cross-provider | Worktree contention badge |
| Launching | Probed capabilities; multi-location executable discovery |
| Excluded from v1 | Search, deep history, keystroke injection, AI summarization, file-level contention |
| v2 | Farm sim over the same event log |
