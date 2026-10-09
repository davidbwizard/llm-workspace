import { randomUUID } from 'node:crypto';
import { CODEX_THREAD_ID, type CodexConnection, type CodexRecoveryResult, type CodexReplacement } from '../core/codexRecovery.ts';
import { TUI_NAME, type RelayBinding } from './codexRelayControl.ts';
import type { LaunchResult } from './launch.ts';

export const RECOVERY_OPTION = '@llmws-codex-recovery';
const NATIVE_GRACE_MS = 125_000;
const CONFIRM_MS = 30_000;
export interface RecoveryMetadata {
  v: 1;
  expectedThreadId?: string;
  nativeSince?: number;
  candidate?: string;
  candidateSince?: number;
  predecessor?: string;
  successor?: string;
  confirmed?: true;
  launchSince?: number;
}
export function parseRecoveryMetadata(raw: string | null): RecoveryMetadata | null {
  if (!raw || raw.length > 2048) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m.v !== 1 || (m.successor && (m.candidate || m.predecessor))) return null;
  for (const key of ['candidate', 'predecessor', 'successor'])
    if (m[key] !== undefined && (typeof m[key] !== 'string' || !TUI_NAME.test(m[key] as string))) return null;
  for (const key of ['nativeSince', 'candidateSince', 'launchSince'])
    if (m[key] !== undefined && (typeof m[key] !== 'number' || !Number.isSafeInteger(m[key]) || (m[key] as number) < 0)) return null;
  if (m.expectedThreadId !== undefined && (typeof m.expectedThreadId !== 'string' || !CODEX_THREAD_ID.test(m.expectedThreadId))) return null;
  if ((m.candidate || m.successor || m.predecessor) && !m.expectedThreadId) return null;
  if (m.confirmed !== undefined && (m.confirmed !== true || !m.predecessor)) return null;
  if (m.candidate && m.candidateSince === undefined) return null;
  return value as RecoveryMetadata;
}
export interface OwnedCodexTui { pid: number; name: string; cwd: string; binding: RelayBinding }
export interface RecoveryDeps {
  resolve: (pid: number) => OwnedCodexTui | null;
  resolveName: (name: string) => OwnedCodexTui | null;
  read: (name: string) => string | null;
  write: (name: string, value: string) => boolean;
  repair: (name: string, cwd: string) => Promise<void>;
  launch: (name: string, cwd: string, threadId: string, predecessor: string) => Promise<LaunchResult>;
  exhausted: (name: string) => boolean;
  inputPending?: (pid: number) => boolean;
  transferInput?: (previous: string, next: string, threadId: string) => boolean;
  now?: () => number;
  newName?: () => string;
  names?: () => string[];
}
/** Sweeps advance recovery without blocking Electron during the native 120s
 * retry window. Durable names allow an app restart to reuse an in-flight TUI. */
