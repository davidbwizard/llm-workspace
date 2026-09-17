import type { Db } from '../store/db.ts';
import type { LiveProcess } from '../discovery/parse.ts';
import { deriveActivity, type OpenSession } from '../fleet/state.ts';
import type { LiveSessionRead } from '../providers/claude/liveSession.ts';
import { readLiveSession } from '../discovery/live.ts';
import { openBlockers } from '../store/signals.ts';
import { freshLiveSession, resolveReattachTarget } from './ipc.ts';

/** The pane's own three-way activity -- collapsed from fleet/state.ts's
 *  five-way Activity because the pane has neither a fleet card's blocker
 *  text nor a separate affordance for "a permission prompt" vs. "a
 *  question": both just mean the pane should show waiting. `error` reads
 *  as idle, since there is nothing further for the strip to say about it. */
export type LiveActivity = 'working' | 'idle' | 'waiting';

export type SessionLivePayload = {
  version: 1;
  pid: number;
  sessionId: string | null;
  /** null means the app cannot tell -- an unmatched pid, or a pid that
   *  matches no session. The pane shows no strip and starts no "not seen"
   *  countdown on it in that case, rather than guessing idle. */
  activity: LiveActivity | null;
  /** Epoch ms this working stretch began, or null when not working or
   *  unknown. Sourced differently per provider -- see the comment on its
   *  computation below for why. */
  since: number | null;
  events: number;
};

/** resolveReattachTarget's cache fallback (src/main/ipc.ts) and
 *  freshLiveSession's fresh re-read, both injectable so tests never touch
 *  real files or a real push-enrichment cache. `cached` defaults to []
 *  rather than requiring it: a pid resolved through the exact live-session
 *  path alone (freshLiveSession succeeding) never needs it, and this keeps
 *  the common call shape -- db, pid, processes, now -- usable on its own,
 *  the same way killSession/revealSession (src/main/ipc.ts) default their
 *  own injectable pieces to the real implementation. A real caller pushing
 *  this to the renderer should still pass its actual open-session cache,
 *  the same one ipc.ts's own resolveSessionForReattach uses
 *  (cachedPushOpenSessions), so a session that only resolves through the
 *  cwd-cache fallback (an ambiguous-but-launched-by-us Claude session, or
 *  any Codex session -- Codex writes no live-session file at all) is still
 *  found. */
export interface SessionLiveDeps {
  cached?: OpenSession[];
  read?: (pid: number) => LiveSessionRead;
}

/** Wraps `read` so a single buildSessionLive call never opens the same
 *  pid's live-session file twice -- resolveReattachTarget (below) and the
 *  direct freshLiveSession call both need a fresh read of the SAME pid,
 *  and the file cannot have changed between the two calls within one
 *  synchronous function body, so the second read is pure duplicated I/O. */
function memoizeRead(read: (pid: number) => LiveSessionRead): (pid: number) => LiveSessionRead {
  let cached: { pid: number; result: LiveSessionRead } | null = null;
  return (pid: number) => {
    if (cached && cached.pid === pid) return cached.result;
    const result = read(pid);
    cached = { pid, result };
    return result;
  };
}

/** One session's live state for the conversation pane -- working / idle /
 *  waiting, and when the current working stretch began. Task 5 of
 *  2026-09-17-live-conversation-feedback: built here, in main, so a later
 *  task can push it on the same fast (watcher/spool/ingest) cadence
 *  fleet:update already uses, rather than the 5s discovery interval the
 *  pane currently waits on.
 *
 *  Returns null only for a pid with no matching live process at all -- an
 *  unknown pid is not answered, mirroring freshLiveSession's own "not this
 *  process" guard. A live process that cannot be resolved to any session
 *  still gets an answer, with every session-derived field null (sessionId,
 *  activity, since) -- the app tried and genuinely cannot tell, which is a
 *  different fact from "this pid does not exist" and the caller (a later
 *  task) needs to tell the two apart to decide whether to show the pane at
 *  all. */
