import { useSyncExternalStore } from 'react';
import type { PendingAttachment } from './pending.ts';

export type Draft = { text: string; attachments: PendingAttachment[]; sending: boolean; staging: number; message: string | null; interrupted: boolean };
const empty: Draft = { text: '', attachments: [], sending: false, staging: 0, message: null, interrupted: false };
type Cell = { value: Draft };
// Both PID and verified session ID are required. A validated replacement aliases
// the same cell so a late IPC result updates its successor without replaying it.
// shortcut: renderer drafts survive view changes only in memory, revisit when app-restart draft persistence is requested.
const cells = new Map<string, Cell>();
const listeners = new Set<() => void>();
const keyFor = (pid: number, sessionId: string) => `${pid}:${sessionId}`;
const emit = () => { for (const listener of listeners) listener(); };
function subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
function cellFor(pid: number, sessionId: string): Cell {
  const key = keyFor(pid, sessionId);
  let cell = cells.get(key);
  if (!cell) { cell = { value: empty }; cells.set(key, cell); }
  return cell;
}
export function updateDraft(pid: number, sessionId: string, update: (draft: Draft) => Draft): void {
  const cell = cellFor(pid, sessionId);
  cell.value = update(cell.value);
  emit();
}
export function useDraft(pid: number | null, sessionId: string | null): Draft {
  return useSyncExternalStore(subscribe, () => pid === null || !sessionId ? empty : cellFor(pid, sessionId).value);
}
export function remapDraft(previousPid: number, pid: number, sessionId: string): void {
  const previous = cells.get(keyFor(previousPid, sessionId));
  if (!previous) return;
  const successor = cells.get(keyFor(pid, sessionId));
  if (successor && successor !== previous) {
    const a = previous.value, b = successor.value;
    previous.value = { ...a, text: [a.text, b.text].filter(Boolean).join('\n'),
      attachments: [...a.attachments, ...b.attachments.filter(item => !a.attachments.some(old => old.id === item.id))],
      sending: a.sending || b.sending, staging: a.staging + b.staging, interrupted: a.interrupted || b.interrupted };
  }
  cells.set(keyFor(pid, sessionId), previous);
  emit();
}
// Empty, inactive cells can be removed; unsent or uncertain drafts are never
// evicted to meet a cache cap. Alias entries preserve outstanding IPC continuations.
export function pruneEmptyDrafts(): void {
  for (const [key, cell] of cells) {
    const d = cell.value;
    if (!d.text && !d.attachments.length && !d.sending && !d.staging && !d.interrupted && !d.message) cells.delete(key);
  }
}
export function clearDrafts(): void { cells.clear(); emit(); }
