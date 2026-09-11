# Risks Phase 3 Inherits From the Data Layer

**Date:** 2026-09-10
**Source:** final whole-branch review of `phase-1-2-data-layer`
**Status:** open items for Plan 2, not defects in Phase 1/2

Phase 1/2 shipped the data layer. This records what a UI built on it inherits.
It exists as its own document because the execution workspace that produced it
is deleted at merge, and this is the only content in that workspace which cannot
be reconstructed from the code afterwards.

Ordered by how expensive each is to discover *after* a UI exists.

---

## 1. `run_id` is declared and never populated — fix before anything renders state

`run_id` is `null` in every write path: `claude/parse.ts:73`, `codex/parse.ts:64`,
`subagents.ts:56`, `spool.ts:61`. `control_handle_id` exists only as a column on
`signal_events`.

Spec section 9.2's lifecycle axis is **per run**, not per session. A fleet card
built per-session works today and then needs retrofitting per-run once the state
machine arrives — and by then the assumption is baked into components, props and
IPC shapes, not just one query.

**Do first in Plan 2:** fold run boundaries from `SessionStart` / `SessionEnd`
into the event stream, so `run.started` and `run.ended` carry real ids before any
component renders state. Section 6.3 already defines the four identities; three
of them are currently real and one is a column.

## 2. Cross-invocation parser state is a class of bug, not two instances

The final review's blocking findings B2 and B3 were the same defect wearing two
faces: parsers are pure per invocation, while the watcher tails from a byte
offset, so every chunk after the first starts mid-file. Codex lost the session id
entirely; Claude re-emitted `session.started` on every chunk.

Both were invisible to the full-corpus run, which reads from offset zero. The
one-shot path worked; the live-watch path did not.

**Do in Plan 2:** any new per-file parser state — run boundaries, compaction
handling, beat grouping — builds on the resume context introduced by that fix
rather than reinventing it. **Its tests must append to a file and re-ingest**,
never parse a whole file in one call. A test that parses whole files cannot see
this class of bug.

## 3. Spec 7.1a is honoured only by a comment

`sessions` correctly enumerates index-first, but the rule lives as a comment at
`src/config.ts:124-130`. Nothing fails if a later phase enumerates from `pgrep`
again.

That finding cost more to discover than any other in this plan: 144 sessions were
active while `pgrep` saw 8, and a fleet view built the wrong way would have shown
8 of 144 while appearing to work perfectly.

**Do in Plan 2:** a test asserting a session with zero live processes still lists
with quality `unknown`. A comment will not hold this.

## 4. `signal_events` has no reader anywhere in `src/`

The hook helper, the spool ingester, the installer and the table all exist.
Nothing consumes them. The path is unexercised end to end.

That is also **why blocking finding B1 survived** — the capability probe tested a
marker the installer had stopped writing, and no downstream code existed that
would have noticed the probe returning false.

**Do in Plan 2:** wire one reader before adding more writers.

## 5. Performance the CLI's shape hides

- `sessionRefs` runs two full scans of `events` per call (`src/config.ts:156-171`)
  — 238,768 rows on the development machine today.
- `subagentEvents` re-stats and re-parses every meta file on every Claude
  transcript ingest (`src/watch/watcher.ts:124`). A 44-subagent session performs
  45 passes over 44 files per sweep.

Both are fine for a one-shot CLI invoked by hand. Both are fatal in a render loop
polling for live updates.

**Do in Plan 2:** add the index and the cache before the first UI polls them, not
after it feels slow.

## 6. A display heuristic lives in the data layer

`SESSION_RECENCY_WINDOW_MS` (30 minutes) is baked into `sessionRefs` with no
unwindowed alternative beside it. A fleet view wanting every session, or a
different window, must bypass the function rather than parameterise it.

## 7. Carried forward from task reviews

- **One-hop subagent directory resolution** (`watcher.ts`, `subagentSessionDir`)
  derives the session id by checking `basename(dirname(path)) === 'subagents'`.
  If Claude Code ever nests subagents-of-subagents, this derives the session id
  from an intermediate agent id. **Must close before the multi-depth graph of
  section 8.2 ships in Phase 4** — that graph is exactly what makes it reachable.
- **`TailLine` is imported from `claude/tail.ts` into `codex/parse.ts`**, coupling
  the Codex parser to the Claude module. Type-only, zero runtime risk. Move it to
  `core/` in Plan 2's first task, before a third provider copies the coupling.
- **`npm audit`**: `--omit=dev` reports 0 vulnerabilities. The vitest/vite/esbuild
  chain is dev-only and nothing ships from it. Schedule the bump; it is not a
  merge gate.
