import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmuxNameForPid } from './sessions.ts';

const TUI_NAME = /^llmws-codex-relay-([0-9a-f]{8})$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codexRelayName(tuiName: string): string {
  const match = TUI_NAME.exec(tuiName);
  if (!match) throw new Error('invalid Fleet Codex tmux session');
  return `fleet-codex-relay-${match[1]}`;
}

export function codexRelaySocket(tuiName: string, home: string = homedir()): string {
  codexRelayName(tuiName);
  return join(home, '.llm-workspace', 'codex-relays', `${tuiName}.sock`);
}

export function codexDaemonSocket(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control', 'app-server-control.sock');
}

type ReadOption = (name: string, option: string) => string | null;
type HasSession = (name: string) => boolean;

function hasSession(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${name}:`], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function readOption(name: string, option: string): string | null {
  try {
    return execFileSync('tmux', ['show-options', '-v', '-t', `=${name}:`, option],
      { timeout: 5000 }).toString().trim();
  } catch { return null; }
}

/** An exact thread ID is valid only while both the TUI and its relay are
 * alive and the relay has observed a successful TUI switch. No cwd or
 * timestamp inference is involved. The injected functions are for tests. */
/** null: ordinary/legacy Codex process. false: Fleet relay TUI whose exact
 * thread is unavailable, which must never fall back to cwd guessing. */
export function codexRelayThreadForPid(pid: number, deps: {
  nameForPid?: (pid: number) => string | null;
  hasSession?: HasSession;
  readOption?: ReadOption;
} = {}): string | false | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const name = (deps.nameForPid ?? tmuxNameForPid)(pid);
  if (name === null || !TUI_NAME.test(name)) return null;
  const has = deps.hasSession ?? hasSession;
  if (!has(name) || !has(codexRelayName(name))) return false;
  const read = deps.readOption ?? readOption;
  if (read(name, '@llmws-codex-connected') !== '1') return false;
  const id = read(name, '@llmws-codex-thread');
  return id !== null && THREAD_ID.test(id) ? id : false;
}

/** How long to wait for a freshly launched Fleet Codex TUI to report the
 *  thread it opened.
 *
 *  Measured on this machine on 2026-09-28, launching exactly the way
 *  launchCodexSession does (daemon + relay + `codex -C <cwd> --remote
 *  unix://<socket>`): once the TUI is actually running, the id lands in
 *  @llmws-codex-thread 311ms later. So the happy case is well under a
 *  second, and 5s is ~16x that -- room for a cold binary or a busy daemon,
 *  and the same 5s waitForCodexRelaySocket below already uses, so this
 *  module has one number rather than two.
 *
 *  The number is small ON PURPOSE, because the case that blows through it
 *  is not slowness. In the same measurement the TUI sat on codex's own
 *  "Update available · 0.157.0 -> 0.157.1" prompt and opened NO thread at
 *  all until a key was pressed -- on both launches, 30s each. No timeout
 *  fixes that: it needs a person, and the person cannot answer until the
 *  session is on screen, which is what the caller is waiting to do. So the
 *  wait is sized for a TUI that is already running, and a TUI that is
 *  waiting on someone costs a few seconds and a message, not a freeze.
 *
 *  Only a launch that ASKED for a name ever pays this; exceeding it costs
 *  the name, never the session. */
const THREAD_ID_TIMEOUT_MS = 5_000;
/** One sweep costs a handful of tmux calls (a pid lookup, two has-session
 *  checks, two show-options), each synchronous, so this is deliberately not
 *  tight -- ~25 sweeps over the whole window rather than several hundred.
 *  Against the 311ms measured above it still resolves on the second or
 *  third sweep. */
const THREAD_ID_INTERVAL_MS = 200;

/** Waits for the relay to publish the exact thread id for a Fleet Codex
 *  TUI, for a caller that needs it right after launching one.
 *
 *  POLLED, and deliberately so: the relay is a separate process in its own
 *  tmux session with no channel back to Fleet except the tmux option it
 *  sets (setOption, src/main/codexRelay.ts), so there is no event to
 *  subscribe to. The id does not exist at spawn -- it appears only once the
 *  TUI has connected through the relay and the App Server has answered its
 *  thread/start -- so a caller that needs it has no choice but to wait.
 *
 *  A missing id is a plain null rather than a throw, and the caller decides
 *  what it costs. `false` from codexRelayThreadForPid ("a Fleet relay TUI
 *  whose thread is not known yet") is worth waiting through; `null` ("not a
 *  Fleet relay TUI at all") never becomes true, so it ends the wait at
 *  once. */
export async function waitForCodexThreadId(pid: number, timeoutMs = THREAD_ID_TIMEOUT_MS, deps: {
  thread?: (pid: number) => string | false | null;
  intervalMs?: number;
} = {}): Promise<string | null> {
  const read = deps.thread ?? (p => codexRelayThreadForPid(p));
  const interval = deps.intervalMs ?? THREAD_ID_INTERVAL_MS;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = read(pid);
    if (typeof found === 'string') return found;
    if (found === null || Date.now() >= until) return null;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** Called after the relay's tmux session starts, before launching the TUI.
 * `existsSync` alone could accept a half-created socket; require a socket
 * inode. The name is unique for every launch, so no stale instance can
 * satisfy this wait. */
export async function waitForCodexRelaySocket(path: string, timeoutMs = 5000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path)) {
      try { if (statSync(path).isSocket()) return true; }
      catch { /* removed between existsSync and statSync; retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}
