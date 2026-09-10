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

/** Spec §5.5. Codex maintains its own session index; reading it beats
 *  globbing thousands of rollout files, and it hands over `rollout_path`
 *  directly.
 *
 *  Strictly an ACCELERATOR: opened read-only, never written, and any
 *  unrecognized schema returns null so the caller falls back to rollout-file
 *  parsing. The `state_5` name and migrations table say plainly that this
 *  schema is versioned and will change. */
export function readCodexThreads(dbPath: string): CodexThread[] | null {
  if (!existsSync(dbPath)) return null;
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
  } catch {
    return null; // unknown schema, locked, or corrupt — fall back to files
  } finally {
    db?.close();
  }
}

export function readSpawnEdges(dbPath: string): SpawnEdge[] {
  if (!existsSync(dbPath)) return [];
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
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
