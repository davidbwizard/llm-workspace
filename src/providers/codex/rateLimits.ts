import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { currentWindow, type CodexRateWindow, type CodexUsage } from '../../core/usage.ts';

/** Codex rate limits and context (usage design, Part A), read from the
 *  rollout JSONL Codex already writes (~/.codex/sessions/YYYY/MM/DD/
 *  rollout-*.jsonl): every `token_count` event carries the account's
 *  `rate_limits`, and most carry the thread's token usage. Rollouts
 *  run to tens of MB (21 MB measured on 2026-09-18), so a file is only ever
 *  read backwards from its end, within a byte budget, and the result is
 *  cached by the file's size and mtime. */

export interface CodexLimitsRead {
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
  planType: string | null;
  /** The event's own timestamp, epoch ms; null when missing or bad. */
  updatedAt: number | null;
}

/** Look at most this many of the newest rollouts (design: "at most the 5
 *  newest"), found among this many of the most recent day folders -- a
 *  session keeps writing into the folder of the day it started, so the
 *  newest-by-mtime file can sit a day or more back. */
const MAX_FILES = 5;
const MAX_DAY_DIRS = 7;
const DEFAULT_MAX_BYTES = 1 << 20;
const DEFAULT_CHUNK = 64 * 1024;
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
const PLAN_TYPE_SAFE = /^[A-Za-z0-9_.-]{1,64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function windowOf(v: unknown): CodexRateWindow | null {
  if (!isObject(v)) return null;
  const used = v.used_percent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const minutes = v.window_minutes;
  const resets = v.resets_at;
  return {
    usedPct: used,
    windowMinutes: typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 ? minutes : null,
    // Epoch seconds in the rollout; ms here, like every time in the app.
    resetsAt: typeof resets === 'number' && Number.isFinite(resets) && resets > 0 ? resets * 1000 : null,
  };
}

/** One rollout line -> its rate limits, or null (not a token_count, no
 *  rate_limits, or neither window usable). Every field is type-checked;
 *  unknown ones are ignored. */
export function parseTokenCountLine(line: string): CodexLimitsRead | null {
  let rec: unknown;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!isObject(rec) || rec.type !== 'event_msg' || !isObject(rec.payload)) return null;
  if (rec.payload.type !== 'token_count' || !isObject(rec.payload.rate_limits)) return null;
  const rl = rec.payload.rate_limits;
  const primary = windowOf(rl.primary);
  const secondary = windowOf(rl.secondary);
  if (!primary && !secondary) return null;
  const plan = rl.plan_type;
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  return {
    primary,
    secondary,
    planType: typeof plan === 'string' && PLAN_TYPE_SAFE.test(plan) ? plan : null,
    updatedAt: Number.isFinite(ts) ? ts : null,
  };
}

export interface TailOpts { maxBytes?: number; chunkBytes?: number }

/** The LAST token_count with rate limits in the file (see lastTokenCount). */
export function lastRateLimitsInFile(path: string, opts: TailOpts = {}): CodexLimitsRead | null {
  return lastTokenCount(path, parseTokenCountLine, opts);
}

/** Walks an already-open, already-`fstat`ed regular file backwards from its
 *  end in `chunkBytes` steps, never further back than `maxBytes`, and
 *  returns the first non-null `parse` result -- i.e. from the LAST matching
 *  token_count line. Lines are split on raw newline bytes (never inside a
 *  UTF-8 sequence), and only lines mentioning token_count are parsed at
 *  all. A line cut off by the budget is dropped, never parsed as a
 *  fragment. Never opens or closes `fd` -- that is the caller's job, so a
 *  caller needing the same `fstat` for its own cache key pays for the
 *  syscall once. */
