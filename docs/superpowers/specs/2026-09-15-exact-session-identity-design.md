# Exact Session Identity (design)

**Date:** 2026-09-15
**Status:** design, for David's review. No implementation plan yet.
**Part of:** a four-part sequence agreed on 2026-09-15:
1. exact session identity (this spec)
2. conversation pane rework
3. launch into iTerm
4. question and trust cards

Each part gets its own spec, plan, and eyes-on check before the next starts.
**Binding spec:** `2026-09-10-llm-workspace-design.md` §7.2 (matching) and §11 (security).

---

## 1. What this delivers

The app stops guessing which conversation a running Claude process belongs to.
It reads the answer from a file Claude Code already writes. What David sees:

- **Reattach works for sessions that share a folder.** Today it refuses with
  "could not identify which session this process belongs to" whenever two live
  sessions share a working directory.
- **The Conversation view shows the right conversation** for those sessions,
  instead of "This working directory has several recorded sessions".
- **After `/clear`, the card and the Conversation view follow the new
  conversation** within one discovery sweep (5 seconds).
- **A card says "waiting on you" when Claude is waiting on David.** Today this
  signal depends on hooks that have not been installed since 2026-09-10.

Codex sessions are unchanged. Codex writes no equivalent file.

## 2. Measured facts this design rests on

All measured on this machine, 2026-09-14 and 2026-09-15, Claude Code 2.1.270 to 2.1.272.

| Fact | Evidence |
|---|---|
| Claude Code writes `~/.claude/sessions/<pid>.json` for each running interactive session. | 13 of 13 live processes had one on 2026-09-14. 4 of 4 had one on 2026-09-15. |
| The file is deleted when the process exits. | The 9 sessions that ended overnight left no file behind. |
| It holds `pid`, `sessionId`, `cwd`, `startedAt` (epoch ms), `procStart`, `status`, `tmux`, `kind`, `version`, `updatedAt`, and more. | Read directly from the files. |
| `sessionId` changes immediately on `/clear` and names the new transcript. | Throwaway session: `3c108cdc…` became `3496403a…`, matching the new `.jsonl`. |
| `startedAt` matches the OS process start time to within 1 second. | 4 live processes: differences of 0 to 1 s against `ps -o lstart`. |
| `status` has been seen as `idle`, `busy` and `waiting`. It was `waiting` while a multiple-choice question was on screen. | Throwaway session. |
| `updatedAt` only moves when something changes, so it can be days old on a healthy idle session. | One idle session's `updatedAt` was 6.7 days old. |
| The file does not exist while the folder-trust prompt is on screen. It appears once trust is accepted. | Throwaway session. |
| Today's matcher is cwd-only plus timing heuristics, and stays ambiguous when two live processes share a cwd. | `src/discovery/match.ts:24`, `src/fleet/state.ts:739-890`. On 2026-09-14, 3 live sessions shared `Chocabloc/server-new`. |

This file is **undocumented Claude Code internals.** An update could rename,
move, or reshape it. The design treats it as an accelerator that can vanish at
any time, never as the only path.

## 3. Design

### 3.1 Reading the file: `src/providers/claude/liveSession.ts` (new)

The module has one job: given a pid, return that session's exact identity or `null`.

```ts
export type LiveSessionStatus = 'idle' | 'busy' | 'waiting';
export type LiveSessionFile = {
  sessionId: string;
  cwd: string;
  startedAtMs: number;
  status: LiveSessionStatus | null; // null when absent or an unrecognised value
};
export function parseLiveSessionFile(text: string, pid: number): LiveSessionFile | null;
export function readLiveSessionFile(pid: number, dir: string): LiveSessionFile | null;
```

`parseLiveSessionFile` is pure. It returns `null` unless all of these hold:

- the text is at most 64 KB and parses as a JSON object;
- `pid` in the file equals the pid being asked about;
- `sessionId` matches the existing `SESSION_ID_SAFE` pattern (`src/main/launch.ts:81`);
- `cwd` is an absolute path string;
- `startedAt` is a finite number.

An unrecognised `status` makes `status` null. It does not reject the file.

`readLiveSessionFile` reads exactly `<dir>/<pid>.json`. It uses `lstat` first
and refuses anything that is not a regular file, including symlinks. A missing
file returns `null` and is normal, for example during the trust prompt.

