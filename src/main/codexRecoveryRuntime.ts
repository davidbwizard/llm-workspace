import type { CodexConnection } from '../core/codexRecovery.ts';
import { execFileSync } from 'node:child_process';
import { lstatSync, unlinkSync, type Stats } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { CodexInput, CODEX_INPUT_OPTION } from './codexInput.ts';
import { CodexRecovery, parseRecoveryMetadata, RECOVERY_OPTION, type OwnedCodexTui } from './codexRecovery.ts';
import { codexRelayBindingForPid, codexRelaySocket, codexRelayName, relayHasSession, relayReadOption, TUI_NAME } from './codexRelayControl.ts';
import { panePid, capturePane, setSessionOption, listSessionNames } from './tmux.ts';
import { tmuxNameForPid } from './sessions.ts';
import { launchCodexResume, startCodexRelay } from './launch.ts';

/** Names are durable identity; the current pane PID/process and cwd are
 * read afresh before every recovery or input action. Never persist a PID. */
export function resolveOwnedCodexName(name: string): OwnedCodexTui | null {
  if (!TUI_NAME.test(name) || !relayHasSession(name)) return null;
  const pid = panePid(name);
  if (pid === null) return null;
  let args: string, command: string, cwd: string;
  try {
    args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 5000 }).toString().trim();
    command = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 5000 }).toString().trim();
    cwd = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}'],
      { timeout: 5000 }).toString().trim();
  } catch { return null; }
  const socket = codexRelaySocket(name);
  if (!/(?:^|[/\s])(?:codex(?:-[^/\s]+)?|node)$/.test(command)
    || !/(?:^|[/\s])codex(?:\s|$)/.test(args) || !args.includes(`unix://${socket}`)
    || !cwd.startsWith('/') || cwd.includes('\0')) return null;
  const binding = codexRelayBindingForPid(pid, { nameForPid: () => name });
  return binding ? { pid, name, cwd, binding } : null;
}
export function resolveOwnedCodexPid(pid: number): OwnedCodexTui | null {
  const name = tmuxNameForPid(pid);
  if (!name || !TUI_NAME.test(name)) return null;
  const owned = resolveOwnedCodexName(name);
  return owned?.pid === pid ? owned : null;
}
export function validateRelaySocketNode(stat: Stats, uid: number, directory: boolean, privateDirectory = true): void {
  if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & (directory && !privateDirectory ? 0o022 : 0o077)) !== 0
    || !(directory ? stat.isDirectory() : stat.isSocket()))
    throw new Error('The private Codex relay path has unsafe ownership or permissions.');
}
/** Remove only a proven stale, owned socket at the main-generated endpoint.
 * A live listener, symlink, foreign inode or ambiguous error is preserved. */
export async function prepareCodexRelaySocket(path: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Cannot verify ownership of the private Codex relay socket.');
  validateRelaySocketNode(lstatSync(dirname(dirname(path))), uid, true, false);
  validateRelaySocketNode(lstatSync(dirname(path)), uid, true);
  let inode: Stats;
  try { inode = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  validateRelaySocketNode(inode, uid, false);
  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('timeout', () => { probe.destroy(); reject(new Error('Cannot determine whether the Codex relay socket is live.')); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error('A live process already owns the Codex relay socket.');
  let current: Stats;
  try { current = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  validateRelaySocketNode(current, uid, false);
  if (current.ino !== inode.ino || current.dev !== inode.dev) throw new Error('The Codex relay socket changed during repair.');
  unlinkSync(path);
}

export const codexInput = new CodexInput({
  resolve: resolveOwnedCodexPid, resolveName: resolveOwnedCodexName,
  read: name => relayReadOption(name, CODEX_INPUT_OPTION),
  write: (name, value) => setSessionOption(name, CODEX_INPUT_OPTION, value).ok,
  related: tui => {
    const m = parseRecoveryMetadata(relayReadOption(tui.name, RECOVERY_OPTION));
    if (!m?.confirmed || !m.predecessor || m.expectedThreadId !== tui.binding.threadId) return [];
    const old = resolveOwnedCodexName(m.predecessor);
    const previous = old ? parseRecoveryMetadata(relayReadOption(old.name, RECOVERY_OPTION)) : null;
    return previous?.successor === tui.name && previous.expectedThreadId === m.expectedThreadId ? [old!.name] : [];
  },
});

export const codexRecovery = new CodexRecovery({
  resolve: resolveOwnedCodexPid,
  names: listSessionNames,
  resolveName: resolveOwnedCodexName,
  read: name => relayReadOption(name, RECOVERY_OPTION),
  write: (name, value) => setSessionOption(name, RECOVERY_OPTION, value).ok,
  repair: async (name, cwd) => {
    if (relayHasSession(codexRelayName(name))) return;
    await prepareCodexRelaySocket(codexRelaySocket(name));
    // Check again after the asynchronous liveness probe. A concurrent Fleet
    // instance may have restored this relay without us.
    if (relayHasSession(codexRelayName(name))) return;
    const fresh = resolveOwnedCodexName(name);
    if (!fresh) throw new Error('The native Codex terminal changed before relay repair.');
    await startCodexRelay(name, fresh.cwd);
  },
  launch: (name, cwd, threadId, previous) => launchCodexResume(cwd, threadId, name, previous, 100, 30),
  inputPending: pid => codexInput.pending(pid),
  transferInput: (previous, next, id) => codexInput.transfer(previous, next, id),
  exhausted: name => {
    const screen = capturePane(name, null);
    return screen.ok && screen.stdout.replace(/\s+/g, ' ').includes(
      'Automatic reconnect could not restore this session. Your draft is still editable.');
  },
});

/** Undefined identifies an unmanaged/native session. A known managed name
 * must remain explicitly unknown when fresh ownership resolution fails, so
 * the UI never mistakes an unresolved Fleet terminal for the ordinary path.
 * This metadata does not grant send/recovery authority; admission revalidates. */
export function codexConnectionForPid(pid: number, deps: {
  connection: (pid: number) => CodexConnection | undefined;
  nameForPid: (pid: number) => string | null;
} = { connection: pid => codexRecovery.connection(pid), nameForPid: tmuxNameForPid }): CodexConnection | undefined {
  const connection = deps.connection(pid);
  if (connection) return connection;
  const name = deps.nameForPid(pid);
  return name && TUI_NAME.test(name)
    ? { state: 'unknown', recoverable: false, reason: 'The managed Codex terminal could not be verified.' }
    : undefined;
}
