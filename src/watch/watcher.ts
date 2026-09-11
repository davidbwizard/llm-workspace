import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readTail } from '../providers/claude/tail.ts';
import { parseClaudeLines, CLAUDE_PARSER_VERSION } from '../providers/claude/parse.ts';
import { findSubagents, parseAgentMeta, type SubagentRef } from '../providers/claude/subagents.ts';
import { parseCodexLines, CODEX_PARSER_VERSION } from '../providers/codex/parse.ts';
import { insertEvents, getIngestState, recordIngest, reparseFile, resumeContextFor } from '../store/ingest.ts';
import { ensureRun, getRunStart } from '../store/runs.ts';
import type { Db } from '../store/db.ts';
import type { Provider, NormalizedEvent } from '../core/types.ts';

export interface IngestOutcome {
  written: number;
  unparsed: number;
  restarted: boolean;
  events: NormalizedEvent[];
}

function parserFor(provider: Provider) {
  return provider === 'claude'
    ? { parse: parseClaudeLines, version: CLAUDE_PARSER_VERSION }
    : { parse: parseCodexLines, version: CODEX_PARSER_VERSION };
}

/** Given the path of a Claude .jsonl transcript that was just ingested,
 *  return the session directory whose subagents/ folder should be scanned
 *  for agent.spawned events (Task 8's findSubagents/parseAgentMeta) — or
 *  null if `path` is not a Claude transcript at all.
 *
 *  Two shapes lead here:
 *   - the session's own transcript, <project>/<session-id>.jsonl, whose
 *     subagents live at <project>/<session-id>/subagents/;
 *   - a SUBAGENT's own transcript,
 *     <project>/<session-id>/subagents/agent-x.jsonl. Recognising this shape
 *     matters for live watching: a subagent's own file is what chokidar
 *     actually sees changing while that subagent is active, often with no
 *     further write to the parent session file in between. Keying discovery
 *     only off the parent would leave a newly spawned sibling unnoticed
 *     until the next full startup scan; resolving to the *same* subagents/
 *     directory from either path means either file's activity is enough to
 *     (re)discover the whole group. */
function subagentSessionDir(transcriptPath: string): string | null {
  if (!transcriptPath.endsWith('.jsonl')) return null;
  const dir = dirname(transcriptPath);
  if (basename(dir) === 'subagents') return dirname(dir);
  return transcriptPath.slice(0, -'.jsonl'.length);
}

/** Task 8 built findSubagents/parseAgentMeta and nothing called them —
 *  agent.spawned is the only source of the agent graph, so leaving this
 *  unwired would produce a perfectly good event stream with no agents in
 *  it. `.meta.json` files are never themselves watched (chokidar only ever
 *  sees .jsonl transcripts), so this runs as part of ingesting a transcript
 *  rather than depending on a second call a caller could forget.
 *
 *  Each meta file yields one deterministic NormalizedEvent (same sourceFile,
 *  offset 0, subIndex 0, and a contentHash of the re-serialised object), so
 *  running this on every ingest and relying on insertEvents' identity-key
 *  dedup is sufficient for idempotency — no bytes_consumed-style bookkeeping
 *  needed the way tailed files require. */
