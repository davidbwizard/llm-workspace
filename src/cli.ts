#!/usr/bin/env node
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from './store/db.ts';
import { ingestFileOnce, startWatcher } from './watch/watcher.ts';
import { ingestSpool, rotateSpool } from './hooks/spool.ts';
import { readCodexThreads, readSpawnEdges, lastStateDbError } from './providers/codex/stateDb.ts';
import { parsePgrep, parseTty, parseLsofCwd, classifyHost, type LiveProcess } from './discovery/parse.ts';
import { classifyMatch, type SessionRef } from './discovery/match.ts';
import { resolvePaths, probeCapabilities, formatEventLine } from './config.ts';
import type { Provider } from './core/types.ts';
import type { Db } from './store/db.ts';

const paths = resolvePaths(homedir());
const cmd = process.argv[2] ?? 'help';

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

function open() {
  mkdirSync(join(homedir(), '.llm-workspace'), { recursive: true });
  return openDb(paths.db);
}

// --- sessions: discovery/match wiring (Task 11) -----------------------
//
// Everything here shells out to pgrep/ps/lsof. Every argument reaches
// execFileSync as its own argv entry, never interpolated into a shell
// string — cwds and process names are untrusted input.

function safeExec(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Walk the parent chain via `ps -o ppid=,comm=`, one hop per call, so
 *  classifyHost gets `[self, parent, grandparent, ...]` (spec §7.3 expects
 *  chain[0] to be the process being classified, not an ancestor).
 *
 *  `comm=` on macOS often returns a full executable path rather than a bare
 *  name (e.g. ".../iTerm.app/Contents/MacOS/iTerm2"); classifyHost's fixture
 *  chains use bare names ('iTerm2', 'Code Helper', '-zsh'), so basename()
 *  each hop to match — verified against live ancestry chains on this
 *  machine that iTerm2/Terminal/VS Code all end in a plain basename either
 *  way. */
function processChain(pid: number, maxDepth = 12): string[] {
  const chain: string[] = [];
  let cur: number | null = pid;
  let depth = 0;
  while (cur !== null && depth < maxDepth) {
    const line: string = safeExec('ps', ['-o', 'ppid=,comm=', '-p', String(cur)]).trim();
    const m: RegExpMatchArray | null = line.match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    chain.push(basename(m[2]!.trim()));
    const ppid: number = Number(m[1]);
    if (ppid <= 1) break;
    cur = ppid;
    depth++;
  }
  return chain;
}

function liveClaudeProcesses(): LiveProcess[] {
  const pids = parsePgrep(safeExec('pgrep', ['-x', 'claude']));
  return pids.map(pid => ({
    pid,
    tty: parseTty(safeExec('ps', ['-o', 'tty=', '-p', String(pid)])),
    cwd: parseLsofCwd(safeExec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])),
    host: classifyHost(processChain(pid)),
  }));
}

/** Candidate sessions for matching: every distinct session_id the store has
 *  seen a session.started event for, with the cwd that event recorded.
 *  Requires `ingest` to have run at least once — this reads whatever is
 *  already in the store, it does not ingest on the caller's behalf.
 *
 *  Ordered most-recent-first (by row id, a proxy for ingestion/event order)
 *  so that when classifyMatch's candidate lists get truncated for display,
 *  the entries kept are the ones most likely to still be live — on a
 *  machine with months of history, a cwd can accumulate hundreds of past
 *  sessions, and "ambiguous" is correct but unreadable without this. */
function sessionRefs(db: Db): SessionRef[] {
  const rows = db.prepare(
    `SELECT session_id as sessionId, payload FROM events
     WHERE kind = 'session.started' ORDER BY id DESC`,
  ).all() as { sessionId: string; payload: string }[];
  const byId = new Map<string, string | null>();
  for (const r of rows) {
    if (byId.has(r.sessionId)) continue; // keep the most recent row per session
    let cwd: string | null = null;
    try { cwd = JSON.parse(r.payload)?.cwd ?? null; } catch { cwd = null; }
    byId.set(r.sessionId, cwd);
  }
  return [...byId.entries()].map(([sessionId, cwd]) => ({ sessionId, cwd }));
}

const MAX_CANDIDATES_SHOWN = 5;

