import type { Db } from '../store/db.ts';
import type { Provider } from '../core/types.ts';
import { openBlockers, type Blocker } from '../store/signals.ts';
import { classifyMatch, type MatchQuality } from '../discovery/match.ts';
import type { LiveProcess } from '../discovery/parse.ts';

/** Is this run reachable? (spec §9.2) */
export type Lifecycle = 'active' | 'disconnected' | 'ended';
/** What is it doing? Current while active, LAST KNOWN while disconnected. */
export type Activity = 'working' | 'waiting_permission' | 'waiting_input' | 'idle' | 'error';

export interface SessionState {
  sessionId: string;
  runId: string | null;
  provider: Provider;
  cwd: string | null;
  project: string;
  lifecycle: Lifecycle;
  activity: Activity;
  /** True when the activity is last-known rather than current. */
  stale: boolean;
  confidence: 'exact' | 'likely' | 'guess';
  source: 'hook' | 'transcript' | 'process';
  lastProse: string | null;
  lastActivityAt: string | null;
  agents: number;
  liveAgents: number;
  events: number;
  blocker: Blocker | null;
  match: MatchQuality;
  candidates: number[];
  host: LiveProcess['host'] | null;
  /** Other session ids sharing this working directory (spec §9.5). */
  sharesWorktreeWith: string[];
}

const WORKING_MS = 20_000;
const ACTIVE_MS = 30 * 60_000;

export interface FleetOpts { now?: number; processes?: LiveProcess[] }

