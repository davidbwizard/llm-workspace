import { openSync, fstatSync, readFileSync, closeSync, existsSync, constants } from 'node:fs';
import { join } from 'node:path';
import { SESSION_ID_SAFE } from '../../core/identity.ts';

/** Claude Code writes ~/.claude/sessions/<pid>.json for every running
 *  session (interactive and `claude -p` alike) and deletes it on exit.
 *  Undocumented internals: this module treats the file as an accelerator
 *  that can vanish or change shape in any update, never as the only path.
 *  Spec: docs/superpowers/specs/2026-09-15-exact-session-identity-design.md.
 *
 *  Read-only, and deliberately narrow: it opens exactly <dir>/<pid>.json
 *  for a pid discovery already found, and never enumerates the directory,
 *  which also holds .key files. */

export type LiveSessionStatus = 'idle' | 'busy' | 'waiting';

export type LiveSessionFile = {
  sessionId: string;
  cwd: string;
  /** Epoch ms. Stable across `/clear` (measured 2026-09-15), which is what
   *  lets the start-time check and Reattach's fresh re-read trust it. */
  startedAtMs: number;
  /** null when absent (a `claude -p` session starts with null) or a value
   *  this code does not recognise -- an unknown status never rejects the
   *  file, it only falls back to the transcript-based activity rule. */
  status: LiveSessionStatus | null;
  /** Epoch ms Claude Code last flipped `status`. Optional, not
   *  `| undefined`-free, for the same reason LiveProcess.ageSeconds/
   *  rssBytes are (src/discovery/parse.ts): every LiveSessionFile literal
   *  already in the codebase predates this field and stays typechecking
   *  unchanged. null when absent or not a finite number -- same tolerance
   *  as startedAtMs above, and for the same reason: an unrecognised shape
   *  here must never reject the whole file, only leave buildSessionLive
   *  (src/main/sessionLive.ts) with no "since" to show for a busy session. */
  statusUpdatedAtMs?: number | null;
};

export type LiveSessionReadFailure =
  | 'missing' | 'missing_dir' | 'not_regular_file' | 'too_large' | 'invalid' | 'read_error';

export type LiveSessionRead =
  | { ok: true; file: LiveSessionFile }
  | { ok: false; reason: LiveSessionReadFailure };

export const LIVE_SESSION_MAX_BYTES = 64 * 1024;

/** `ps -o etime=` reports whole seconds, so a process's derived start can
 *  sit a second or so off the millisecond `startedAt` Claude Code records.
 *  Same 5 s the cwd matcher's START_TOLERANCE_MS uses (src/fleet/state.ts)
 *  for the same reason. */
export const LIVE_SESSION_START_TOLERANCE_MS = 5_000;

const STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'waiting']);

/** Untrusted input: any process running as this user can write the file.
 *  Only `sessionId` ever reaches a command line (via Reattach), so it is
 *  checked against SESSION_ID_SAFE here and again in reattachSession. */
export function parseLiveSessionFile(text: string, pid: number): LiveSessionFile | null {
  if (Buffer.byteLength(text, 'utf8') > LIVE_SESSION_MAX_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.pid !== pid) return null;
  if (typeof r.sessionId !== 'string' || !SESSION_ID_SAFE.test(r.sessionId)) return null;
  if (typeof r.cwd !== 'string' || !r.cwd.startsWith('/')) return null;
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return null;
  const status = typeof r.status === 'string' && STATUSES.has(r.status) ? r.status as LiveSessionStatus : null;
  const statusUpdatedAtMs =
    typeof r.statusUpdatedAt === 'number' && Number.isFinite(r.statusUpdatedAt) ? r.statusUpdatedAt : null;
  return { sessionId: r.sessionId, cwd: r.cwd, startedAtMs: r.startedAt, status, statusUpdatedAtMs };
}

/** Opens with O_NOFOLLOW so a symlink is refused at open time rather than
 *  checked and then raced, and O_NONBLOCK so a FIFO planted at the path
 *  cannot hang the discovery sweep. The size cap is checked on the open
 *  descriptor before anything is read. */
export function readLiveSessionFile(pid: number, dir: string): LiveSessionRead {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'invalid' };
  const path = join(dir, `${pid}.json`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: existsSync(dir) ? 'missing' : 'missing_dir' };
    if (code === 'ELOOP') return { ok: false, reason: 'not_regular_file' };
    return { ok: false, reason: 'read_error' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not_regular_file' };
    if (st.size > LIVE_SESSION_MAX_BYTES) return { ok: false, reason: 'too_large' };
    const file = parseLiveSessionFile(readFileSync(fd, 'utf8'), pid);
    return file ? { ok: true, file } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'read_error' };
  } finally {
    closeSync(fd);
  }
}

/** The pid-reuse guard. A leftover file whose pid was later reused by an
 *  unrelated process would carry a start time that does not match that
 *  process, so it is ignored. Unknown process age rejects rather than
 *  trusting the file unchecked. */
export function startTimeAgrees(
  file: LiveSessionFile, ageSeconds: number | null | undefined, nowMs: number,
): boolean {
  if (ageSeconds == null) return false;
  return Math.abs(file.startedAtMs - (nowMs - ageSeconds * 1000)) <= LIVE_SESSION_START_TOLERANCE_MS;
}