function formatCandidates(candidates: string[]): string {
  if (candidates.length <= MAX_CANDIDATES_SHOWN) return candidates.join(', ');
  const shown = candidates.slice(0, MAX_CANDIDATES_SHOWN).join(', ');
  return `${shown}, and ${candidates.length - MAX_CANDIDATES_SHOWN} more`;
}

if (cmd === 'probe') {
  const caps = probeCapabilities(paths);
  for (const [k, v] of Object.entries(caps)) {
    console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  }

  // readCodexThreads/readSpawnEdges collapse every failure mode (missing
  // file, locked database, unrecognized schema, a bug in our own row
  // mapping) to the same null/[] — lastStateDbError() is what lets probe
  // say WHY instead of just whether. Check it immediately after each call:
  // it reflects whichever of the two ran most recently.
  const threads = readCodexThreads(paths.codexStateDb);
  if (threads) {
    console.log(`PASS  codex state db readable -- ${threads.length} threads`);
  } else {
    console.log(`FAIL  codex state db unreadable -- ${lastStateDbError() ?? 'unknown reason'} (falling back to rollout files)`);
  }

  const edges = readSpawnEdges(paths.codexStateDb);
  const edgesErr = lastStateDbError();
  if (edgesErr) {
    console.log(`FAIL  codex spawn edges unreadable -- ${edgesErr}`);
  } else {
    console.log(`PASS  codex spawn edges readable -- ${edges.length} edges`);
  }
} else if (cmd === 'sessions') {
  const db = open();
  const procs = liveClaudeProcesses();
  const sessions = sessionRefs(db);
  const matches = classifyMatch(procs, sessions);

  if (matches.length === 0) {
    console.log('no live claude processes found');
  }
  for (const m of matches) {
    const proc = procs.find(p => p.pid === m.pid);
    console.log(`pid ${m.pid}  tty ${m.tty ?? '-'}  host ${m.host}  match ${m.quality}`);
    console.log(`    cwd ${proc?.cwd ?? '(unknown)'}`);
    if (m.quality === 'unique') console.log(`    session ${m.sessionId}`);
    if (m.quality === 'ambiguous') {
      console.log(`    candidates (${m.candidates.length}): ${formatCandidates(m.candidates)}`);
    }
  }
  if (sessions.length === 0) {
    console.log('\nWARN  no sessions recorded in the store yet -- run `ingest` first so cwd matching has something to match against');
  }
} else if (cmd === 'ingest') {
  const db = open();
  let files = 0, written = 0, unparsed = 0;
  for (const f of walk(paths.claudeProjects, /\.jsonl$/)) {
    const r = ingestFileOnce(db, f, 'claude'); files++; written += r.written; unparsed += r.unparsed;
  }
  for (const f of walk(paths.codexSessions, /rollout-.*\.jsonl$/)) {
    const r = ingestFileOnce(db, f, 'codex'); files++; written += r.written; unparsed += r.unparsed;
  }
  written += ingestSpool(db, paths.spool);
  rotateSpool(paths.spool, { maxAgeDays: 30, maxFiles: 20000 });
  console.log(`ingested ${files} files, ${written} events, ${unparsed} unparsed`);
  if (unparsed > 0) {
    console.error(`\nWARN  ${unparsed} records were not recognized -- transcript format may have changed.`);
  }
} else if (cmd === 'stream') {
  const db = open();
  const roots = [
    { dir: paths.claudeProjects, provider: 'claude' as Provider, glob: /\.jsonl$/ },
    { dir: paths.codexSessions, provider: 'codex' as Provider, glob: /rollout-.*\.jsonl$/ },
  ].filter(r => existsSync(r.dir));

  console.log(`watching ${roots.length} root(s) -- ctrl-c to stop\n`);
  const w = startWatcher(db, roots, (path, _provider, out) => {
    for (const e of out.events) console.log(formatEventLine(e));
  });
  const spoolTimer = setInterval(() => ingestSpool(db, paths.spool), 1000);
  process.on('SIGINT', () => {
    clearInterval(spoolTimer);
    void w.close().then(() => process.exit(0));
  });
} else {
  console.log(`llm-workspace (phases 1-2)

  probe      report which providers, databases and tools are present
  sessions   list live provider processes and their session match quality
  ingest     one-shot ingest of every transcript into the index
  stream     watch live and print the normalized event stream
`);
}
