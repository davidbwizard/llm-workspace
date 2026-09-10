import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { readTail } from '../providers/claude/tail.ts';
import { parseClaudeLines, CLAUDE_PARSER_VERSION } from '../providers/claude/parse.ts';
import { findSubagents, parseAgentMeta, type SubagentRef } from '../providers/claude/subagents.ts';
import { parseCodexLines, CODEX_PARSER_VERSION } from '../providers/codex/parse.ts';
import { insertEvents, getIngestState, recordIngest, reparseFile, resumeContextFor } from '../store/ingest.ts';
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

  // B2/B3: resuming (a prior, non-stale ingest of this exact file exists,
  // and this pass is a plain tail, not a forced from-zero re-read) means the
  // parser is about to see a chunk with no session_meta (Codex) or no
  // cwd-bearing first record (Claude) -- so its session/agent identity must
  // be seeded from what the store already recorded for this file, not
  // re-derived from scratch.
  const resuming = prior !== undefined && !staleParser && !tail.restarted;
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

  let written = 0;
  if (tail.restarted || staleParser) {
    reparseFile(db, path, () => events, meta);
    written = events.length;
  } else {
    written = insertEvents(db, events);
    recordIngest(db, path, meta);
  }

  if (provider === 'claude') {
    const agentEvents = subagentEvents(path);
    if (agentEvents.length > 0) {
      written += insertEvents(db, agentEvents);
      events.push(...agentEvents);
    }
  }

  return { written, unparsed, restarted: tail.restarted, events };
}

export interface WatchRoot { dir: string; provider: Provider; glob: RegExp }

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
