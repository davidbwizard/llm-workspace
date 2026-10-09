import { CODEX_THREAD_ID } from '../core/codexRecovery.ts';
import type { OwnedCodexTui } from './codexRecovery.ts';

export const CODEX_INPUT_OPTION = '@llmws-codex-input-pending';
type PendingInput = { v: 1; threadId: string; updatedAt: number };
function parsePending(raw: string | null): PendingInput | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const m = JSON.parse(raw) as Partial<PendingInput> | null;
    return m && m.v === 1 && typeof m.threadId === 'string' && CODEX_THREAD_ID.test(m.threadId)
      && typeof m.updatedAt === 'number' && Number.isSafeInteger(m.updatedAt) && m.updatedAt >= 0 ? m as PendingInput : null;
  } catch { return null; }
}
export interface CodexInputDeps {
  resolve: (pid: number) => OwnedCodexTui | null;
  resolveName: (name: string) => OwnedCodexTui | null;
  read: (name: string) => string | null;
  write: (name: string, value: string) => boolean;
  related: (tui: OwnedCodexTui) => string[];
}
/** Contains no text. A marker means input may already be in a native draft
 * or may have submitted before a transport error, so retry is not safe. */
export class CodexInput {
  constructor(private readonly deps: CodexInputDeps) {}
  pending(pid: number): boolean {
    const tui = this.deps.resolve(pid);
    return !!tui && this.names(tui).some(name => !!this.deps.read(name));
  }
  private names(tui: OwnedCodexTui): string[] {
    return [...new Set([tui.name, ...this.deps.related(tui)])]
      .filter(name => name === tui.name || this.deps.resolveName(name) !== null);
  }
  begin(pid: number, threadId: string): boolean {
    const tui = this.deps.resolve(pid);
    if (!tui || !CODEX_THREAD_ID.test(threadId) || tui.binding.threadId !== threadId || this.pending(pid)) return false;
    return this.deps.write(tui.name, JSON.stringify({ v: 1, threadId, updatedAt: Date.now() }));
  }
  /** Used after a successful submit, or an explicit native draft acknowledgement. */
  clear(pid: number, threadId: string): boolean {
    const tui = this.deps.resolve(pid);
    if (!tui || !CODEX_THREAD_ID.test(threadId) || tui.binding.threadId !== threadId) return false;
    const names = this.names(tui);
    for (const name of names) {
      const raw = this.deps.read(name);
      if (!raw) continue;
      const pending = parsePending(raw);
      if (!pending || pending.threadId !== threadId) return false;
    }
    for (const name of names) if (!this.deps.write(name, '')) return false;
    return true;
  }
  transfer(previous: string, next: string, threadId: string): boolean {
    const raw = this.deps.read(previous);
    if (!raw) return true;
    const pending = parsePending(raw);
    if (!pending || pending.threadId !== threadId) return false;
    return this.deps.write(next, raw);
  }
}
