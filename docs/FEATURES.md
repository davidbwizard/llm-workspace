# Features

Wanted but not built. Ideas used to live scattered across dated handoff
docs, which made them hard to find once the handoff scrolled past; this file
is where they go now.

Each entry says what it is, why it is not built yet, and what would have to
be true to start. An entry that is blocked on someone else names the blocker
precisely, so nobody re-researches it.

---

## Manage cloud Claude Code sessions

**Status: blocked upstream. Do not start.**

Fleet watches local CLI sessions. The same rail would be the natural place
to see sessions running in the cloud (claude.ai/code) alongside them --
same question, same answer surface: which of my sessions needs me?

### Why it is blocked

Researched 2026-09-23. Every capability this needs is undocumented or
absent for a third-party local app:

| Needed | Available |
|---|---|
| Enumerate a user's cloud sessions | No endpoint, no CLI listing |
| Per-session status (working / waiting / idle) | Not exposed |
| Read a transcript or stream output | Browser only |
| Answer a permission prompt | No |
| Auth for any of the above | Routine-scoped bearer tokens only |

**The first two are fatal on their own.** This app exists to tell you which
session is waiting. Without a listing and a status, a cloud row could not
say the one thing it would be there to say.

### What does exist

- `claude --cloud [description|session_id|url]` creates a cloud session, or
  ATTACHES to an existing one by session id or claude.ai/code URL. Verified
  against `claude --help` on 2026-09-23. Real, and more than expected --
  but it is a terminal attach, not a queryable interface.
- `claude --bg` / `--background`, `--environment <id>`, `--from-pr` --
  adjacent session-creation flags worth re-reading if this is revisited.
- Routines (scheduled agents) can be fired over HTTP with a per-routine
  bearer token and return a session URL. Triggering only: it cannot list
  sessions and cannot answer a running one.

### The narrow version, and why it was rejected

Fleet could launch cloud sessions itself, keep the ids the way it already
keeps what it launched locally, and offer "open this" plus "send a
message". That works today.

It was rejected deliberately. It inverts the app's premise -- you would only
see sessions Fleet started, and it still could not tell you when any of them
wanted you. That is precisely the complaint the first outside user already
has about LOCAL sessions the app did not launch ("nearly inert", 2026-09-22
handoff). Shipping a whole tier that is inert by design would be building
the known complaint on purpose.

### What would unblock it

A listing with a per-session status. That alone makes this worth building,
and the architecture is already right for it: `useFleet` subscribes to a
`fleet:update` push carrying a list of sessions, so a second discovery
source feeding the same list would reach the rail without the UI knowing
the difference. The identity discipline holds too -- display identity (row
order, categories) is already separate from process identity.

Re-check when Anthropic documents session listing. Do not build against an
undocumented endpoint: it would break on someone else's deploy and the
first person to find out would be an outside user.

---

## Also open, recorded elsewhere

Not repeated in full here -- follow the pointer.

- **The fleet grid does not render stacks.** It now takes the rail's
  ordering so its Cmd+N numbers agree, but every session in a folder still
  gets its own card there. `docs/superpowers/specs/2026-09-23-rail-stacks-followups.md`
- **Hide sessions**, with a show/hide toggle. Note the conflict recorded
  with it: if a hidden session starts waiting and nothing shows it, the app
  has failed at its one job. "Hidden" should mean quiet, not invisible.
  `docs/superpowers/specs/2026-09-22-handoff.md`
- **Sessions the app did not launch are nearly inert** -- no live output, no
  reattach, no prompt answering, no mode chip. The first outside user runs
  Claude inside VS Code's terminal, so this is nearly every session he has,
  and he meets it as four separate "can't do that" messages instead of one
  statement up front. `docs/superpowers/specs/2026-09-22-handoff.md`
- **Open sessions in iTerm via `tmux -CC`**, falling back to Terminal.app
  when iTerm is absent. `docs/superpowers/specs/2026-09-22-handoff.md`
- **Mode switcher in the Conversation view.**
  `docs/superpowers/specs/2026-09-21-mode-switcher-design.md`

## Decisions waiting on David

- **`order` grows without a cap** in the groups store -- a key per folder
  ever seen, never dropped. Capping it would silently discard manual row
  positions, which is a user-visible trade.
  `docs/superpowers/specs/2026-09-23-rail-stacks-followups.md`
- **Signing and notarisation.** The app is unsigned and arm64-only, so every
  recipient meets "Fleet is damaged" and needs `xattr -dr
  com.apple.quarantine`. $99/year plus notarisation turns that into a
  double-click; a universal build is a config change at roughly double the
  download. `docs/superpowers/specs/2026-09-22-handoff.md`

## Previously opened md files in viewr
- Store up to 5 for quick view. Yes i know they might not exsist. Make sure its the full path

## Add app notifications
- Add for finished prompts, and question prompts. 

---

## Preferences in a small database, not localStorage

**Status: not started. Cause measured 2026-09-25, nothing built.**

Favourites, settings, session groups, rail width and the first-run flag all
live in the renderer's `localStorage`. That storage is keyed by the window's
ORIGIN, and this app has more than one.

### What goes wrong

The dev app loads `ELECTRON_RENDERER_URL` (`http://localhost:5173`); the
packaged app loads `file://`. Different origins, so they keep entirely
separate copies -- favourites added in one never appear in the other.

