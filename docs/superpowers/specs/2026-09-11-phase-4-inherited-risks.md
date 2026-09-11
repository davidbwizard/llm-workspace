# What Phase 4 Inherits

**Date:** 2026-09-11
**Source:** the whole-branch review of `phase-3-fleet`, plus a day of running it
against 878 real sessions
**Status:** open items for Phase 4, not defects in Phase 3

Phase 3 shipped the fleet view. This records what the next phase inherits. It
exists as its own document because the execution workspace that produced it is
git-ignored, and this is the only content in it that cannot be reconstructed from
the code afterwards.

Ordered by how expensive each is to discover *after* Phase 4 exists.

---

## 1. The plan's model was wrong, and only real data showed it

Three groupings shipped in one afternoon, each replaced after David looked at the
running app:

1. **Process liveness** — matched processes to sessions by working directory.
   111 sessions had run in one directory, so a single live process marked all 111
   alive. The "waiting for you" tier held **660 cards**, each printing the same
   process's age and memory.
2. **Transcript recency** — answered "which sessions were recently busy". That is
   not "what is open". A session opened nine days ago and left untouched is still
   open, holds 206 MB, and is the one worth closing.
3. **What shipped** — open sessions enumerate from processes, history from
   transcripts. Spec 7.1a is amended accordingly.

**496 tests had nothing to say about any of it.** Every correction came from
looking at the screen. Phase 4's graph is a display of a model; budget for the
model being wrong and for finding out by looking, not by testing.

## 2. Process liveness cannot identify WHICH session a process belongs to

Verified, not assumed: the process does not hold its transcript open (`lsof` shows
no `.jsonl` — Claude Code appends and closes), and its command line is bare
`claude` or `codex` with no session id. **Working directory is the only link and
it is one-to-many.**

Consequences already paid for, do not re-learn them: a process is a session only
if no other discovered process is its ancestor (Codex spawns `codex sandbox` and
`codex app-server` helpers — one session displayed as four); and transcript
detail may enrich an open card only where the cwd match is `unique`.

## 3. Orphans from the reworks — dead in production, still compiling

The whole-branch review found these and they are not defects, just debris:

- `SessionState.alive`, `processAgeSeconds`, `processRssBytes` — populated, never
  read by anything that renders.
- `SessionCard.showProcessMeta` — always false in production.
- `openSessions()` is only ever called with `[]`.
- `Icon.tsx` and `@phosphor-icons/react` render nowhere. Phase 5's Needs You rail
  was to be the first consumer.

Decide deliberately whether Phase 4 uses them or deletes them. Leaving a populated
field nothing reads is how the next person concludes it must matter.

## 4. Two real gaps the review found and nobody closed

- **`openSessionsLive` can match on a stale cwd** where `fleetState` would not.
- **History pagination can duplicate a card across pages.** A total-order
  tiebreaker was added to the ranking sort; the review believes a path remains.

Both are small and both are real. Neither blocks a merge; both will look like
mysteries if hit during Phase 4's work.

## 5. A literal U+202E lives in the anti-Trojan-Source test

`tests/main/ipc.test.ts` contains the literal character, in the test file for the
sanitiser that exists to strip it — the branch's own rule, broken inside its own
enforcement. Four separate parties propagated these characters into documents
about them today. **The defence is never care; it is the byte scan.**

## 6. `npm run cli -- ingest` can abort natively

Node 24.19.0 shipped a regression (nodejs/node#63642) breaking NAN/ObjectWrap
native addons, better-sqlite3 among them. Our crash signature matches a public
report to the source line. Not fixable in application code; Node <= 24.18.0
avoids it, and **Electron is unaffected** — verified across many launches. The
shipped app is fine; the dev CLI is at risk on a large corpus.

## 7. The provider asymmetry Phase 4's graph will expose

Claude Code records every subagent with an id, name and model — this session
alone spawned 61. Codex records delegation too, but across two files: a
`spawn_agent` function call in the parent rollout, and the child's own
`session_meta` carrying `parent_thread_id`, `agent_nickname` and `thread_source`.
On David's machine that is 3 sessions with 1, 4 and 4 subagents.

So a Claude graph will be rich and a Codex graph sparse. That is what each
provider records, not a bug — but it will look like one.

`sub_agent_activity` and `InterAgentCommunication` appear ZERO times in 346
rollouts (Codex 0.151-0.154). Do not build hooks for them.

## 8. Carried from Phase 3's own reviews

- **`shell.openExternal` has no domain allowlist** beyond an `https://` check.
  Correct while nothing renders links. Phase 4 renders transcript content, and a
  transcript can contain any URL — agent-authored text becomes clickable. Decide
  the policy: allowlist, confirm-before-open, or no links.
- **One-hop subagent directory resolution** (`watcher.ts`, `subagentSessionDir`)
  derives the session id by checking `basename(dirname(path)) === 'subagents'`.
  If Claude Code ever nests subagents-of-subagents, this derives the wrong id.
  **Phase 4's multi-depth graph is exactly what makes it reachable.**
- **`sharesWorktreeWith` reuses the 30-minute recency threshold** as its
  contention predicate, biasing toward false negatives: a session thinking
  quietly for over 30 minutes is not flagged.
- **No index on `events.kind`**, which is why the open-card enrichment query
  scans and therefore runs on a 5-second interval rather than on every push. An
  index would let it move onto the push path. Adding one to a hot-write table is
  its own decision.

## 9. Process notes that paid for themselves

- **Mutation testing is the only thing that reliably caught bad tests.** Eleven
  tests shipped on this branch unable to fail — satisfied by their own comments,
  comparing a block to itself, passing on font fallback stacks, defeated by a
  substring collision, one that could never pass. Reading never caught them.
- **Measure before designing.** Two designs were wrong in ways reasoning missed:
  a pagination rewrite was *slower* than what it replaced until the duplicated
  ranking query was found, and a discovery sweep was 107 subprocess spawns rather
  than the ~27 estimated.
- **One agent on the working tree at a time.** Concurrent mutation testing
  produced phantom failures that nearly sent correct work back for rework.
- **Restart the app by killing the Electron process, not the dev server.** A
  stale window reconnects to the new dev server and hot-reloads the new renderer
  onto an old preload and main — producing symptoms that look exactly like code
  defects and are not.
