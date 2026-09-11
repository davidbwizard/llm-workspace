export type HostApp = 'iterm2' | 'terminal' | 'vscode' | 'claude-app' | 'codex-app' | 'unknown';

export interface LiveProcess {
  pid: number;
  tty: string | null;
  cwd: string | null;
  host: HostApp;
  /** Seconds the process has been running (`ps -o etime=`). Optional, not
   *  `| undefined`-free, so every LiveProcess fixture already in the
   *  codebase (match.ts's and cli.ts's tests predate this field) keeps
   *  typechecking without being rewritten -- src/discovery/live.ts, the
   *  only real producer, always sets it, to a number or null, never
   *  omits it. */
  ageSeconds?: number | null;
  /** Resident set size in bytes (`ps -o rss=`, reported in 1024-byte
   *  blocks on macOS/BSD `ps` and normalized to bytes here). Same
   *  optionality rationale as ageSeconds. */
  rssBytes?: number | null;
}

/** Parse `pgrep -x claude` output. */
export function parsePgrep(out: string): number[] {
  return out.split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number);
}

/** Parse `ps -o tty= -p <pid>`. `??` means no controlling terminal. */
export function parseTty(out: string): string | null {
  const t = out.trim();
  return !t || t === '??' || t === '?' ? null : t;
}

/** Parse `lsof -a -p <pid> -d cwd -Fn` — the cwd is the `n`-prefixed line. */
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1).trim() || null;
  }
  return null;
}

/** Parse the elapsed-time field of `ps -o etime=,rss= -p <pid>` -- the first
 *  whitespace-separated token. Its format depends on how long the process
 *  has run: `MM:SS`, `HH:MM:SS`, or `DD-HH:MM:SS`. Returns seconds, or null
 *  for missing or unrecognized input (e.g. the process exited between
 *  pgrep and this call, leaving no output at all). */
export function parseEtime(out: string): number | null {
  const field = out.trim().split(/\s+/)[0];
  if (!field) return null;
  const dash = field.indexOf('-');
  const days = dash >= 0 ? Number(field.slice(0, dash)) : 0;
  const clock = (dash >= 0 ? field.slice(dash + 1) : field).split(':');
  if (clock.length !== 2 && clock.length !== 3) return null;
  const nums = clock.map(Number);
  if (!Number.isFinite(days) || nums.some(n => !Number.isFinite(n))) return null;
  const [hours, minutes, seconds] = nums.length === 3 ? nums : [0, nums[0]!, nums[1]!];
  return ((days * 24 + hours!) * 60 + minutes!) * 60 + seconds!;
}

/** Parse the rss field of `ps -o etime=,rss= -p <pid>` -- the second
 *  whitespace-separated token, in 1024-byte blocks (`ps`'s default unit on
 *  macOS/BSD) -- normalized to bytes here so a UI consumes a plain byte
 *  count, not a unit-dependent one. Returns null for missing or
 *  non-numeric input. */
export function parseRss(out: string): number | null {
  const field = out.trim().split(/\s+/)[1];
  if (!field) return null;
  const kb = Number(field);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** Map a process ancestry chain to its terminal host. Spec §7.3 — this
 *  decides which jump action is offered, and VS Code deliberately gets a
 *  weaker one because a specific tab cannot be targeted.
 *
 *  `chain[0]` is the process being classified (the `claude`/`codex` CLI
 *  itself), not an ancestor — only entries after it say what spawned it.
 *  Excluded here: without this, a bare `claude` at index 0 collides with
 *  the claude-app check below and every unmatched chain misclassifies as
 *  claude-app instead of falling through to unknown. */
export function classifyHost(chain: string[]): HostApp {
  const names = chain.slice(1).map(n => n.toLowerCase());
  if (names.some(n => n.includes('iterm'))) return 'iterm2';
  if (names.some(n => n === 'code' || n.includes('code helper'))) return 'vscode';
  if (names.some(n => n === 'terminal')) return 'terminal';
  if (names.some(n => n === 'claude')) return 'claude-app';
  if (names.some(n => n.includes('chatgpt') || n.includes('codex'))) return 'codex-app';
  return 'unknown';
}
