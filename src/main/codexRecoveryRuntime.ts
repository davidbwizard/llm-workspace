import { parseCodexBinding, CODEX_THREAD_ID, type CodexConnection, type CodexReplacement } from '../core/codexRecovery.ts';
import { execFile, execFileSync } from 'node:child_process';
import { prepareCodexRelaySocket } from './codexRelaySocket.ts';
export { prepareCodexRelaySocket, validateRelaySocketNode } from './codexRelaySocket.ts';
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

type DisplayRead = (command: string, args: string[]) => Promise<string>;
const readDisplay: DisplayRead = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});
/** One asynchronous, coalesced inventory per discovery sweep. Frequent UI
 * pushes read only this snapshot; all outbound authority remains fresh. */
export class CodexRecoveryDisplay {
  private inFlight: Promise<void> | null = null;
  private connections = new Map<number, CodexConnection>();
  private threads = new Map<number, string | false>();
  private advancing = new Set<number>();
  private linked: CodexReplacement[] = [];
  constructor(private readonly coordinator: CodexRecovery, private readonly deps: {
    read?: DisplayRead; nameForPid?: (pid: number) => string | null;
  } = {}) {}
  connection(pid: number): CodexConnection | undefined {
    return codexConnectionForPid(pid, {
      connection: p => this.connections.get(p), nameForPid: this.deps.nameForPid ?? tmuxNameForPid,
    });
  }
  thread(pid: number): string | false | null {
    return this.threads.get(pid) ?? (TUI_NAME.test((this.deps.nameForPid ?? tmuxNameForPid)(pid) ?? '') ? false : null);
  }
  needsAdvance(pid: number): boolean { return this.advancing.has(pid); }
  replacements(): CodexReplacement[] { return this.linked; }
  refresh(afterMutation = false): Promise<void> {
    // A sweep already in progress may have sampled before the mutation.
    // Both its success and failure must be followed by a new inventory.
    if (afterMutation && this.inFlight)
      return this.inFlight.then(() => this.refresh(), () => this.refresh());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().catch((error: unknown) => {
      this.connections.clear(); this.threads.clear(); this.advancing.clear(); this.linked = [];
      throw error;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async load(): Promise<void> {
    const read = this.deps.read ?? readDisplay;
    const format = ['#{session_name}', '#{pane_pid}', '#{pane_current_path}', '#{@llmws-codex-binding}',
      '#{@llmws-codex-connected}', '#{@llmws-codex-thread}', `#{${RECOVERY_OPTION}}`, `#{${CODEX_INPUT_OPTION}}`].join('\t');
    const raw = await read('tmux', ['list-panes', '-a', '-F', format]);
    const panes = new Map<string, string[]>();
    for (const line of raw.split('\n')) {
      const fields = line.split('\t');
      if (fields.length === 8 && fields[0] && !panes.has(fields[0])) panes.set(fields[0], fields);
    }
    const candidates = [...panes].filter(([name, fields]) => TUI_NAME.test(name) && /^[1-9]\d*$/.test(fields[1]!));
    const processes = new Map<number, { command: string; args: string }>();
    if (candidates.length) {
      const output = await read('ps', ['-p', candidates.map(([, fields]) => fields[1]).join(','), '-o', 'pid=', '-o', 'comm=', '-o', 'args=']);
      for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (match) processes.set(Number(match[1]), { command: match[2]!, args: match[3]! });
      }
    }
    const owned = new Map<string, OwnedCodexTui>();
    for (const [name, fields] of candidates) {
      const pid = Number(fields[1]), cwd = fields[2]!;
      const proc = processes.get(pid);
      if (!Number.isSafeInteger(pid) || !proc || !cwd.startsWith('/') || cwd.includes('\0')
        || !/(?:^|[/\s])(?:codex(?:-[^/\s]+)?|node)$/.test(proc.command)
        || !/(?:^|[/\s])codex(?:\s|$)/.test(proc.args) || !proc.args.includes(`unix://${codexRelaySocket(name)}`)) continue;
      const binding = parseCodexBinding(fields[3]!);
      const relayAlive = panes.has(codexRelayName(name));
      const legacyReady = fields[4] === '1' && CODEX_THREAD_ID.test(fields[5]!);
      owned.set(name, { name, pid, cwd, binding: { name, binding, relayAlive,
        threadId: fields[3] ? binding?.threadId ?? null : legacyReady ? fields[5]! : null,
        ready: relayAlive && (fields[3] ? binding?.state === 'ready' : legacyReady),
      } });
    }
    const byPid = new Map([...owned.values()].map(tui => [tui.pid, tui]));
    const resolveName = (name: string) => owned.get(name) ?? null;
    const resolve = (pid: number) => byPid.get(pid) ?? null;
    const metadata = (name: string) => panes.get(name)?.[6] || null;
    const input = new CodexInput({ resolve, resolveName, read: name => panes.get(name)?.[7] || null,
      write: () => false, related: tui => {
        const m = parseRecoveryMetadata(metadata(tui.name));
        if (!m?.confirmed || !m.predecessor || m.expectedThreadId !== tui.binding.threadId) return [];
        const old = resolveName(m.predecessor);
        const previous = old ? parseRecoveryMetadata(metadata(old.name)) : null;
        return previous?.successor === tui.name && previous.expectedThreadId === m.expectedThreadId ? [old!.name] : [];
      } });
    const view = this.coordinator.inspect([...byPid.keys()], {
      resolve, resolveName, read: metadata, names: () => [...panes.keys()], inputPending: pid => input.pending(pid),
    });
    this.connections = view.connections; this.advancing = view.advancing; this.linked = view.replacements;
    this.threads = new Map([...byPid].map(([pid, tui]) => [pid, tui.binding.threadId ?? false]));
  }
}
export const codexDisplay = new CodexRecoveryDisplay(codexRecovery);
/** A missing tmux server must not prevent ordinary sessions from displaying.
 * refresh clears the snapshot before reporting failure, so this is fail-safe. */
export async function refreshCodexDisplay(afterMutation = false): Promise<void> {
  try { await codexDisplay.refresh(afterMutation); }
  catch (error) { console.error('Fleet Codex display inventory failed:', error); }
}

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
