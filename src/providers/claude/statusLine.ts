import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { currentWindow, type ClaudeUsage, type RateWindow } from '../../core/usage.ts';

/** Reader for the status line feed (src/hooks/statusline.sh): one JSON
 *  snapshot per session in ~/.llm-workspace/statusline/<session_id>.json,
 *  exactly as Claude Code piped it. Untrusted in the ordinary sense -- any
 *  process running as the user can write there -- so every field the app
 *  uses is type-checked, unknown fields are ignored, and size is capped
 *  before reading. */

/** The helper drops anything larger; this refuses it again at read time. */
export const SNAPSHOT_MAX_BYTES = 64 * 1024;

/** The same rule the helper applies before naming a file. */
const SESSION_ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const SNAPSHOT_FILE = /^([A-Za-z0-9_-]{1,128})\.json$/;
const MODEL_ID_MAX = 128;

export interface ClaudeSnapshot {
  sessionId: string;
  modelId: string | null;
  /** context_window.context_window_size, when a positive integer. */
  windowTokens: number | null;
  /** input + cache_creation + cache_read from context_window.current_usage
   *  (the documented formula; output is not counted). null before the first
   *  reply and right after /compact, when Claude sends current_usage: null. */
  usedTokens: number | null;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
}

export interface SnapshotRead { snapshot: ClaudeSnapshot; mtimeMs: number }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function tokenCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function usedTokensOf(contextWindow: unknown): number | null {
  if (!isObject(contextWindow) || !isObject(contextWindow.current_usage)) return null;
  const u = contextWindow.current_usage;
  const input = tokenCount(u.input_tokens);
  // Absent cache counts are zero; present-but-wrong ones void the total.
  const created = u.cache_creation_input_tokens === undefined ? 0 : tokenCount(u.cache_creation_input_tokens);
  const read = u.cache_read_input_tokens === undefined ? 0 : tokenCount(u.cache_read_input_tokens);
  if (input === null || created === null || read === null) return null;
  return input + created + read;
}

function windowSizeOf(contextWindow: unknown): number | null {
  if (!isObject(contextWindow)) return null;
  const size = contextWindow.context_window_size;
  return typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : null;
}

/** used_percentage must be a finite number >= 0; resets_at (epoch seconds)
 *  becomes epoch ms, or null when missing or not a positive number. */
function rateWindowOf(v: unknown): RateWindow | null {
  if (!isObject(v)) return null;
  const used = v.used_percentage;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const resets = v.resets_at;
  const resetsAt = typeof resets === 'number' && Number.isFinite(resets) && resets > 0 ? resets * 1000 : null;
  return { usedPct: used, resetsAt };
}

export function parseClaudeSnapshot(text: string): ClaudeSnapshot | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObject(raw)) return null;
  const sessionId = raw.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID_SAFE.test(sessionId)) return null;

  const model = isObject(raw.model) ? raw.model.id : undefined;
  const modelId = typeof model === 'string' && model.length > 0 && model.length <= MODEL_ID_MAX ? model : null;
  const limits = isObject(raw.rate_limits) ? raw.rate_limits : {};
  return {
    sessionId,
    modelId,
    windowTokens: windowSizeOf(raw.context_window),
    usedTokens: usedTokensOf(raw.context_window),
    fiveHour: rateWindowOf(limits.five_hour),
    sevenDay: rateWindowOf(limits.seven_day),
  };
}

/** Parsed snapshots keyed by path, reused while the file's identity (inode,
 *  size, mtime) is unchanged -- the helper replaces the file by rename, so
 *  any rewrite changes the inode. Cleared wholesale past a bound so it can
 *  never grow without limit. */
const cache = new Map<string, { key: string; snapshot: ClaudeSnapshot | null }>();
const CACHE_MAX = 512;

/** Opens once, O_NOFOLLOW|O_NONBLOCK: a symlink is refused at open time
 *  (never a separate check racing a later open), and a FIFO planted at the
 *  path never blocks the caller waiting for a writer. `fstat`s that single
 *  descriptor for the regular-file and size checks, then reads from it --
 *  no path-based re-open that a rename in between could point somewhere
 *  else entirely. ENOENT and ELOOP are the ordinary "not there"/"not ours
 *  to follow" outcomes and are not logged; anything else is. */