export function buildSessionLive(
  db: Db, pid: number, processes: LiveProcess[], now: number = Date.now(), deps: SessionLiveDeps = {},
): SessionLivePayload | null {
  const proc = processes.find(p => p.pid === pid);
  if (!proc) return null;

  const read = memoizeRead(deps.read ?? readLiveSession);
  // Same helper Reattach/Reply already trust for this exact question
  // (src/main/ipc.ts): exact live-session identity first, falling back to
  // the cwd-matched cache -- see this module's own SessionLiveDeps comment
  // for why `cached` defaults to [].
  const target = resolveReattachTarget(pid, { cached: deps.cached ?? [], processes, read });
  if (!target) return { version: 1, pid, sessionId: null, activity: null, since: null, events: 0 };

  // `last_kind`/`events` deliberately read every row for this session_id,
  // INCLUDING a Codex subagent thread's own rows (they share the root
  // thread's session_id but carry a non-null agent_id -- src/providers/
  // codex/parse.ts's threadAgentId). This matches fleetState's/
  // openSessionsLive's own last_kind subquery (src/fleet/state.ts)
  // exactly, unfiltered -- deriveActivity below is "the cards' activity
  // rule" (see its doc comment), and the pane must be fed the identical
  // signal or it could show a different state than the card for the same
  // session at the same instant.
  //
  // `last_prompt_ts` is scoped to `agent_id IS NULL` on purpose, NOT
  // matching that: it exists only to time "since" for a working Codex
  // session (below), and the pane shows only the root thread's own
  // messages (conversationFor, src/store/conversation.ts, applies the same
  // agent_id IS NULL scope for the same reason) -- a subagent dispatched
  // mid-turn can submit its own prompt.submitted row under the same
  // session_id, and timing "since" from THAT would show a start time that
  // does not correspond to anything the pane displays.
  const row = db.prepare(`
    SELECT COUNT(*) AS events, MAX(ts) AS last_ts,
      (SELECT k.kind FROM events k WHERE k.session_id = e.session_id
        ORDER BY k.ts DESC, k.id DESC LIMIT 1) AS last_kind,
      (SELECT p.ts FROM events p WHERE p.session_id = e.session_id AND p.kind = 'prompt.submitted'
          AND p.agent_id IS NULL
        ORDER BY p.ts DESC, p.id DESC LIMIT 1) AS last_prompt_ts
    FROM events e WHERE e.session_id = ?
  `).get(target.sessionId) as {
    events: number; last_ts: string | null; last_kind: string | null; last_prompt_ts: string | null;
  };

  const blocker = openBlockers(db, undefined, now).find(b => b.sessionId === target.sessionId) ?? null;
  const fresh = freshLiveSession(pid, processes, read);

  const { activity: rawActivity } = deriveActivity({
    lastTs: row.last_ts, lastKind: row.last_kind, blocker,
    // Always true: buildSessionLive only ever runs for a pid it has
    // already matched to this session, via resolveReattachTarget above --
    // by construction there IS a live process for it. The same
    // hasMatchedProcess: true openSessionsLive's own targeted enrichment
    // path uses for exactly this reason (src/fleet/state.ts).
    hasMatchedProcess: true,
    hasLiveSignal: processes.length > 0,
    now,
    liveStatus: fresh?.status ?? null,
  });

  // waiting_permission/waiting_input both read as "waiting" here -- the
  // pane has no separate UI for the two (see LiveActivity's doc comment
  // above); `error` reads as idle, since there is nothing further for the
  // strip to say about it.
  const activity: LiveActivity | null =
    rawActivity === 'waiting_permission' || rawActivity === 'waiting_input' ? 'waiting'
      : rawActivity === 'error' ? 'idle'
        : rawActivity;

  // `since` is sourced differently per provider because each has a
  // different notion of "when this turn started" available to it. Claude
  // Code's own status file timestamps the moment it flipped busy
  // (statusUpdatedAtMs, src/providers/claude/liveSession.ts) -- more
  // precise than the transcript (no ingest lag) and the only signal at all
  // for a Claude session with no prompt event ingested yet, right after
  // launch or a /clear. Codex writes no live-session file, so the last
  // root-thread prompt (last_prompt_ts, scoped above) is the only
  // timestamp there is -- and sufficient, since a Codex turn only ever
  // starts from exactly one prompt.
  const since = activity !== 'working' ? null
    : target.provider === 'claude'
      ? (fresh?.status === 'busy' ? fresh.statusUpdatedAtMs ?? null : null)
      : (row.last_prompt_ts ? Date.parse(row.last_prompt_ts) : null);

  return { version: 1, pid, sessionId: target.sessionId, activity, since, events: row.events ?? 0 };
}
