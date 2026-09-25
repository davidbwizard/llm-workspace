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
