#!/usr/bin/env node
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from './store/db.ts';
import { ingestAll, startWatcher } from './watch/watcher.ts';
import { ingestSpool, rotateSpool } from './hooks/spool.ts';
import { readCodexThreads, readSpawnEdges, lastStateDbError } from './providers/codex/stateDb.ts';
import { discoverLiveProcesses } from './discovery/live.ts';
import {
  resolvePaths, probeCapabilities, formatEventLine,
  sessionRefs, annotateSessionsWithProcesses, formatCandidates,
} from './config.ts';
import type { Provider } from './core/types.ts';

const paths = resolvePaths(homedir());
const cmd = process.argv[2] ?? 'help';

function open() {
  mkdirSync(join(homedir(), '.llm-workspace'), { recursive: true });
  return openDb(paths.db);
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
  // Spec §7.1a: the store's transcript activity is the source of truth for
  // which sessions exist; live process discovery only enriches each one
  // with pid/tty/host where a process can be found. A session with no
  // matching process still lists, with match `unknown` -- it does not
  // disappear the way it would under a process-first enumeration.
  const db = open();
  // The CLI matches by cwd only (classifyMatch, via annotateSessionsWithProcesses) -- never exact identity -- so skip reading live session files entirely.
  const procs = await discoverLiveProcesses(undefined, { readLiveSession: () => ({ ok: false, reason: 'missing' }) });
  const sessions = sessionRefs(db);
  const annotated = annotateSessionsWithProcesses(sessions, procs);

  if (annotated.length === 0) {
    console.log('no sessions active in the last 30 minutes were found in the store -- run `ingest` first if the store is empty, or none of the sessions in it has had activity that recently');
  }
  for (const s of annotated) {
    console.log(`session ${s.sessionId}  match ${s.quality}`);
    console.log(`    cwd ${s.cwd ?? '(unknown)'}`);
    if (s.quality === 'unique' && s.process) {
      console.log(`    pid ${s.process.pid}  tty ${s.process.tty ?? '-'}  host ${s.process.host}`);
    }
    if (s.quality === 'ambiguous') {
      const pidStrs = s.candidatePids.map(String);
      console.log(`    candidate processes (${pidStrs.length}): ${formatCandidates(pidStrs)}`);
    }
  }
} else if (cmd === 'ingest') {
  const db = open();
  const roots = [
    { dir: paths.claudeProjects, provider: 'claude' as Provider, glob: /\.jsonl$/ },
    { dir: paths.codexSessions, provider: 'codex' as Provider, glob: /rollout-.*\.jsonl$/ },
  ];
  // ingestAll catches per-file, the same way startWatcher's handler does --
  // one unreadable file, or one D1 correctly refuses to silently drift past
  // (malformed UTF-8), must not abort the whole corpus and leave the spool
  // ingest/rotation below never run, and every later `ingest` dying on that
  // same file forever.
  const { files, written: filesWritten, unparsed, skipped } = ingestAll(db, roots);
  const written = filesWritten + ingestSpool(db, paths.spool);
  rotateSpool(paths.spool, { maxAgeDays: 30, maxFiles: 20000 });
  console.log(`ingested ${files} files, ${written} events, ${unparsed} unparsed, ${skipped} skipped`);
  // Deliberately two separate warnings, not one merged count: unparsed
  // records mean a transcript format changed (still fully read, just an
  // unrecognized record shape); skipped files mean a file could not be
  // read/parsed at all. Different causes, different responses -- collapsing
  // them would hide the more serious one (data simply missing from the
  // index, not just an unrecognized record inside it).
  if (unparsed > 0) {
    console.error(`\nWARN  ${unparsed} records were not recognized -- transcript format may have changed.`);
  }
  if (skipped > 0) {
    console.error(`\nWARN  ${skipped} file(s) could not be ingested at all -- see errors above for which, and why.`);
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
  sessions   list recently active sessions and their live process, if any
  ingest     one-shot ingest of every transcript into the index
  stream     watch live and print the normalized event stream
`);
}
