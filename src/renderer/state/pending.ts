import type { ConversationTurn } from '../../store/conversation.ts';

export type PendingAttachment = { id: string; name: string; kind: 'image' | 'file'; thumb: string | null };
export type Pending = {
  key: string;
  text: string;
  attachments: PendingAttachment[];
  sentAt: number;
  queued: boolean;
  idleMs: number;
};

export const MATCH_SKEW_MS = 2_000;
export const NOT_SEEN_AFTER_MS = 15_000;

// Module-level store keyed by process id, holding arrays of pending messages
// for each pid. Persists across renders to preserve pending sends across session
// switches, similar to the drafts pattern in ConversationView.
const pending = new Map<number, Pending[]>();

// Generate a unique key for each pending entry. Uses timestamp and a small counter
// to ensure keys are unique even when messages are sent in rapid succession.
let keyCounter = 0;
function makeKey(): string {
  return `p-${Date.now()}-${++keyCounter}`;
}

/**
 * Adds a pending message for the given pid. Returns the generated key.
 */
export function addPending(pid: number, p: Omit<Pending, 'key' | 'idleMs'>): string {
  const key = makeKey();
  const entry: Pending = { ...p, key, idleMs: 0 };

  if (!pending.has(pid)) {
    pending.set(pid, []);
  }
  pending.get(pid)!.push(entry);

  return key;
}

/**
 * Returns all pending messages for the given pid, or an empty array if none.
 */
export function pendingFor(pid: number): Pending[] {
  return pending.get(pid) ?? [];
}

/**
 * Removes a single pending entry by key from the given pid.
 */
export function dropPending(pid: number, key: string): void {
  const list = pending.get(pid);
  if (!list) return;

  const idx = list.findIndex(e => e.key === key);
  if (idx !== -1) {
    list.splice(idx, 1);
  }
}

/**
 * Clears all pending entries. If pid is provided, clears only that pid's entries;
 * otherwise clears all pids. Exists for test isolation and has no production caller.
 */
export function clearPending(pid?: number): void {
  if (pid === undefined) {
    pending.clear();
  } else {
    pending.delete(pid);
  }
}

/**
 * Normalises text for matching: collapses whitespace runs to single spaces and trims.
 * This handles the fact that the log may have reformatted line breaks and other
 * whitespace when it recorded the message.
 */
export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Matches pending entries against conversation turns. Walks turns oldest-first and
 * for each user turn takes the oldest unmatched entry that satisfies both rules,
 * ensuring each turn consumes at most one entry.
 *
 * Rules:
 * 1. Turn must be from a user (not assistant).
 * 2. Turn's timestamp must be within MATCH_SKEW_MS of the pending send time.
 * 3. The turn's text must contain the pending message text (normalised), or
 *    the pending message is empty (attachment-only sends match on time alone).
 *
 * The log may add image markers like "[Image #1]" and file-path prefixes when
 * recording the message, so we use "contains" matching rather than equality.
 * This lets a single pending entry match even if Codex added context around it.
 */
export function matchPending(list: Pending[], turns: ConversationTurn[]): string[] {
  const matched: string[] = [];
  const taken = new Set<string>();

  for (const t of turns) {
    if (t.role !== 'user') continue;
    const ts = Date.parse(t.ts);
    if (!Number.isFinite(ts)) continue;

    const text = normalise(t.text);
    const hit = list.find(p => !taken.has(p.key) && ts >= p.sentAt - MATCH_SKEW_MS
      && (p.text === '' || text.includes(normalise(p.text))));

    if (hit) {
      taken.add(hit.key);
      matched.push(hit.key);
    }
  }

  return matched;
}

/**
 * Advances the idleMs for the oldest pending entry at the given pid.
 * This is called when rendering pending entries to track how long they have
 * been waiting to appear in the log. Only the first (oldest) entry is updated;
 * other entries remain unchanged until their turn comes.
 */
export function tickIdle(pid: number, ms: number): void {
  const list = pending.get(pid);
  if (!list || list.length === 0) return;

  const first = list[0];
  if (first) {
    first.idleMs += ms;
  }
}

/**
 * Sets the queued flag for a pending entry. Called after main replies with
 * whether the send was queued due to the agent being busy.
 */
export function markQueued(pid: number, key: string, queued: boolean): void {
  const list = pending.get(pid);
  if (!list) return;

  const entry = list.find(e => e.key === key);
  if (entry) {
    entry.queued = queued;
  }
}