export class CodexRecovery {
  private inFlight = new Map<string, Promise<CodexRecoveryResult>>();
  private results = new Map<string, CodexRecoveryResult>();
  private repairAfter = new Map<string, number>();
  private known = new Set<string>();
  constructor(private readonly deps: RecoveryDeps) {}
  /** Display-only evaluation of one completed inventory. No cached fact is
   * installed in the coordinator used to authorize input or recovery. */
  inspect(pids: number[], deps: Pick<RecoveryDeps, 'resolve' | 'resolveName' | 'read' | 'names' | 'inputPending'>): {
    connections: Map<number, CodexConnection>; advancing: Set<number>; replacements: CodexReplacement[];
  } {
    const view = new CodexRecovery({ ...this.deps, ...deps });
    view.results = new Map(this.results);
    view.inFlight = new Map(this.inFlight);
    view.known = new Set(this.known);
    const connections = new Map<number, CodexConnection>();
    const advancing = new Set<number>();
    for (const pid of pids) {
      const connection = view.connection(pid);
      if (connection) connections.set(pid, connection);
      if (view.needsAdvance(pid)) advancing.add(pid);
    }
    const replacements = view.replacements();
    // A confirmed, ready successor owns automatic recovery now. Preserve
    // the predecessor's native draft without repeatedly advancing it.
    for (const replacement of replacements)
      if (connections.get(replacement.pid)?.state === 'ready') advancing.delete(replacement.previousPid);
    return { connections, advancing, replacements };
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private metadata(name: string): RecoveryMetadata {
    return parseRecoveryMetadata(this.deps.read(name)) ?? { v: 1 };
  }
  private save(name: string, m: RecoveryMetadata): void {
    if (!this.deps.write(name, JSON.stringify(m))) throw new Error('Could not persist Codex recovery state.');
  }
  /** The old allocator could leave successor+candidate together after a
   * successor closed. Retire only that proven absent link, preserving the
   * existing exact identity and candidate intent; the public parser stays strict. */
  private retiredSuccessor(tui: OwnedCodexTui, raw: string): RecoveryMetadata | null {
    if (raw.length > 2048 || !this.deps.names) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { successor, ...rest } = value as Record<string, unknown>;
    if (typeof successor !== 'string' || !TUI_NAME.test(successor) || successor === tui.name
      || rest.predecessor !== undefined || rest.confirmed !== undefined) return null;
    const m = parseRecoveryMetadata(JSON.stringify(rest));
    if (!m || !m.expectedThreadId || m.expectedThreadId !== tui.binding.threadId
      || m.candidate === successor || m.candidate === tui.name
      || (!parseRecoveryMetadata(raw) && !m.candidate)) return null;
    let names: string[];
    try { names = this.deps.names(); } catch { return null; }
    // Failed ownership resolution is not absence: a present but unresolved
    // successor retains its link and native draft until it can be verified.
    if (!names.includes(tui.name) || names.includes(successor)) return null;
    const fresh = this.deps.resolveName(tui.name);
    return fresh?.pid === tui.pid && fresh.binding.threadId === m.expectedThreadId
      && this.deps.read(tui.name) === raw ? m : null;
  }
  private replacement(old: OwnedCodexTui): OwnedCodexTui | null {
    const m = this.metadata(old.name);
    if (!m.successor || m.successor === old.name || !m.expectedThreadId || old.binding.threadId !== m.expectedThreadId) return null;
    const next = this.deps.resolveName(m.successor);
    if (!next || next.binding.threadId !== m.expectedThreadId) return null;
    const n = this.metadata(next.name);
    return n.confirmed === true && n.predecessor === old.name && n.expectedThreadId === m.expectedThreadId ? next : null;
  }
  replacements(): CodexReplacement[] {
    const found: CodexReplacement[] = [];
    for (const name of this.known) {
      const old = this.deps.resolveName(name);
      if (!old) {
        if (!this.inFlight.has(name)) { this.known.delete(name); this.results.delete(name); this.repairAfter.delete(name); }
        continue;
      }
      const next = this.replacement(old);
      if (next) found.push({ previousPid: old.pid, pid: next.pid, sessionId: next.binding.threadId! });
    }
    return found;
  }
  private candidateParents(name: string): { parents: { name: string; tui: OwnedCodexTui | null }[]; uncertain: boolean } {
    const parents: { name: string; tui: OwnedCodexTui | null }[] = [];
    let names: string[] = [];
    if (this.deps.names) {
      try { names = this.deps.names(); }
      catch { return { parents, uncertain: true }; }
      // An owned current pane cannot coexist with a trustworthy inventory
      // that omits it. A failed tmux listing must never admit a candidate.
      if (!names.includes(name)) return { parents, uncertain: true };
    }
    for (const parentName of new Set([...this.known, ...names])) {
      if (parentName === name || !TUI_NAME.test(parentName)) continue;
      const m = parseRecoveryMetadata(this.deps.read(parentName));
      if (m?.candidate !== name) continue;
      // Durable main-owned intent denies readiness even when fresh process
      // resolution fails. Live ownership is required only to complete it.
      this.known.add(parentName);
      parents.push({ name: parentName, tui: this.deps.resolveName(parentName) });
    }
    return { parents, uncertain: false };
  }
  connection(pid: number): CodexConnection | undefined {
    const tui = this.deps.resolve(pid);
    if (!tui) return undefined;
    this.known.add(tui.name);
    const m = this.metadata(tui.name);
    const { parents, uncertain } = this.candidateParents(tui.name);
    const predecessor = m.predecessor ? this.deps.resolveName(m.predecessor) : parents.length === 1 ? parents[0]!.tui : null;
    const validatedPrevious = predecessor && this.replacement(predecessor)?.name === tui.name ? predecessor.pid : undefined;
    const result = this.results.get(tui.name);
    // Candidate metadata does not grant readiness. Confirm both identity and
    // the durable links first; its Terminal remains available for native UI.
    const candidateUnconfirmed = uncertain || parents.length > 0 || (!!m.predecessor && m.confirmed !== true)
      || (this.deps.read(tui.name) !== null && !parseRecoveryMetadata(this.deps.read(tui.name))); 
    const recoveryTerminal = m.candidate ? this.deps.resolveName(m.candidate) : null;
    const ready = tui.binding.ready && !candidateUnconfirmed;
    return {
      state: ready ? 'ready' : result?.status === 'failed' ? 'failed'
        : result?.status === 'recovering' || this.inFlight.has(tui.name) ? 'recovering' : 'unknown',
      recoverable: !!tui.binding.threadId,
      ...(this.deps.inputPending?.(pid) || (candidateUnconfirmed && parents.some(parent => parent.tui && this.deps.inputPending?.(parent.tui.pid)))
        ? { inputPending: true } : {}),
      ...(!ready ? { reason: result && result.status !== 'ready' ? result.reason
        : candidateUnconfirmed ? 'Confirming the resumed conversation.' : 'Codex is reconnecting to its native terminal.' } : {}),
      ...(validatedPrevious !== undefined ? { previousTerminalPid: validatedPrevious } : {}),
      ...(recoveryTerminal ? { recoveryTerminalPid: recoveryTerminal.pid } : {}),
    };
  }
  needsAdvance(pid: number): boolean {
    const tui = this.deps.resolve(pid);
    if (!tui) return false;
    this.known.add(tui.name);
    const raw = this.deps.read(tui.name);
    if (raw !== null && !parseRecoveryMetadata(raw)) return true;
    const m = this.metadata(tui.name);
    const previous = m.predecessor ? this.deps.resolveName(m.predecessor) : null;
    const intent = this.candidateParents(tui.name);
    return !tui.binding.ready || !!m.candidate || intent.uncertain || intent.parents.length > 0 || m.nativeSince !== undefined
      || (!!m.predecessor && (m.confirmed !== true || !previous || previous.binding.threadId !== m.expectedThreadId));
  }
  /** Guards native input against a cached renderer selection or a recycled PID. */
  inputRefusal(pid: number, expected: unknown): 'codex_not_ready' | 'codex_identity_required' | 'codex_identity_changed' | null {
    const tui = this.deps.resolve(pid);
    if (!tui) return 'codex_not_ready';
    if (typeof expected !== 'string' || !CODEX_THREAD_ID.test(expected)) return 'codex_identity_required';
    if (tui.binding.threadId !== expected) return 'codex_identity_changed';
    return this.connection(pid)?.state === 'ready' ? null : 'codex_not_ready';
  }
  recover(pid: number): Promise<CodexRecoveryResult> {
    const tui = this.deps.resolve(pid);
    if (!tui) return Promise.resolve({ status: 'failed', reason: 'This Fleet Codex terminal is no longer running.' });
    this.known.add(tui.name);
    const current = this.inFlight.get(tui.name);
    if (current) return current;
    // Start on the next microtask so even synchronous injected operations
    // cannot finish before the coalescing entry has been installed.
    const work = Promise.resolve().then(() => this.advance(tui)).catch((error: unknown): CodexRecoveryResult => ({
      status: 'failed', reason: error instanceof Error ? error.message : String(error),
    })).then(result => { this.results.set(tui.name, result); return result; })
      .finally(() => { this.inFlight.delete(tui.name); });
    this.inFlight.set(tui.name, work);
    return work;
  }
  private async advance(initial: OwnedCodexTui): Promise<CodexRecoveryResult> {
    let tui = this.deps.resolveName(initial.name);
    if (!tui || tui.pid !== initial.pid) return { status: 'failed', reason: 'The native terminal changed during recovery.' };
    const raw = this.deps.read(tui.name);
    let m = parseRecoveryMetadata(raw);
    if (raw !== null && !m) {
      m = this.retiredSuccessor(tui, raw);
      if (!m) return { status: 'failed', reason: 'Codex recovery metadata is invalid; open the native terminal.' };
      this.save(tui.name, m);
    }
    m ??= { v: 1 };
    const { parents, uncertain } = this.candidateParents(tui.name);
    if (uncertain) return { status: 'failed', reason: 'The native terminal inventory could not be verified.' };
    if (parents.length > 1) return { status: 'failed', reason: 'Conflicting replacement intents could not be verified.' };
    if (parents.length === 1) return parents[0]!.tui ? this.recover(parents[0]!.tui.pid)
      : { status: 'failed', reason: 'The previous native terminal could not be verified.' };
    if (m.predecessor && m.confirmed !== true) {
      const previous = this.deps.resolveName(m.predecessor);
      if (previous && this.metadata(previous.name).candidate === tui.name) return this.recover(previous.pid);
      return { status: 'failed', reason: 'This resume terminal is not confirmed by its previous conversation.' };
    }
    const linked = this.replacement(tui);
    if (linked) return linked.binding.ready ? { status: 'ready', pid: linked.pid, sessionId: linked.binding.threadId! }
      : this.recover(linked.pid);
    if (m.successor) {
      const retired = raw === null ? null : this.retiredSuccessor(tui, raw);
      if (!retired) return { status: 'failed', reason: 'The previous replacement terminal could not be verified.' };
      m = retired;
      this.save(tui.name, m);
    }
    if (tui.binding.ready && !m.candidate) {
      if (m.confirmed && m.predecessor) {
        const old = this.deps.resolveName(m.predecessor);
        if (!old || old.binding.threadId !== m.expectedThreadId) { m = { v: 1 }; this.save(tui.name, m); }
      }
      if (m.nativeSince !== undefined) { const { nativeSince: _since, ...settled } = m; this.save(tui.name, settled); }
      return { status: 'ready', pid: tui.pid, sessionId: tui.binding.threadId! };
    }
    if (m.candidate) {
      if (!this.deps.resolveName(m.candidate) && this.now() - (m.launchSince ?? m.candidateSince!) >= 15_000) {
        m = { ...m, launchSince: this.now(), candidateSince: this.now() };
        this.save(tui.name, m);
        if (tui.binding.threadId !== m.expectedThreadId)
          return { status: 'failed', reason: 'The conversation changed before resume could be retried.' };
        const launched = await this.deps.launch(m.candidate!, tui.cwd, m.expectedThreadId!, tui.name);
        if (launched.status !== 'launched' && !this.deps.resolveName(m.candidate!))
          return { status: 'failed', reason: launched.reason };
      }
      return this.confirm(tui, m);
    }
    const now = this.now();
    if (m.nativeSince === undefined) {
      m = { ...m, nativeSince: now };
      this.save(tui.name, m);
    }
    if (!tui.binding.relayAlive && now >= (this.repairAfter.get(tui.name) ?? 0)) {
      this.repairAfter.set(tui.name, now + 15_000);
      await this.deps.repair(tui.name, tui.cwd);
      tui = this.deps.resolveName(tui.name);
      if (!tui || tui.pid !== initial.pid) return { status: 'failed', reason: 'The native terminal changed during recovery.' };
      if (tui.binding.ready) return { status: 'ready', pid: tui.pid, sessionId: tui.binding.threadId! };
    }
    if (now - m.nativeSince! < NATIVE_GRACE_MS && !this.deps.exhausted(tui.name))
      return { status: 'recovering', reason: 'Restoring the native Codex connection; its terminal draft is preserved.' };
    if (!tui.binding.threadId) return { status: 'failed', reason: 'Codex did not reconnect. Choose or resume the conversation in Terminal to establish its exact identity.' };
    // shortcut: retain one previous terminal; revisit when recovery can preserve a chain of native drafts.
    if (m.predecessor && this.deps.resolveName(m.predecessor))
      return { status: 'failed', reason: 'Codex did not reconnect. Retry in Terminal, or close the previous terminal before another replacement.' };
    const name = (this.deps.newName ?? (() => `llmws-codex-relay-${randomUUID().slice(0, 8)}`))();
    if (!TUI_NAME.test(name) || name === tui.name) throw new Error('Invalid generated recovery terminal name.');
    // Persist intent BEFORE launch: a restart never allocates a second candidate.
    m = { ...m, candidate: name, candidateSince: now, launchSince: now, expectedThreadId: tui.binding.threadId };
    this.save(tui.name, m);
    const fresh = this.deps.resolveName(tui.name);
    if (!fresh || fresh.pid !== tui.pid || fresh.binding.threadId !== m.expectedThreadId)
      return { status: 'failed', reason: 'The conversation changed before it could be resumed.' };
    const launched = await this.deps.launch(name, tui.cwd, m.expectedThreadId!, tui.name);
    if (launched.status !== 'launched' && !this.deps.resolveName(name))
      return { status: 'failed', reason: launched.reason };
    return this.confirm(tui, m);
  }
  private confirm(tui: OwnedCodexTui, m: RecoveryMetadata): CodexRecoveryResult {
    const candidate = this.deps.resolveName(m.candidate!);
    const fresh = this.deps.resolveName(tui.name);
    if (!fresh || fresh.pid !== tui.pid || fresh.binding.threadId !== m.expectedThreadId)
      return { status: 'failed', reason: 'The previous conversation identity changed during recovery.' };
    if (candidate?.binding.threadId && candidate.binding.threadId !== m.expectedThreadId)
      return { status: 'failed', reason: 'The replacement opened a different conversation. Both terminals are preserved.' };
    if (candidate?.binding.ready && candidate.binding.threadId === m.expectedThreadId) {
      const raw = this.deps.read(candidate.name);
      const own = raw === null ? { v: 1 } as RecoveryMetadata : parseRecoveryMetadata(raw);
      const { parents, uncertain } = this.candidateParents(candidate.name);
      if (!own || uncertain || parents.length !== 1 || parents[0]!.name !== tui.name
        || (own.predecessor !== undefined && own.predecessor !== tui.name)
        || (own.expectedThreadId !== undefined && own.expectedThreadId !== m.expectedThreadId)
        || own.candidate || own.successor)
        return { status: 'failed', reason: 'The replacement terminal could not be verified.' };
      if (own.predecessor === undefined) this.save(candidate.name,
        { v: 1, predecessor: tui.name, expectedThreadId: m.expectedThreadId });
      if (this.deps.transferInput?.(tui.name, candidate.name, m.expectedThreadId!) === false)
        return { status: 'failed', reason: 'The previous native draft could not be safely tracked on the replacement.' };
      this.save(candidate.name, { v: 1, predecessor: tui.name, expectedThreadId: m.expectedThreadId, confirmed: true });
      this.save(tui.name, { v: 1, successor: candidate.name, expectedThreadId: m.expectedThreadId });
      this.known.add(candidate.name);
      return { status: 'ready', pid: candidate.pid, sessionId: m.expectedThreadId! };
    }
    return this.now() - m.candidateSince! >= CONFIRM_MS
      ? { status: 'failed', reason: 'Codex resume is not confirmed. Open its terminal to answer any native startup prompt; your previous terminal and draft are preserved.' }
      : { status: 'recovering', reason: 'Confirming that Codex resumed the same conversation.' };
  }
}
