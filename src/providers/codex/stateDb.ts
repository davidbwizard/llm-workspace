import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

export interface CodexThread {
  id: string;
  rolloutPath: string | null;
  cwd: string | null;
  source: string | null;
  cliVersion: string | null;
  gitBranch: string | null;
  model: string | null;
  agentRole: string | null;
  threadSource: string | null;
  tokensUsed: number | null;
  archived: boolean;
}

export interface SpawnEdge {
  parentThreadId: string;
  childThreadId: string;
  status: string | null;
}

/** Set by readCodexThreads/readSpawnEdges: null on success, the failure
 *  reason otherwise. Reset at the start of each call, so it always reflects
 *  the outcome of whichever of the two ran most recently — check it
 *  immediately after the call it concerns, before calling the other one.
 *
 *  Exists because both functions return an empty result (null / []) for
 *  every failure mode — missing file, locked database, unrecognized schema,
 *  a bug in our own row mapping — and those look identical from outside.
 *  An earlier draft's unsupported sqlite open form threw on every call and
 *  returned null every time; nothing broke because null just means "fall
 *  back to rollout files", so the accelerator silently never engaged. This
 *  is how `probe` tells "absent" from "broken" without changing the return
 *  contract callers already depend on. */
let lastError: string | null = null;

export function lastStateDbError(): string | null {
  return lastError;
}

/** Spec §5.5. Codex maintains its own session index; reading it beats
 *  globbing thousands of rollout files, and it hands over `rollout_path`
 *  directly.
 *
 *  Strictly an ACCELERATOR: opened read-only, never written, and any
 *  unrecognized schema returns null so the caller falls back to rollout-file
 *  parsing. The `state_5` name and migrations table say plainly that this
 *  schema is versioned and will change. */
export function readCodexThreads(dbPath: string): CodexThread[] | null {
  lastError = null;
  if (!existsSync(dbPath)) {
    lastError = `state db not found: ${dbPath}`;
    return null;
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, source, cli_version, git_branch, model,
             agent_role, thread_source, tokens_used, archived
      FROM threads`).all() as any[];
    return rows.map(r => ({
      id: String(r.id),
      rolloutPath: r.rollout_path ?? null,
      cwd: r.cwd ?? null,
      source: r.source ?? null,
      cliVersion: r.cli_version ?? null,
      gitBranch: r.git_branch ?? null,
      model: r.model ?? null,
      agentRole: r.agent_role ?? null,
      threadSource: r.thread_source ?? null,
      tokensUsed: r.tokens_used ?? null,
      archived: Boolean(r.archived),
    }));
  } catch (err) {
    // unknown schema, locked, or corrupt — fall back to files
    lastError = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    db?.close();
  }
}

export function readSpawnEdges(dbPath: string): SpawnEdge[] {
  lastError = null;
  if (!existsSync(dbPath)) {
    lastError = `state db not found: ${dbPath}`;
    return [];
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      'SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges').all() as any[];
    return rows.map(r => ({
      parentThreadId: String(r.parent_thread_id),
      childThreadId: String(r.child_thread_id),
      status: r.status ?? null,
    }));
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return [];
  } finally {
    db?.close();
  }
}