**Least privilege.** The module never lists the directory, and never opens the
`.key` files next to the JSON files, which look like secrets. It only reads
files for pids that discovery already found running. It writes nothing, which
keeps §11's "read-only on provider data".

The directory path is added to `resolvePaths` in `src/config.ts` as
`claudeLiveSessions` (`~/.claude/sessions`), next to `claudeProjects`.

### 3.2 Discovery: attach it to the process

`LiveProcess` (`src/discovery/parse.ts:5`) gains one optional field:

```ts
liveSession?: { sessionId: string; cwd: string; status: LiveSessionStatus | null } | null;
```

`inspectPid` (`src/discovery/live.ts:140`) reads the file for `provider ===
'claude'` pids only. It keeps the file only if the process's start time agrees:
`|startedAtMs - (now - ageSeconds × 1000)| ≤ 5 s`.

This is the **pid-reuse guard**. If a file were ever left behind and the pid
reused by an unrelated process, the start times would disagree and the file is
ignored. If `ageSeconds` is null, the file is ignored rather than trusted
unchecked. The 5 s tolerance is the same one `START_TOLERANCE_MS` uses at
`src/fleet/state.ts:853`, for the same reason: `etime` is whole seconds.

Cost: one small file read per live Claude pid per 5-second sweep, 4 to 13 files
on this machine. That is negligible next to the `ps` and `lsof` calls the sweep
already makes, so no cache is added.

### 3.3 Matching: exact identity wins, heuristics stay as the fallback

This goes in both open-session builders: `openSessionsLive`
(`src/fleet/state.ts:739`) and `openSessions` (`src/fleet/state.ts:670`,
called from `src/main/ipc.ts:193`). **Before** any cwd or timing rule, a
process with a `liveSession` resolves to:

```
quality: 'unique', sessionId: liveSession.sessionId
```

The existing disambiguation rules then run only for processes without one, with
two adjustments so an exact match also helps its neighbours:

- A session id claimed exactly by one process is removed from every other
  process's `candidates`.
- An exactly-resolved process is not counted in `pidCwdCounts`, so the
  one-live-process-per-cwd fallback (`src/fleet/state.ts:805`) can still resolve
  the remaining process.

Example: two live processes share a cwd, only one has a file. The other's
candidates shrink by one, and it is the only unresolved process at that cwd, so
the existing timing rule can resolve it. If the existing rules still cannot, it
stays `ambiguous`, never guessed.
`classifyMatch` itself stays a pure cwd matcher, per the existing ruling
recorded at `src/fleet/state.ts:748`. The override happens in the builders,
after `classifyMatch`, the same place the launch-time rule already lives.

No new `MatchQuality` value is added. The renderer and Reattach already treat
`'unique'` as "safe for precision actions", which is exactly what an exact
match is. A new value would ripple through every consumer for no user-visible
gain.

If the session id from the file has no rows in the index yet, the process still
resolves to that id. This happens right after launch or `/clear`, before
ingest. Enrichment (last reply, event count) is simply empty until ingest
catches up. The Conversation view then says "No conversation recorded" for a
few seconds. That is true, rather than the misleading ambiguous message.

### 3.4 Status: "waiting on you" from the file

`deriveActivity` (`src/fleet/state.ts:128`) gains an optional `liveStatus` input.

| Hook blocker | `liveStatus` | Activity |
|---|---|---|
| `PermissionRequest` | any | `waiting_permission` (unchanged) |
| other blocker | any | `waiting_input` (unchanged) |
| none | `waiting` | `waiting_input` |
| none | `busy` | `working` |
| none | `idle` | `idle` |
| none | null / no file | today's transcript-based rule, unchanged |

Hooks keep priority where they exist, because they carry the kind of prompt.
`waiting` maps to `waiting_input` rather than `waiting_permission`, because the
file does not say which kind of prompt is open. Verifying what `status` shows
during a permission prompt is an open item (§7).

### 3.5 Reattach: re-read right before acting

`resolveSessionForReattach` (`src/main/ipc.ts:244`) currently reads the
5-second-old enrichment cache. It changes as follows:

1. If the process is Claude, read the live session file **fresh**, with the
   same start-time guard.
2. If a valid file is found, use its `sessionId` and `cwd`. This covers a
   `/clear` that happened after the last sweep and before the click.
