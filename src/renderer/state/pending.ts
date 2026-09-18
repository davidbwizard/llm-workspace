import type { ConversationTurn } from '../../store/conversation.ts';

export type PendingAttachment = { id: string; name: string; kind: 'image' | 'file'; thumb: string | null };
export type Pending = {
  key: string;
  text: string;
  attachments: PendingAttachment[];
  sentAt: number;
  queued: boolean;
  idleMs: number;
  /** The session this entry was sent into, the same way the `drafts` store
   *  in ConversationView.tsx stamps a draft -- see its own doc comment for
   *  why the pid alone is not an identity: the OS reuses pid numbers, and an
   *  entry restored on the number alone would show one session's pending
   *  text in a different session's conversation once that pid is handed to
   *  a new process. null when the app could not identify the session at
   *  send time (an ambiguous or not-yet-matched pid), which pendingFor
   *  below never matches -- see its own doc comment for why. */
  sessionId: string | null;
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
 * Returns the pending messages for the given pid that were sent into the
 * session now on screen, or an empty array if none. Spec 4.4's "dropped
 * when the pid leaves the fleet" is delivered by this filter, not by an
 * active removal: once the pid is handed to a different session (or the
 * same pid resolves to a different sessionId for any other reason), the old
 * entries' stamp no longer matches and they simply stop being returned,
 * rather than lingering in whatever is now on screen.
 *
 * `sessionId` null (the app cannot identify the session now on screen)
 * never matches, even an entry ALSO stamped null -- mirrors drafts' own
 * draftFor in ConversationView.tsx: two different, both-unidentified
 * sessions at the same pid must not be treated as the same identity just
 * because neither could be pinned down.
 */
export function pendingFor(pid: number, sessionId: string | null): Pending[] {
  if (sessionId === null) return [];
  return (pending.get(pid) ?? []).filter(e => e.sessionId === sessionId);
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
 *
 * `used`, if given, is a set of turn ids this function has already matched on
 * an EARLIER call and must not match again. The `taken` set below only
 * enforces "each turn matches at most one entry" within this one call --
 * ConversationView re-runs matchPending from scratch, against the full turn
 * list, every time the page changes (a load-more prepend, or an unrelated
 * turn landing), so without `used` a turn that already consumed one entry on
 * a prior call is free to consume a DIFFERENT entry on the next one. Caller
 * owns the set (a ref, so it survives across renders) and must reset it
 * itself on a genuine session switch -- this function only ever adds to it.
 */
export function matchPending(list: Pending[], turns: ConversationTurn[], used?: Set<number>): string[] {
  const matched: string[] = [];
  const taken = new Set<string>();

  for (const t of turns) {
    if (t.role !== 'user') continue;
    if (used?.has(t.id)) continue;
    const ts = Date.parse(t.ts);
    if (!Number.isFinite(ts)) continue;

    const text = normalise(t.text);
    const hit = list.find(p => !taken.has(p.key) && ts >= p.sentAt - MATCH_SKEW_MS
      && (p.text === '' || text.includes(normalise(p.text))));

    if (hit) {
      taken.add(hit.key);
      used?.add(t.id);
      matched.push(hit.key);
    }
  }

  return matched;
}

/**
 * Advances the idleMs for every unmatched pending entry at the given pid.
 * This is called when rendering pending entries to track how long they have
 * been waiting to appear in the log. Each unmatched entry counts down
 * independently, so if one message is stuck while others match later,
 * it still warns when its countdown expires.
 */
export function tickIdle(pid: number, ms: number): void {
  const list = pending.get(pid);
  if (!list || list.length === 0) return;

  for (const entry of list) {
    entry.idleMs += ms;
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