function tailReadFrom<T>(
  fd: number, size: number, parse: (line: string) => T | null, maxBytes: number, chunkBytes: number,
): T | null {
  const floor = Math.max(0, size - maxBytes);
  let pos = size;
  // Bytes after `pos` that do not yet form a whole line (their start lies
  // in a chunk not read yet).
  let carry = Buffer.alloc(0);
  while (pos > floor) {
    const start = Math.max(floor, pos - chunkBytes);
    const buf = Buffer.allocUnsafe(pos - start);
    // The byte count readSync actually returns, never the requested length,
    // decides how much of `buf` is real: anything short of the full request
    // means the rest is leftover Buffer.allocUnsafe memory, never parsed.
    const n = readSync(fd, buf, 0, buf.length, start);
    if (n !== buf.length) return null;
    pos = start;
    const data = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;
    // Before the first newline is the tail of a line that began earlier --
    // unless this chunk starts the file, where it is a whole line.
    const firstNl = start === 0 ? -1 : data.indexOf(0x0a);
    if (start !== 0 && firstNl === -1) { carry = data; continue; }
    const whole = data.subarray(firstNl + 1);
    let end = whole.length;
    while (end > 0) {
      const nl = whole.lastIndexOf(0x0a, end - 1);
      const line = whole.subarray(nl + 1, end);
      end = nl === -1 ? 0 : nl;
      if (line.length === 0 || line.indexOf('"token_count"') === -1) continue;
      const hit = parse(line.toString('utf8'));
      if (hit !== null) return hit;
    }
    carry = firstNl === -1 ? Buffer.alloc(0) : data.subarray(0, firstNl);
  }
  return null;
}

/** Opens `path` O_NOFOLLOW (a symlink is refused at open time, never
 *  followed -- no check-then-open gap for another process to race) and
 *  O_NONBLOCK (a FIFO planted at the path is refused immediately, never
 *  blocking the caller waiting for a writer that will never come), then
 *  `fstat`s the descriptor once: a directory, FIFO or anything else that is
 *  not a regular file is refused quietly, without attempting to read it.
 *  ENOENT and ELOOP (the symlink case) are the ordinary "not there"/"not
 *  ours to follow" outcomes and are not logged; anything else is. */
function lastTokenCount<T>(path: string, parse: (line: string) => T | null, opts: TailOpts): T | null {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ELOOP') console.error('codex rollout: could not open', path, e);
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    return tailReadFrom(fd, st.size, parse, maxBytes, chunkBytes);
  } catch (e) {
    console.error('codex rollout: could not read', path, e);
    return null;
  } finally {
    closeSync(fd);
  }
}

function descendingDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
      .map(d => d.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('codex rate limits: could not list', dir, e);
    return [];
  }
}

/** The (at most) five newest rollout files by mtime, among the most recent
 *  day folders -- a bounded walk, never the whole history. */