3. If not, fall back to the cache exactly as today.

Everything after resolution (kill, then `claude --resume <id>` under tmux) is
unchanged. `SESSION_ID_SAFE` is still checked in `reattachSession` before the
id reaches a command line.

### 3.6 Failure handling

| Situation | Behaviour |
|---|---|
| File missing | Normal. Heuristics as today. |
| File malformed, wrong pid, bad id, symlink, over 64 KB | Ignored. Heuristics as today. Logged once per pid per app run to the main-process console, with the reason and never the file contents, so format drift is visible rather than silent. |
| Start time disagrees (pid reuse) | Ignored and logged once per pid per app run. |
| `~/.claude/sessions` missing entirely (Claude Code changed) | Every Claude pid falls back. One log line per app run, not one per pid per sweep. |
| File read throws for another reason (permissions) | Treated as missing, logged once per pid per app run. The sweep never throws because of this module. |

## 4. Out of scope

- Codex sessions. Nothing equivalent exists, so the heuristics stay.
- Installing the app's hooks. That is part 4, and needs David's approval.
- Using `tmux`, `messagingSocketPath`, `name` or other fields in the file.
- Any renderer change. The existing ambiguous/unknown wording still applies
  whenever the fallback path runs.

## 5. Security notes

- **Trust boundary:** the file is written by any process running as David, so it
  is validated like any other untrusted input (§3.1). Only `sessionId` ever
  reaches a command line, via Reattach, and it is checked against
  `SESSION_ID_SAFE` twice: once at parse and once in `reattachSession`.
- **Exposure:** `cwd` and `sessionId` already cross IPC today. `status` is a
  closed three-value set. No new free-text field reaches the renderer.
- **No new write access.**
- **No reads beyond `<pid>.json`.** The `.key` files are never opened.

## 6. Testing and verification

**Automated (vitest, existing infrastructure):**

- `parseLiveSessionFile`: accepts the real shape, using a fixture copied from a
  real file with the ids replaced. Rejects each of: wrong pid, unsafe session
  id, relative cwd, missing `startedAt`, non-object JSON, over 64 KB. An
  unknown `status` yields `status: null`, not rejection.
- `readLiveSessionFile`, on a temp directory: missing file gives null; a
  symlink gives null; a regular file gives parsed; the directory is never
  listed.
- Discovery: the start-time guard keeps a matching file, drops a mismatched
  one, and drops a file when `ageSeconds` is null.
- `openSessionsLive` and `openSessions`: two live processes sharing a cwd, each
  with a live session file, resolve to two different unique session ids. The
  same setup without files stays `ambiguous`, which is today's behaviour, pinned
  so the fallback cannot regress. A process with a file whose session has no
  index rows still resolves unique. When only one of two same-cwd processes has
  a file, its session id is removed from the other's candidates, and the other
  goes through the existing rules as the sole unresolved process at that cwd.
- `deriveActivity`: every row of the §3.4 table.
- Reattach: a fresh file read wins over a stale cache entry. No file falls back
  to the cache.

**In the real app (a green suite is permission to look, not proof):**

1. Start two Claude sessions in the same folder. Both cards show their own last
   reply, and each Conversation view shows its own conversation.
2. `/clear` in one of them. Within about 5 seconds its Conversation view
   switches to the new, empty conversation.
3. Ask a multiple-choice question in one. Its card shows "waiting on you" while
   the question is open.
4. Reattach one of the two same-folder sessions from plain iTerm. It resumes in
   the app with its own conversation.

## 7. Open items to settle while planning

All three were measured on 2026-09-15 (Claude Code 2.1.272) before planning:

1. **`startedAt` does not change on `/clear`.** A throwaway session kept
   `startedAt: 1789484783913` while `sessionId` went from `ac322d5f…` to
   `9e3c4b49…`. The start-time guard uses `startedAt`, and Reattach's fresh
   re-read compares it to the value discovery verified.
2. **`status` is `waiting` during a permission prompt**, the same as during a
   multiple-choice question. §3.4 stands.
3. **`claude -p` writes the file too**, with `entrypoint: "sdk-cli"`,
   `kind: "interactive"`, and `status: null` at first. Such sessions get exact
   identity; their activity uses the transcript rule until a status appears.
