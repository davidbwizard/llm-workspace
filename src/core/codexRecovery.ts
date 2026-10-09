/** Native TUI readiness is independent of the observer's prompt connection. */
export interface CodexConnection {
  state: 'ready' | 'recovering' | 'failed' | 'unknown';
  recoverable: boolean;
  reason?: string;
  previousTerminalPid?: number;
  recoveryTerminalPid?: number;
  inputPending?: boolean;
}
export interface CodexReplacement { previousPid: number; pid: number; sessionId: string }
export type CodexRecoveryResult =
  | { status: 'ready'; pid: number; sessionId: string }
  | { status: 'recovering' | 'failed'; reason: string };

export const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface CodexBinding {
  v: 1;
  state: 'ready' | 'disconnected' | 'switching' | 'unknown';
  threadId: string | null;
  updatedAt: number;
}
export function parseCodexBinding(raw: string | null): CodexBinding | null {
  if (!raw || raw.length > 1024) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || !['ready', 'disconnected', 'switching', 'unknown'].includes(String(v.state))
    || typeof v.updatedAt !== 'number' || !Number.isSafeInteger(v.updatedAt) || v.updatedAt < 0) return null;
  if (v.threadId !== null && (typeof v.threadId !== 'string' || !CODEX_THREAD_ID.test(v.threadId))) return null;
  if ((v.state === 'ready' && v.threadId === null)
    || ((v.state === 'switching' || v.state === 'unknown') && v.threadId !== null)) return null;
  return value as CodexBinding;
}

export type CodexInputClearResult = { status: 'cleared' }
  | { status: 'refused'; reason: 'invalid' | 'stale' | 'unavailable' };