export function newestRollouts(root: string, limit = MAX_FILES): { path: string; mtimeMs: number; size: number }[] {
  const dayDirs: string[] = [];
  outer:
  for (const year of descendingDirs(root)) {
    for (const month of descendingDirs(join(root, year))) {
      for (const day of descendingDirs(join(root, year, month))) {
        dayDirs.push(join(root, year, month, day));
        if (dayDirs.length >= MAX_DAY_DIRS) break outer;
      }
    }
  }

  const files: { path: string; mtimeMs: number; size: number }[] = [];
  for (const dir of dayDirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!ROLLOUT_FILE.test(name)) continue;
      const path = join(dir, name);
      try {
        // lstat, not stat: a symlinked rollout is never counted, so it can
        // neither bump a real one out of the newest-five nor report its
        // target's own size/mtime as if it were a real rollout.
        const st = lstatSync(path);
        if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Removed since the listing: skip it.
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** Per-file results, reused while the file's size and mtime are unchanged.
 *  Rebuilt from the current candidates on every call, so it holds at most
 *  five entries. */
let cache = new Map<string, { key: string; read: CodexLimitsRead | null }>();

/** Account-wide Codex rate limits: the most recent token_count with rate
 *  limits among the newest rollouts, minus windows that have already reset.
 *  null when there is none. */
export function readCodexRateLimits(root: string, now: number): CodexUsage | null {
  const next = new Map<string, { key: string; read: CodexLimitsRead | null }>();
  let best: { read: CodexLimitsRead; at: number } | null = null;
  for (const f of newestRollouts(root)) {
    const key = `${f.size}:${f.mtimeMs}`;
    const hit = cache.get(f.path);
    const read = hit && hit.key === key ? hit.read : lastRateLimitsInFile(f.path);
    next.set(f.path, { key, read });
    if (!read) continue;
    // An event with no timestamp is dated by its file's mtime.
    const at = read.updatedAt ?? f.mtimeMs;
    if (!best || at > best.at) best = { read, at };
  }
  cache = next;
  if (!best) return null;

  const primary = currentWindow(best.read.primary, now);
  const secondary = currentWindow(best.read.secondary, now);
  if (!primary && !secondary) return null;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(best.read.planType ? { planType: best.read.planType } : {}),
    updatedAt: best.at,
  };
}

// --- Context ------------------------------------------------------------

/** One thread's context use from its latest token_count usage. Either field
 *  is null when the record does not carry a usable value. */
export interface CodexContextRead { usedTokens: number | null; windowTokens: number | null }

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/** A token_count carrying usage -> { usedTokens, windowTokens }; null for any
 *  other line, including the rate-limits-only token_count (info: null) Codex
 *  writes at the start of a turn, so the scan keeps looking past it.
 *
 *  used = info.last_token_usage.input_tokens ALONE: the prompt of the
 *  thread's latest model call, which is what occupies the window. In the
 *  rollout, cached_input_tokens is a subset of input_tokens (OpenAI
 *  accounting -- measured 2026-09-18 over 821 real usages: cached <= input
 *  every time, and total_tokens == input_tokens + output_tokens in all 713
 *  that carry input counts), so adding it would double-count. That is the
 *  same "whole prompt, output excluded" quantity as Claude's
 *  input + cache_creation + cache_read. cache_write_input_tokens was 0 in
 *  every sample, so it is not added. An input of 0 (the total-only records
 *  seen from Codex Desktop, which also carry no window) is unknown, not
 *  zero. window = info.model_context_window. */
export function parseTokenUsageLine(line: string): CodexContextRead | null {
  let rec: unknown;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!isObject(rec) || rec.type !== 'event_msg' || !isObject(rec.payload)) return null;
  if (rec.payload.type !== 'token_count' || !isObject(rec.payload.info)) return null;
  const info = rec.payload.info;
  if (!isObject(info.last_token_usage)) return null;
  return {
    usedTokens: positiveInt(info.last_token_usage.input_tokens),
    windowTokens: positiveInt(info.model_context_window),
  };
}

/** The latest usage in the file, even when it is unusable -- an older count
 *  would be a confident wrong answer about the current context. */
export function lastUsageInFile(path: string, opts: TailOpts = {}): CodexContextRead | null {
  return lastTokenCount(path, parseTokenUsageLine, opts);
}

/** Per-rollout results, reused while the file's size and mtime are
 *  unchanged, so an idle session costs one lstat per refresh and an active
 *  one a short tail read. Cleared past a bound (only live sessions are ever
 *  asked for). */
const contextCache = new Map<string, { key: string; read: CodexContextRead | null }>();
const CONTEXT_CACHE_MAX = 64;

/** One rollout's latest context use. Opens once, O_NOFOLLOW|O_NONBLOCK (a
 *  symlink or FIFO is refused without blocking, same as lastTokenCount
 *  above), and `fstat`s that single descriptor for both the cache key and
 *  the regular-file check -- no separate check-then-open against a path
 *  that could change in between. null for a missing, non-regular or
 *  oversized-by-nothing-in-particular (rollouts have no whole-file cap;
 *  only the tail read is bounded) file. */
export function readCodexContext(path: string): CodexContextRead | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ELOOP') console.error('codex rollout: could not open', path, e);
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = contextCache.get(path);
    if (hit && hit.key === key) return hit.read;
    const read = tailReadFrom(fd, st.size, parseTokenUsageLine, DEFAULT_MAX_BYTES, DEFAULT_CHUNK);
    if (contextCache.size >= CONTEXT_CACHE_MAX) contextCache.clear();
    contextCache.set(path, { key, read });
    return read;
  } catch (e) {
    console.error('codex rollout: could not read', path, e);
    return null;
  } finally {
    closeSync(fd);
  }
}
