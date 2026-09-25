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
