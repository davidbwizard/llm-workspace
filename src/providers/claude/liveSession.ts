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
  /** Claude Code's own description of what `status: "waiting"` is waiting
   *  on: `"permission prompt"` for Bash, Write and plan approval,
   *  `"input needed"` for a question (measured 2026-09-17, quick-answers
   *  design §3). deriveActivity (src/fleet/state.ts) uses this to tell the
   *  two kinds of waiting apart from the status file alone. Optional for
   *  the same reason statusUpdatedAtMs is: every LiveSessionFile literal
   *  already in the codebase predates this field. null when absent or not
   *  a string -- same tolerance as every other field here: an unrecognised
   *  shape never rejects the whole file. */
  waitingFor?: string | null;
  /** Epoch ms parsed from Claude's own `procStart` string -- the process's
   *  actual start time, in the classic C ctime/asctime shape ("Www Mmm dd
   *  hh:mm:ss yyyy"), UTC (measured 2026-09-18 against `ps -o lstart=` for
   *  several live pids; see KNOWN_ISSUES.md). Unlike `startedAt` above,
   *  Claude does NOT rewrite this when the folder-trust prompt is
   *  accepted, which is what makes it startTimeAgrees' fallback signal
   *  below for a slow accept. null when absent or not that exact shape --
   *  same tolerance as every other optional field here: an unrecognised
   *  procStart never rejects the file, it only leaves startTimeAgrees
   *  without its fallback. */
  procStartMs?: number | null;
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

/** KNOWN_ISSUES.md, "A slow trust-prompt accept can permanently hide a
 *  session's waiting card": `procStart` is a whole-second string, same
 *  reasoning as LIVE_SESSION_START_TOLERANCE_MS above, but it is only ever
 *  a fallback for a rewritten `startedAt` -- kept tighter than that 5 s
 *  tolerance since it is not also absorbing `ps -o etime=`'s whole-second
 *  rounding on both sides (startTimeAgrees below already does, via
 *  `processStart`). */
export const LIVE_SESSION_PROC_START_TOLERANCE_MS = 2_000;

const STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'waiting']);

// procStart's exact shape, measured 2026-09-18 across several real
// ~/.claude/sessions/<pid>.json files and cross-checked against
// `ps -o lstart=` for their live pids: "Fri Sep 18 12:58:37 2026", the
// classic C ctime/asctime layout, in UTC. The day-of-month group accepts
// ctime's space-padded single digit ("Sep  8") as well as two digits.
const PROC_START_RE = /^([A-Za-z]{3}) ([A-Za-z]{3}) ([ 0-9]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const PROC_START_WEEKDAYS: ReadonlySet<string> = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const PROC_START_MONTHS: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Strict parse of `procStart` into epoch ms, as UTC. Anything outside the
 *  exact shape above -- wrong field count, an unrecognised weekday or
 *  month, a field out of range, not a string at all -- returns null rather
 *  than guessing: this is untrusted input (same note as
 *  parseLiveSessionFile below) and only ever a fallback signal, never
 *  something worth rejecting the whole file over. */
function parseProcStart(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = PROC_START_RE.exec(value);
  if (!m) return null;
  const [, weekday, monthName, day, hour, minute, second, year] = m as unknown as
    [string, string, string, string, string, string, string, string];
  if (!PROC_START_WEEKDAYS.has(weekday)) return null;
  const month = PROC_START_MONTHS[monthName];
  if (month === undefined) return null;
  const d = Number(day), hh = Number(hour), mm = Number(minute), ss = Number(second), yyyy = Number(year);
  if (d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  const ms = Date.UTC(yyyy, month, d, hh, mm, ss);
  return Number.isFinite(ms) ? ms : null;
}

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
  const waitingFor = typeof r.waitingFor === 'string' ? r.waitingFor : null;
  const procStartMs = parseProcStart(r.procStart);
  return {
    sessionId: r.sessionId, cwd: r.cwd, startedAtMs: r.startedAt, status, statusUpdatedAtMs, waitingFor, procStartMs,
  };
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
 *  trusting the file unchecked.
 *
 *  KNOWN_ISSUES.md, "A slow trust-prompt accept can permanently hide a
 *  session's waiting card" (fixed 2026-09-18): Claude rewrites `startedAt`
 *  to the moment the folder-trust prompt is accepted, which can be tens of
 *  seconds after the process actually started, permanently failing the
 *  check above for that process's whole life. `procStart` is not rewritten
 *  the same way, so a file that fails the `startedAt` comparison still
 *  agrees when `procStartMs` independently matches the process within its
 *  own (tighter) tolerance. A pid-reuse file fails both -- the unrelated
 *  process's real start time agrees with neither the rewritten `startedAt`
 *  nor the stale `procStart` a leftover file would carry. */
export function startTimeAgrees(
  file: LiveSessionFile, ageSeconds: number | null | undefined, nowMs: number,
): boolean {
  if (ageSeconds == null) return false;
  const processStart = nowMs - ageSeconds * 1000;
  if (Math.abs(file.startedAtMs - processStart) <= LIVE_SESSION_START_TOLERANCE_MS) return true;
  return file.procStartMs != null && Math.abs(file.procStartMs - processStart) <= LIVE_SESSION_PROC_START_TOLERANCE_MS;
}
