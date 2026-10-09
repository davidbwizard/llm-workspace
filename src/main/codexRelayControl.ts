import { execFile, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCodexBinding, CODEX_THREAD_ID, type CodexBinding } from '../core/codexRecovery.ts';
import { panePid } from './tmux.ts';
import { tmuxNameForPid } from './sessions.ts';

export const TUI_NAME = /^llmws-codex-relay-([0-9a-f]{8})$/;
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

export function relayHasSession(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${name}:`], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

export function relayReadOption(name: string, option: string): string | null {
  try {
    return execFileSync('tmux', ['show-options', '-v', '-t', `=${name}:`, option],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

export interface RelayBinding {
  name: string;
  threadId: string | null;
  ready: boolean;
  relayAlive: boolean;
  binding: CodexBinding | null;
}
type BindingDeps = {
  nameForPid?: (pid: number) => string | null;
  pidForName?: (name: string) => number | null;
  hasSession?: HasSession;
  readOption?: ReadOption;
};
/** Read one atomic binding. Legacy connected0 cannot authorize resume: it
 * could mean a rejected switch, rather than a physical socket loss. */
export function codexRelayBindingForPid(pid: number, deps: BindingDeps = {}): RelayBinding | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const name = (deps.nameForPid ?? tmuxNameForPid)(pid);
  if (!name || !TUI_NAME.test(name)) return null;
  const has = deps.hasSession ?? relayHasSession;
  const read = deps.readOption ?? relayReadOption;
  if (!has(name) || (deps.pidForName ?? panePid)(name) !== pid) return { name, threadId: null, ready: false, relayAlive: false, binding: null };
  const relayAlive = has(codexRelayName(name));
  const raw = read(name, '@llmws-codex-binding');
  const binding = parseCodexBinding(raw);
  if (raw !== null) return { name, binding, relayAlive, threadId: binding?.threadId ?? null,
    ready: relayAlive && binding?.state === 'ready' };
  const id = read(name, '@llmws-codex-thread');
  const legacyReady = read(name, '@llmws-codex-connected') === '1' && !!id && CODEX_THREAD_ID.test(id);
  return { name, binding: null, relayAlive, threadId: legacyReady ? id : null, ready: relayAlive && legacyReady };
}
type InputBindingRefusal = 'codex_not_ready' | 'codex_identity_required' | 'codex_identity_changed';
type AsyncTmuxRead = (args: string[]) => Promise<{ ok: boolean; stdout?: string }>;
const asyncTmuxRead: AsyncTmuxRead = args => new Promise(resolve => {
  execFile('tmux', args, { timeout: 5000, maxBuffer: 16 * 1024 }, (error, stdout) =>
    resolve(error ? { ok: false } : { ok: true, stdout }));
});
/** Final asynchronous sample: observer callbacks run while tmux reads the
 * current owned pane and atomic binding. The caller checks its observer in
 * the same JS turn after this resolves, with no later yield before input. */
export async function codexRelayInputRefusal(pid: number, name: string, expected: unknown,
  read: AsyncTmuxRead = asyncTmuxRead): Promise<InputBindingRefusal | null> {
  if (!Number.isInteger(pid) || pid <= 0 || !TUI_NAME.test(name)) return 'codex_not_ready';
  if (typeof expected !== 'string' || !CODEX_THREAD_ID.test(expected)) return 'codex_identity_required';
  if (!(await read(['has-session', '-t', `=${codexRelayName(name)}:`])).ok) return 'codex_not_ready';
  const result = await read(['display-message', '-p', '-t', `=${name}:`,
    '#{pane_pid}\n#{@llmws-codex-binding}\n#{@llmws-codex-connected}\n#{@llmws-codex-thread}']);
  if (!result.ok) return 'codex_not_ready';
  const lines = result.stdout?.trimEnd().split('\n');
  if (!lines || lines.length < 2 || lines.length > 4 || lines[0] !== String(pid)) return 'codex_not_ready';
  const raw = lines[1]!;
  if (raw) {
    const binding = parseCodexBinding(raw);
    if (!binding) return 'codex_not_ready';
    if (binding.threadId !== expected) return 'codex_identity_changed';
    return binding.state === 'ready' ? null : 'codex_not_ready';
  }
  if (lines[2] !== '1' || !lines[3] || !CODEX_THREAD_ID.test(lines[3])) return 'codex_not_ready';
  return lines[3] === expected ? null : 'codex_identity_changed';
}

/** false prevents Fleet sessions falling through to cwd/time inference.
 * Physical disconnect retains exact history identity but does not grant input. */
export function codexRelayThreadForPid(pid: number, deps: BindingDeps = {}): string | false | null {
  const binding = codexRelayBindingForPid(pid, deps);
  return binding ? binding.threadId ?? false : null;
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
