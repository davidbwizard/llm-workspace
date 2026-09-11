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
  // 2. `agents`/`live_agents` are two separate aggregates instead of one.
  //    The brief hardcoded `liveAgents: 0` unconditionally. Spec §8.1
  //    requires "agent pips (`2/8` live)" and §8.2 requires distinguishing
  //    running agents (full opacity + pulse) from finished ones (dimmed) --
  //    a fleet card genuinely needs this number, and 0 is wrong the moment
  //    any agent has been spawned. `agent.ended` is defined in the event
  //    vocabulary (spec §6.4, `SubagentStop` / transcript) but has no
  //    writer yet anywhere in this codebase, so today `live_agents` reduces
  //    to `agents` (every spawned agent, absent any end signal, is exactly
  //    as running as the spec's default state assumes) -- but the fold
  //    computes it correctly rather than hardcoding today's degenerate
  //    case, so nothing here needs to change once a writer exists.
  const rows = db.prepare(`
    SELECT session_id, provider,
      MAX(ts) last_ts,
      COUNT(*) events,
      COUNT(DISTINCT CASE WHEN kind='agent.spawned' THEN agent_id END) agents,
      COUNT(DISTINCT CASE WHEN kind='agent.ended' THEN agent_id END) ended_agents,
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
    const liveAgents = Math.max(0, agents - (r.ended_agents ?? 0));
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