function readSnapshotFile(path: string): SnapshotRead | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ELOOP') console.error('status line snapshot: could not open', path, e);
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > SNAPSHOT_MAX_BYTES) return null;

    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = cache.get(path);
    if (hit && hit.key === key) return hit.snapshot ? { snapshot: hit.snapshot, mtimeMs: st.mtimeMs } : null;

    const snapshot = parseClaudeSnapshot(readFileSync(fd, 'utf8'));
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(path, { key, snapshot });
    return snapshot ? { snapshot, mtimeMs: st.mtimeMs } : null;
  } catch (e) {
    console.error('status line snapshot: could not read', path, e);
    return null;
  } finally {
    closeSync(fd);
  }
}

/** One session's latest snapshot. The id is checked before it reaches a
 *  path, and the file's own session_id must match its name. */
export function readClaudeSnapshot(dir: string, sessionId: string): SnapshotRead | null {
  if (!SESSION_ID_SAFE.test(sessionId)) return null;
  const read = readSnapshotFile(join(dir, `${sessionId}.json`));
  return read && read.snapshot.sessionId === sessionId ? read : null;
}

/** Account-wide rate limits: the newest snapshot (by file mtime) that has
 *  any, minus windows that have already reset. null when there is none. */
export function readClaudeRateLimits(dir: string, now: number): ClaudeUsage | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('status line snapshots: could not list', dir, e);
    return null;
  }

  const files: { id: string; path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const m = SNAPSHOT_FILE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isFile()) files.push({ id: m[1]!, path, mtimeMs: st.mtimeMs });
    } catch {
      // Gone since the listing (the helper renames over files): skip it.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const f of files) {
    const read = readSnapshotFile(f.path);
    if (!read || read.snapshot.sessionId !== f.id) continue;
    const { fiveHour, sevenDay } = read.snapshot;
    if (!fiveHour && !sevenDay) continue;
    const five = currentWindow(fiveHour, now);
    const seven = currentWindow(sevenDay, now);
    if (!five && !seven) return null;
    return {
      ...(five ? { fiveHour: five } : {}),
      ...(seven ? { sevenDay: seven } : {}),
      updatedAt: read.mtimeMs,
    };
  }
  return null;
}

/** The helper's own dot-prefixed temp name before its atomic rename
 *  (mktemp "$DIR/.statusline.XXXXXX") -- a crash between mktemp and mv, or
 *  a run killed past its EXIT trap, can leave one behind. */
const TEMP_FILE = /^\.statusline\.[A-Za-z0-9]+$/;
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

/** Startup pruning (src/main/index.ts, beside rotateSpool): the helper
 *  writes one file per session and nothing else ever removes them, so a
 *  snapshot not rewritten in `maxAgeDays` is deleted -- alongside any
 *  leftover `.statusline.*` temp file older than an hour (a normal run
 *  never leaves one behind at all; an hour is plenty even for the biggest
 *  input this ever writes). Only regular files are candidates for either
 *  rule -- lstat, so a symlink is never followed and never removed. Per-file
 *  failures are logged and skipped; a missing folder is a quiet no-op.
 *  Returns how many were deleted. */
export function pruneSnapshots(dir: string, opts: { maxAgeDays: number; now?: number }): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('status line snapshots: could not list', dir, e);
    return 0;
  }
  const now = opts.now ?? Date.now();
  const snapshotCutoff = now - opts.maxAgeDays * 86_400_000;
  const tempCutoff = now - TEMP_FILE_MAX_AGE_MS;
  let removed = 0;
  for (const name of names) {
    const isSnapshot = SNAPSHOT_FILE.test(name);
    if (!isSnapshot && !TEMP_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.mtimeMs >= (isSnapshot ? snapshotCutoff : tempCutoff)) continue;
      unlinkSync(path);
      cache.delete(path);
      removed++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('status line snapshots: could not prune', path, e);
    }
  }
  return removed;
}