export function fleetState(db: Db, opts: FleetOpts = {}): SessionState[] {
  const now = opts.now ?? Date.now();

  // DEVIATION from the brief's SQL (see task-4-report.md for the write-up):
  //
  // 1. `cwd` and `run_id` are each read from the row belonging to the most
  //    RECENT matching event (`ORDER BY ts DESC, id DESC LIMIT 1`), not
  //    picked arbitrarily. The brief's `cwd` subquery had no ORDER BY at
  //    all -- when a session has more than one `session.started` row (a
  //    resumed session re-emits one per transcript file), SQLite is free to
  //    return any matching row, in practice the first one it scans, i.e.
  //    the OLDEST cwd. And the brief used `MAX(run_id)` for the run id,
  //    which is a lexicographic max over an opaque hash string
  //    (deriveRunId) -- it picks whichever run id sorts alphabetically
  //    highest, not whichever run is actually current. Both are fixed the
  //    same way as the brief's own `last_prose` subquery already did it
  //    correctly: order by ts (id as a tiebreaker) and take the top row.
  //
  // 2. `liveAgents` is a recency heuristic, not spawned-minus-ended.
  //    The brief hardcoded `liveAgents: 0` unconditionally, which spec
  //    §8.1's "agent pips (`2/8` live)" and §8.2's running-vs-finished
  //    distinction both need to be a real number. The first fix here tried
  //    spawned-minus-ended (`agent.ended`, spec §6.4) -- but no parser in
  //    this codebase emits `agent.ended` (checked against the real index:
  //    453 `agent.spawned`, 0 `agent.ended`), so that reduces to
  //    `liveAgents === agents` for every session, including ones idle for
  //    days. That is worse than the brief's hardcoded 0: 0 reads as "none
  //    running", but asserting every ever-spawned agent is live right now
  //    actively lies about the one thing this field exists to tell the
  //    user. Fixed instead with a recency heuristic: an agent counts as
  //    live only if ITS OWN most recent event (any kind, not just
  //    agent.spawned -- prose/tool.used/etc. from within that agent's own
  //    transcript all carry its agent_id) falls inside the same WORKING_MS
  //    window the session itself uses to call itself `working`, reusing
  //    that constant rather than introducing a second threshold. A stale
  //    session's own last_ts upper-bounds every one of its agents' last
  //    seen times, so an idle session reports 0 live agents by
  //    construction, never a stale-but-nonzero count. Once any parser
  //    starts emitting `agent.ended`, that is the exact signal that should
  //    replace this heuristic.
  const rows = db.prepare(`
    SELECT session_id, provider,
      MAX(ts) last_ts,
      COUNT(*) events,
      COUNT(DISTINCT CASE WHEN kind='agent.spawned' THEN agent_id END) agents,
      (SELECT c.run_id FROM events c
        WHERE c.session_id = e.session_id
        ORDER BY c.ts DESC, c.id DESC LIMIT 1) run_id,
      (SELECT json_extract(payload,'$.cwd') FROM events c
        WHERE c.session_id = e.session_id AND c.kind='session.started'
        ORDER BY c.ts DESC, c.id DESC LIMIT 1) cwd,
      (SELECT json_extract(payload,'$.text') FROM events p
        WHERE p.session_id = e.session_id AND p.kind='prose'
        ORDER BY p.ts DESC, p.id DESC LIMIT 1) last_prose
    FROM events e GROUP BY session_id, provider`).all() as any[];

  // Per-agent recency: the most recent event (any kind) carrying each
  // agent_id, across the whole index -- not scoped to agent.spawned rows,
  // since an agent's own prose/tool.used events are what show it is still
  // doing something. Paired with the spawned-agent-ids query below to
  // compute liveAgents per session (see the comment above).
  const agentLastSeen = new Map<string, string>(); // key: `${sessionId}:${agentId}`
  for (const r of db.prepare(`
    SELECT session_id, agent_id, MAX(ts) last_ts FROM events
    WHERE agent_id IS NOT NULL GROUP BY session_id, agent_id`).all() as any[]) {
    agentLastSeen.set(`${r.session_id}:${r.agent_id}`, r.last_ts);
  }
  const liveAgentsBySession = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT DISTINCT session_id, agent_id FROM events
    WHERE kind='agent.spawned' AND agent_id IS NOT NULL`).all() as any[]) {
    const lastTs = agentLastSeen.get(`${r.session_id}:${r.agent_id}`);
    const age = lastTs ? now - Date.parse(lastTs) : Infinity;
    if (age <= WORKING_MS) {
      liveAgentsBySession.set(r.session_id, (liveAgentsBySession.get(r.session_id) ?? 0) + 1);
    }
  }

  // `now` is passed through explicitly (see src/store/signals.ts) so a
  // caller pinning a fake clock -- as this fold's own tests do -- gets the
  // blocker window measured against that same clock, not the real one.
  const blockers = new Map<string, Blocker>();
  for (const b of openBlockers(db, undefined, now)) blockers.set(b.sessionId, b);

  // Worktree sharing: group by cwd before building states (spec §9.5).
  const byCwd = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.cwd) continue;
    byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r.session_id]);
  }

  const refs = rows.map(r => ({ sessionId: r.session_id as string, cwd: (r.cwd ?? null) as string | null }));
  const matches = classifyMatch(opts.processes ?? [], refs);
  const bySession = new Map<string, { quality: MatchQuality; pids: number[]; host: LiveProcess['host'] | null }>();
  for (const m of matches) {
    if (m.sessionId) bySession.set(m.sessionId, { quality: m.quality, pids: [m.pid], host: m.host });
    for (const c of m.candidates) {
      const prev = bySession.get(c);
      bySession.set(c, {
        quality: m.quality,
        pids: [...(prev?.pids ?? []), m.pid],
        host: prev?.host ?? m.host,
      });
    }
  }

  return rows.map(r => {
    const lastMs = r.last_ts ? Date.parse(r.last_ts) : 0;
    const age = now - lastMs;
    const blocker = blockers.get(r.session_id) ?? null;

    const lifecycle: Lifecycle = age <= ACTIVE_MS ? 'active' : 'disconnected';
    let activity: Activity;
    if (blocker) {
      activity = blocker.kind === 'PermissionRequest' ? 'waiting_permission' : 'waiting_input';
    } else if (age <= WORKING_MS) {
      activity = 'working';
    } else {
      activity = 'idle';
    }

    const m = bySession.get(r.session_id);
    const shared = (byCwd.get(r.cwd ?? '') ?? []).filter(id => id !== r.session_id);
    const agents = r.agents ?? 0;
    const liveAgents = liveAgentsBySession.get(r.session_id) ?? 0;
    // Explicitly typed, like lifecycle/activity above: the brief inlined
    // these two as bare ternaries in the returned object literal, which
    // typechecks fine on its own but not once the brief's own trailing
    // `.sort()` is chained onto this `.map()` -- with no annotation to
    // pin it, `.map()`'s inferred element type gets its string-literal
    // properties (confidence, source) widened to plain `string` before
    // `.sort()` runs, which then fails `npx tsc --noEmit` against the
    // declared `SessionState[]` return type.
    const confidence: SessionState['confidence'] = blocker ? 'exact' : 'guess';
    const source: SessionState['source'] = blocker ? 'hook' : 'transcript';

    return {
      sessionId: r.session_id,
      runId: r.run_id ?? null,
      provider: r.provider as Provider,
      cwd: r.cwd ?? null,
      project: r.cwd ? String(r.cwd).split('/').filter(Boolean).slice(-1)[0] ?? r.cwd : 'unknown',
      lifecycle,
      activity,
      stale: lifecycle === 'disconnected',
      confidence,
      source,
      lastProse: r.last_prose ?? null,
      lastActivityAt: r.last_ts ?? null,
      agents,
      liveAgents,
      events: r.events ?? 0,
      blocker,
      match: m?.quality ?? 'unknown',
      candidates: m?.pids ?? [],
      host: m?.host ?? null,
      sharesWorktreeWith: shared,
    };
  }).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
}