Worse, the dev origin is not stable. Vite's port is unpinned outside
`FLEET_PILOT_PORT`, so a stale dev server sends the next launch to 5174,
5175, and so on. Each new port is a new origin with empty storage: the app
comes up with no favourites, default settings and a reset rail width, and
nothing says why. Nothing is lost -- it is reading a different drawer.

Measured, from `~/Library/Application Support/llm-workspace/Local
Storage/leveldb`: four origins already hold this app's keys.

    _file://                  the packaged app
    _http://localhost:5173    dev
    _http://localhost:5175
    _http://localhost:5176

The theme does not suffer from this, because it is the one preference kept
outside the renderer -- `~/.llm-workspace/appearance.json`, read by main at
startup. That file is the shape of the answer.

### What to build

A small store of its own under `~/.llm-workspace/`, read and written by
main, exposed to the renderer over IPC. Five stores move onto it:
`settings.ts`, `favourites.ts`, `groups.ts`, `firstRun.ts` and the rail
width in `SessionRail.tsx` -- 17 call sites, all of them the `read()` and
`write()` ends only. Each store's own validation stays exactly as it is.

**Its own database, NOT `index.sqlite`.** `favourites.ts` records the
standing ruling: these are "a per-viewer UI convenience, never fleet state
-- nothing here belongs in the store/db". A separate file keeps that true
while still being a database, and keeps a 600 MB transcript index from
carrying the rail width.

### What has to be solved first

- **A synchronous first read.** Today `read()` is synchronous, so React has
  every value at first paint. Behind async IPC the defaults render first and
  the real values snap in after -- visible as the rail jumping and compact
  cards flipping on every launch. Main must read the store before the window
  loads and hand it over synchronously; that mechanism is the part to
  prototype before committing to the work.
- **Migration, done carefully.** On first run of the new build, copy what is
  already in `localStorage` across. Getting this wrong wipes favourites
  rather than merely failing, so it needs its own test.
- Four test files (`settings`, `favourites`, `groups`, `SettingsModal`) mock
  `localStorage` and would move with it.

### Cheaper partial fix, if this is not started

Pin the dev port (`port: 5173, strictPort: true`). It does not merge dev and
packaged, but it stops the silent drift to 5175/5176. The trade is that a
busy port then fails the dev server loudly instead of blanking preferences
quietly.

## Private mobile access

Opt-in Tailscale Serve access lets a phone or tablet view Fleet sessions, reply, answer prompts, take terminal control, and start sessions in known projects. Desktop settings include a locally generated QR code and separately configured private development-preview links. See [remote access setup](remote-access.md) for configuration, device restrictions, and the pending real-device acceptance checklist.

---

## Permission heatmap, and the allowlist it suggests

**Status: not started. The data it needs was verified present 2026-10-04.**

Fleet sees every permission request before anything else does, and already
keeps them: `signal_events` holds 1,237 `PermissionRequest` rows spanning
2026-09-18 to 2026-10-04, each carrying its `tool_name` and the whole
`tool_input` payload. Nothing ever reads them back. The app that is
interrupted by these prompts is the one place that can say which of them
were not worth asking.

Measured on that table, this machine, those 16 days: 963 of the 1,237 were
Bash. By first word -- `tmux` 281, `git` 157, `cd` 125, `node` 100, `ps` 44.
Four hundred-odd of those are read-only commands answered by hand.

### What to build

A view that groups the stored requests by tool and by command, over a
window, and offers to turn a row into a permission rule. The claude-code
plugin skill `fewer-permission-prompts` already does a weaker version of
this offline, by scraping transcripts; Fleet holds the same facts first
hand, with session and timestamp attached.

### What has to be solved first

- **A command's first word is not a permission rule.** Claude Code matches
  patterns like `Bash(git status:*)`. Grouping by head is the right way to
  LOOK at the data and the wrong way to suggest a rule: `git push --force`
  must never inherit what `git status` was granted. The safe suggestion is
  narrower than the interesting grouping, and the gap between them is the
  design.
- **Which settings file.** Project `.claude/settings.json` or user
  `~/.claude/settings.json`. Writing to the wrong one either leaks a
  project rule to every project or hides it from the one that needed it.
- **Suggest, never apply.** Writing an allowlist entry removes a security
  control. It needs an explicit yes each time, and it must show the exact
  rule text before it writes anything.

---

## Reap idle tmux sessions

**Status: not started. The cost has been measured twice.**

Sessions accumulate and nothing removes them. Ten are live right now, the
oldest created 2026-09-17 and untouched for seventeen days. An earlier
accumulation reached sixteen sessions over fourteen days holding roughly
5 GB; before that a fifo leak left 538 orphaned processes and 3.5 GB. Both
were found by hand with `ps`, after the machine was already hurting.

Fleet knows every session's age and last activity. It is the only thing
positioned to notice.

### What to build

A list of stale sessions with age and last activity, and a reap that takes
them away. Nothing automatic.

### What has to be solved first

- **Idle is not dead.** A session blocked on a prompt produces no output
  for hours and must never be reaped -- that is the exact session the app
  exists to protect. Age alone is the wrong signal; it needs last activity
  AND "not currently waiting on you".
- **Reaping destroys work.** Killing a tmux session with a live agent in it
  loses whatever that agent had not written down. Confirmation every time,
  no default-on sweep, and the confirmation should say what is running.
- **Orphans outlive their session.** The two Codex relay processes left
  behind on 2026-10-01 survived the app that spawned them and appeared in
  no session listing at all. A reaper that only knows tmux will not see
  them.