function subagentEvents(transcriptPath: string): NormalizedEvent[] {
  const sessionDir = subagentSessionDir(transcriptPath);
  if (sessionDir === null) return [];
  const sessionId = basename(sessionDir);

  let refs: SubagentRef[];
  try {
    refs = findSubagents(sessionDir);
  } catch (err) {
    // A single unreadable subagents/ directory must not break ingestion of
    // the transcript that triggered this scan.
    console.error(`[watch] ${sessionDir}/subagents: ${(err as Error).message}`);
    return [];
  }

  const out: NormalizedEvent[] = [];
  for (const ref of refs) {
    try {
      const meta = JSON.parse(readFileSync(ref.metaPath, 'utf8'));
      // The meta file's mtime is the best available proxy for when the
      // subagent spawned: it is written once, at spawn time, and is never
      // rewritten afterward (verified against real transcripts — it lands
      // within the same second as the subagent's own first record).
      const ts = statSync(ref.metaPath).mtime.toISOString();
      out.push(parseAgentMeta(meta, ref.metaPath, sessionId, ref.agentId, ts));
    } catch (err) {
      // A malformed or unreadable meta file must not drop its siblings.
      console.error(`[watch] ${ref.metaPath}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** One incremental pass over a transcript. Spec §6.6.
 *  A parser_version bump or a truncation/replacement forces the full
 *  delete-then-parse path (§6.1) rather than appending to stale rows. */
export function ingestFileOnce(db: Db, path: string, provider: Provider): IngestOutcome {
  const { parse, version } = parserFor(provider);
  const prior = getIngestState(db, path);
  const staleParser = prior !== undefined && prior.parser_version !== version;

  const from = staleParser ? 0 : (prior?.bytes_consumed ?? 0);
  const knownInode = staleParser ? null : (prior?.inode ?? null);
  const tail = readTail(path, from, knownInode);

  // B2/B3: resuming -- a genuinely continued read, picking up past byte 0 --
  // means the parser is about to see a chunk with no session_meta (Codex) or
  // no cwd-bearing first record (Claude), so its session/agent identity must
  // be seeded from what the store already recorded for this file, not
  // re-derived from scratch. `from > 0` (rather than merely `prior !==
  // undefined`) matters: a reparse re-derives the WHOLE file from byte zero,
  // about to delete those same rows, so seeding from them would be both
  // unnecessary and wrong -- staleParser already forces `from` to 0 in that
  // case, and `tail.restarted` catches a truncation/replacement discovered
  // only after the read. A first-ever read of a file is `from === 0` too, so
  // this condition also covers "nothing to resume from yet" without needing
  // to check `prior` separately.
  const resuming = from > 0 && !staleParser && !tail.restarted;
  const resume = resuming ? resumeContextFor(db, path) : undefined;

  const events = parse(tail.lines, path, resume);
  const unparsed = events.filter(e => e.kind === 'unparsed').length;

  // F1: provider_cli_version is only ever present on the session.started
  // record, which (like session identity above) is seen once, at byte 0 --
  // a tail chunk with no session.started must not clobber the value an
  // earlier full parse of this file already recorded.
  const started = events.find(e => e.kind === 'session.started');
  const providerCliVersion = started
    ? ((started.payload as { cliVersion?: string | null }).cliVersion ?? null)
    : (prior?.provider_cli_version ?? null);

  const meta = {
    inode: tail.inode, size: tail.size, mtime: new Date().toISOString(),
    bytesConsumed: tail.newOffset, parserVersion: version, providerCliVersion,
  };

  // Task 8 built findSubagents/parseAgentMeta; every ingest of a Claude
  // transcript re-derives its subagents' agent.spawned events too (there is
  // no other trigger for them -- .meta.json files are never themselves
  // watched). Computed up front so the reparse branch below can fold their
  // re-derivation into the same transaction as the transcript's own (F2).
  const agentEvents = provider === 'claude' ? subagentEvents(path) : [];

  // Every event belongs to a run (spec §6.3). Without SessionStart hooks the
  // run begins at the session's first observed event, so the id is stable
  // across incremental tails.
  const firstTs = events.length > 0 ? events[0]!.ts : null;
  for (const e of events) {
    if (!e.runId && e.sessionId && e.sessionId !== 'unknown') {
      const startedAt = resume?.sessionId === e.sessionId && prior
        ? (getRunStart(db, e.sessionId) ?? firstTs ?? e.ts)
        : (getRunStart(db, e.sessionId) ?? e.ts);
      e.runId = ensureRun(db, e.sessionId, startedAt);
    }
  }

  let written = 0;
  if (tail.restarted || staleParser) {
    // F2: agent.spawned rows carry source_file = <agent>.meta.json, not this
    // transcript's path, so a plain `reparseFile(db, path, ...)` would never
    // reach them -- their identity is byte-stable across a parser_version
    // bump, so the re-insert below is silently skipped as a UNIQUE conflict
    // and the stale row survives forever. Passing their source files through
    // as extraSourceFiles clears and re-derives them in the same transaction
    // as the transcript itself.
    const agentSourceFiles = [...new Set(agentEvents.map(e => e.sourceFile))];
    reparseFile(db, path, () => [...events, ...agentEvents], meta, agentSourceFiles);
    written = events.length + agentEvents.length;
  } else {
    written = insertEvents(db, events);
    recordIngest(db, path, meta);
    if (agentEvents.length > 0) written += insertEvents(db, agentEvents);
  }

  return { written, unparsed, restarted: tail.restarted, events: [...events, ...agentEvents] };
}

export interface WatchRoot { dir: string; provider: Provider; glob: RegExp }

/** Recursive directory walk collecting every path matching `match`.
 *  A missing root (never ingested yet, or a provider simply absent on this
 *  machine) is not an error -- returns whatever was found, empty if nothing
 *  was. Depth-capped defensively; real transcript trees are a handful of
 *  levels deep. */
function walk(dir: string, match: RegExp, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, match, out, depth + 1);
    else if (match.test(p)) out.push(p);
  }
  return out;
}

export interface IngestAllOutcome { files: number; written: number; unparsed: number; skipped: number }

/** The one-shot `ingest` command's corpus walk: every transcript under each
 *  root, ingestFileOnce'd one at a time. Mirrors startWatcher's handle()
 *  below -- a single file that cannot be read at all, or that D1 correctly
 *  refuses to silently drift past (malformed UTF-8), must not abort the
 *  whole run. Without this, `ingest` would die on the first bad file and
 *  never run rotateSpool/ingestSpool for the rest of the corpus, and every
 *  later run would die on that same file again -- permanently broken
 *  ingestion from one bad transcript. `skipped` is counted and each failure
 *  logged so this degrades to visible and recoverable, not silent. */
export function ingestAll(db: Db, roots: WatchRoot[]): IngestAllOutcome {
  let files = 0, written = 0, unparsed = 0, skipped = 0;
  for (const root of roots) {
    for (const f of walk(root.dir, root.glob)) {
      files++;
      try {
        const r = ingestFileOnce(db, f, root.provider);
        written += r.written;
        unparsed += r.unparsed;
      } catch (err) {
        skipped++;
        console.error(`[ingest] ${f}: ${(err as Error).message}`);
      }
    }
  }
  return { files, written, unparsed, skipped };
}

export interface Watcher { close(): Promise<void> }

/** chokidar over the provider transcript roots. Read-only: the watcher never
 *  writes to ~/.claude or ~/.codex (global constraint, spec §11). */
export function startWatcher(
  db: Db,
  roots: WatchRoot[],
  onOutcome: (path: string, provider: Provider, out: IngestOutcome) => void,
): Watcher {
  const watchers: FSWatcher[] = [];

  for (const root of roots) {
    const w = chokidar.watch(root.dir, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: false,   // transcripts are appended live; do not wait
      depth: 4,
    });
    const handle = (path: string) => {
      if (!root.glob.test(path)) return;
      try {
        const out = ingestFileOnce(db, path, root.provider);
        if (out.written > 0 || out.restarted) onOutcome(path, root.provider, out);
      } catch (err) {
        // A single unreadable file must not kill the watcher.
        console.error(`[watch] ${path}: ${(err as Error).message}`);
      }
    };
    w.on('add', handle).on('change', handle);
    watchers.push(w);
  }

  return { async close() { await Promise.all(watchers.map(w => w.close())); } };
}
