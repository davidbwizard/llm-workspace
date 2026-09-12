import type { Db } from '../store/db.ts';
import type { Provider } from '../core/types.ts';
import { openBlockers, type Blocker } from '../store/signals.ts';
import { classifyMatch, type MatchQuality, type MatchResult } from '../discovery/match.ts';
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
  /** True when a live process (discovery, spec §7.1a) is matched UNIQUELY
   *  to this session -- i.e. `match === 'unique'`. `cwd` only resolves to a
   *  project directory, not to a specific session file, so on a real
   *  workspace where several sessions share a repo the match is usually
   *  `ambiguous` (several sessions, one live process, no way to tell which
   *  one it belongs to): `alive` is false for every one of them in that
   *  case, deliberately -- a fact that cannot be attributed to a specific
   *  session must not be printed as if it were that session's own. Process
   *  liveness plays no part in FleetView's grouping (that is transcript
   *  recency, `lifecycle`/`activity`); this field exists only so a card can
   *  show attributable process detail (age/memory below) when it has it. */
  alive: boolean;
  /** Seconds the matched process has been running -- from the OLDEST
   *  matched process when more than one pid matches this session. Null
   *  when not `alive` (including an ambiguous match -- see `alive` above),
   *  or when `ps` couldn't report it. */
  processAgeSeconds: number | null;
  /** Resident memory of that same (oldest) matched process, in bytes. Null
   *  under the same conditions as processAgeSeconds. */
  processRssBytes: number | null;
  /** Other session ids sharing this working directory (spec §9.5). */
  sharesWorktreeWith: string[];
}

const WORKING_MS = 20_000;
const ACTIVE_MS = 30 * 60_000;

/** Last path segment of a working directory, or 'unknown' with none --
 *  shared between fleetState's session rows and openSessions' process
 *  rows below, which each derive a project name from a cwd of their own
 *  (a session's from its transcript, a process's from `lsof`). */
function projectName(cwd: string | null): string {
  return cwd ? cwd.split('/').filter(Boolean).slice(-1)[0] ?? cwd : 'unknown';
}

/** Event kinds that mean the agent handed control back and is now waiting on
 *  the user. Activity is derived from WHICH event happened last, not from how
 *  long ago it was: an agent mid-tool-call or mid-generation writes nothing for
 *  minutes, and the previous age-based rule (any event within 20s) reported one
 *  session working while five genuinely were. `turn.completed` covers 854 of
 *  877 sessions in the real index, so it is a reliable boundary. */
const TURN_END_KINDS = new Set(['turn.completed', 'session.ended']);

/** Turn-boundary/lifecycle derivation -- the exact rule fleetState's own
 *  per-row map uses below, factored out so the targeted open-session
 *  enrichment path (openSessionsLive, further down) computes activity
 *  identically rather than a second implementation that could quietly
 *  drift from this one. */
function deriveActivity(opts: {
  lastTs: string | null; lastKind: string | null; blocker: Blocker | null;
  hasMatchedProcess: boolean; hasLiveSignal: boolean; now: number;
}): { lifecycle: Lifecycle; activity: Activity } {
  const lastMs = opts.lastTs ? Date.parse(opts.lastTs) : 0;
  const age = opts.now - lastMs;
  const lifecycle: Lifecycle = age <= ACTIVE_MS ? 'active' : 'disconnected';
  let activity: Activity;
  if (opts.blocker) {
    activity = opts.blocker.kind === 'PermissionRequest' ? 'waiting_permission' : 'waiting_input';
  } else if (lifecycle === 'active' && !TURN_END_KINDS.has(opts.lastKind ?? '') &&
    (opts.hasMatchedProcess || !opts.hasLiveSignal)) {
    // A session killed mid-turn never emits a turn boundary and would
    // otherwise look like it is thinking forever -- a matched process is
    // what tells the two apart. This deliberately uses match PRESENCE
    // (`hasMatchedProcess`), not unique attribution: an ambiguous match
    // still means a live process exists at this session's cwd, which is
    // exactly what this check needs to know, and requiring unique
    // attribution here would wrongly demote a genuinely-working session to
    // idle merely because its cwd is shared -- the common case on a real
    // workspace. `!hasLiveSignal` is the escape hatch for when discovery
    // itself produced nothing at all this sweep: a dead session can never
    // be `working` when discovery is actually working, but a broken
    // discovery toolchain must not be able to empty the whole working
    // group either.
    activity = 'working';
  } else {
    activity = 'idle';
  }
  return { lifecycle, activity };
}

/** Picks the oldest of several processes matched to one session ("if
 *  several processes match, use the oldest"). A missing ageSeconds (ps
 *  couldn't report it) is modelled as -1 -- below every real elapsed time
 *  (always >= 0) but still above "no candidate yet", so a lone
 *  unknown-age process is still picked over picking nothing. */
function oldestProcess(procs: LiveProcess[]): LiveProcess | null {
  return procs.reduce<LiveProcess | null>((oldest, p) => {
    if (!oldest) return p;
    return (p.ageSeconds ?? -1) > (oldest.ageSeconds ?? -1) ? p : oldest;
  }, null);
}

/** sessionSummaries' row shape -- named so FleetOpts.precomputedSummaries
 *  below can reference it without exporting sessionSummaries itself. */
interface SessionSummaryRow { session_id: string; provider: string; last_ts: string | null; cwd: string | null }

export interface FleetOpts {
  now?: number;
  processes?: LiveProcess[];
  /** Restricts the expensive per-row work below (the four correlated
   *  subqueries, and the liveAgents scan) to exactly these session ids --
   *  everything else about the call (matching against `processes`,
   *  worktree-sharing) still sees every session, via sessionSummaries
   *  below, because both of those are inherently global: a session NOT in
   *  this list can still be the thing that makes another session's match
   *  'ambiguous' or its sharesWorktreeWith non-empty. Omitted (the
   *  default): every session gets full treatment, unchanged from before
   *  this option existed -- see fleetStatePage for the paginated caller
   *  this exists for. */
  sessionIds?: string[];
  /** Internal -- set only by fleetStatePage, which already ran
   *  sessionSummaries once to rank the page it is requesting. Without
   *  this, fleetState would run that same ~130ms query a SECOND time
   *  (measured against the real index) purely for the global matching/
   *  worktree-sharing context sessionIds triggers below, doubling
   *  fleetStatePage's cost for no new information -- caught by timing
   *  fleetStatePage directly, not by guesswork. Not meant for any other
   *  caller: passing a summary set that does not match what `db` actually
   *  holds right now would silently corrupt matching/sharing for this
   *  call, so ordinary callers should always omit it and let fleetState
   *  fetch its own. */
  precomputedSummaries?: SessionSummaryRow[];
}

/** Cheap per-session summary -- session_id, provider, last activity, and
 *  cwd -- WITHOUT the three other correlated subqueries fleetState's own
 *  main query also runs (run_id, last_prose, last_kind) or its liveAgents/
 *  blocker/events-count work. Exists for two things that are inherently
 *  global regardless of how many sessions a caller actually wants full
 *  detail for: ranking sessions by recency (fleetStatePage's pagination)
 *  and giving fleetState's matching/worktree-sharing logic every session's
 *  cwd even when `opts.sessionIds` restricts the expensive part to a page.
 *  Measured against the real index (878 sessions): ~130ms -- real cost,
 *  not free, but paid once per on-demand fleet:history request, never on
 *  the fleet:list/fleet:update path (see buildFleetListPayload's and
 *  pushFleet's doc comments in src/main/ipc.ts). */
function sessionSummaries(db: Db): SessionSummaryRow[] {
  return db.prepare(`
    SELECT session_id, provider, MAX(ts) last_ts,
      (SELECT json_extract(payload,'$.cwd') FROM events c
        WHERE c.session_id = e.session_id AND c.kind='session.started'
        ORDER BY c.ts DESC, c.id DESC LIMIT 1) cwd
    FROM events e GROUP BY session_id, provider`).all() as any[];
}

export function fleetState(db: Db, opts: FleetOpts = {}): SessionState[] {
  const now = opts.now ?? Date.now();
  // An explicit empty list means "no sessions requested" -- short-circuit
  // rather than run `WHERE session_id IN ()` (matches nothing anyway, but
  // pointlessly) or, worse, an unfiltered query if the placeholder list
  // below were built wrong for zero elements.
  if (opts.sessionIds && opts.sessionIds.length === 0) return [];
  const idFilter = opts.sessionIds ? `WHERE e.session_id IN (${opts.sessionIds.map(() => '?').join(',')})` : '';
  const idParams = opts.sessionIds ?? [];

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
        ORDER BY p.ts DESC, p.id DESC LIMIT 1) last_prose,
      (SELECT k.kind FROM events k
        WHERE k.session_id = e.session_id
        ORDER BY k.ts DESC, k.id DESC LIMIT 1) last_kind
    FROM events e ${idFilter} GROUP BY session_id, provider`).all(...idParams) as any[];

  // Per-agent recency + spawn membership, merged into one scan (review:
  // the two separate unindexed full scans over `events` -- one for
  // MAX(ts) per (session, agent), one for which ids were ever spawned --
  // both did the same GROUP BY session_id, agent_id, just on two separate
  // passes. `agent_id` and `kind` are both unindexed, so each pass cost a
  // full table scan of the whole events table; merging drops the
  // render-loop path from three scans to two. `MAX(kind = 'agent.spawned')`
  // is a boolean-as-integer aggregate: 1 if this (session, agent) pair
  // ever had an agent.spawned row, else 0 -- the same "ever spawned" test
  // the separate query made, now folded into the same GROUP BY as the
  // recency MAX(ts). liveAgents semantics are unchanged: an agent counts
  // as live only if it was ever spawned AND its own most recent event
  // (any kind, not just agent.spawned) falls inside WORKING_MS of `now`.
  const liveAgentsBySession = new Map<string, number>();
  const agentIdFilter = opts.sessionIds ? `AND session_id IN (${opts.sessionIds.map(() => '?').join(',')})` : '';
  for (const r of db.prepare(`
    SELECT session_id, agent_id, MAX(ts) last_ts, MAX(kind = 'agent.spawned') spawned
    FROM events WHERE agent_id IS NOT NULL ${agentIdFilter}
    GROUP BY session_id, agent_id`).all(...idParams) as any[]) {
    if (!r.spawned) continue; // never had an agent.spawned row -- not a countable agent
    const age = r.last_ts ? now - Date.parse(r.last_ts) : Infinity;
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
  // Restricted to REACHABLE sessions (lifecycle 'active', the same
  // reachability test the lifecycle field itself uses below) -- spec §9.5
  // is about contention, two sessions that could actually clobber each
  // other's work right now, not "N sessions have ever run in this
  // directory" trivia. A disconnected session cannot be mid-edit, so it is
  // neither a contender nor worth warning about; a card for one reports no
  // sharing even if the same directory has plenty of history. Sessions with
  // no cwd (never saw a session.started) cannot be matched to a directory
  // at all.
  // Both worktree-sharing and process matching are inherently global: a
  // session excluded from `rows` by opts.sessionIds can still be the
  // reason another (included) session's sharesWorktreeWith is non-empty or
  // its match is 'ambiguous' rather than 'unique'. So when sessionIds
  // restricted `rows` above, these two are built from sessionSummaries'
  // full, unfiltered set instead -- the one extra query fleetStatePage's
  // paginated callers pay, not something the default (unfiltered) call
  // pays twice for.
  const globalRows = opts.sessionIds ? (opts.precomputedSummaries ?? sessionSummaries(db)) : rows;

  const isReachable = (r: any) => (now - (r.last_ts ? Date.parse(r.last_ts) : 0)) <= ACTIVE_MS;
  const byCwd = new Map<string, string[]>();
  for (const r of globalRows) {
    if (!r.cwd || !isReachable(r)) continue;
    byCwd.set(r.cwd, [...(byCwd.get(r.cwd) ?? []), r.session_id]);
  }

  const refs = globalRows.map(r => ({ sessionId: r.session_id as string, cwd: (r.cwd ?? null) as string | null }));
  const matches = classifyMatch(opts.processes ?? [], refs);
  const bySession = new Map<string, { quality: MatchQuality; pids: number[]; host: LiveProcess['host'] | null }>();
  // Iterating `m.candidates` alone covers BOTH cases: for a `unique` match,
  // classifyMatch sets `candidates` to the single-element array
  // `[m.sessionId]` -- the same id, not a second one -- so a separate
  // `if (m.sessionId)` branch here would insert that pid a second time for
  // the same session (a latent bug: `processes` was always `[]` before this
  // task wired discovery in, so nothing ever exercised this path). For
  // `ambiguous`, `candidates` already lists every session sharing the pid's
  // cwd, which is exactly what should accumulate pids across matches.
  for (const m of matches) {
    for (const c of m.candidates) {
      const prev = bySession.get(c);
      bySession.set(c, {
        quality: m.quality,
        pids: [...(prev?.pids ?? []), m.pid],
        host: prev?.host ?? m.host,
      });
    }
  }

  const pidToProcess = new Map<number, LiveProcess>();
  for (const p of opts.processes ?? []) pidToProcess.set(p.pid, p);

  // Spec §7.1a: process discovery is enrichment, never a filter. A sweep
  // that found NO processes anywhere -- not just none for a particular
  // session -- is far more likely a broken pgrep/ps/lsof toolchain than a
  // machine with genuinely zero live provider processes, so it must not be
  // allowed to silently demote every currently-working session to idle.
  // The WORKING determination below falls back to the prior
  // turn-boundary-only rule rather than trusting process-match presence
  // when there is no live signal at all.
  const hasLiveSignal = (opts.processes ?? []).length > 0;

  return rows.map(r => {
    const blocker = blockers.get(r.session_id) ?? null;

    const m = bySession.get(r.session_id);
    const matchedProcs = (m?.pids ?? [])
      .map(pid => pidToProcess.get(pid))
      .filter((p): p is LiveProcess => p !== undefined);
    // `alive` (and the age/memory it gates below) requires a UNIQUE match:
    // `cwd` only resolves to a directory, and on a real workspace several
    // sessions commonly share one, so `matchedProcs.length > 0` alone is
    // not enough to say THIS session's process is confirmed running --
    // only that some session sharing its cwd has one. Printing age/memory
    // (or `alive: true`) on every session in that ambiguous group would be
    // attributing one process's facts to sessions it may not belong to.
    const hasMatchedProcess = matchedProcs.length > 0;
    const alive = hasMatchedProcess && m?.quality === 'unique';
    const oldest = m?.quality === 'unique' ? oldestProcess(matchedProcs) : null;

    const { lifecycle, activity } = deriveActivity({
      lastTs: r.last_ts, lastKind: r.last_kind, blocker, hasMatchedProcess, hasLiveSignal, now,
    });

    // Symmetric with the byCwd filter above: a disconnected session is not
    // itself a contender, so it reports no sharing even if OTHER active
    // sessions happen to share its (last-known) cwd.
    const shared = lifecycle === 'active'
      ? (byCwd.get(r.cwd ?? '') ?? []).filter(id => id !== r.session_id)
      : [];
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
      project: projectName(r.cwd ? String(r.cwd) : null),
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
      alive,
      processAgeSeconds: oldest?.ageSeconds ?? null,
      processRssBytes: oldest?.rssBytes ?? null,
      sharesWorktreeWith: shared,
    };
  // sessionId as a tiebreaker (not just recency) so this order is a TOTAL
  // order, not merely a stable one: two sessions can share the exact same
  // lastActivityAt (provider timestamps aren't guaranteed unique to the
  // millisecond), and Array.sort's stability alone only guarantees ties
  // keep THIS call's own input order -- it says nothing about whether
  // fleetStatePage's separate sessionSummaries call, made moments earlier
  // to decide which ids belong on this page, produced rows in that same
  // order. Without a tiebreaker here matching fleetStatePage's own (below),
  // a tied pair could sort one way when ranking pages and a different way
  // when this function orders a page's own contents -- never a dropped or
  // duplicated row (that's decided by fleetStatePage's ranking sort alone,
  // now the same tiebreaker), but a page whose internal order disagreed
  // with the ranking that selected it.
  }).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
    a.sessionId.localeCompare(b.sessionId));
}

export interface FleetPage { sessions: SessionState[]; total: number }

/** fleet:history's query: one page of History, newest-first, WITHOUT ever
 *  materialising any other page. Ranks every session by recency via
 *  sessionSummaries (the cheap query above -- measured ~130ms against the
 *  real index, 878 sessions, vs fleetState's own ~207ms+ for full detail
 *  on all of them), slices for the requested page, then asks fleetState
 *  for full detail on JUST those ids (`sessionIds`) -- the four
 *  correlated subqueries, blocker lookup, liveAgents and worktree-sharing/
 *  matching all still run with full, global correctness (see fleetState's
 *  own doc comment on why those two stay global), but the expensive
 *  per-row work is bounded to the page, not the whole index. `total`
 *  comes free from the same ranking pass, so a caller never needs a
 *  separate count query on top of this one -- which is also why there is
 *  no standalone "count of sessions" export here any more: fleet:list
 *  (src/main/ipc.ts) does not want one at all (nothing history-related
 *  before the user asks), and fleet:history gets it for free from this. */
export function fleetStatePage(
  db: Db, offset: number, limit: number, opts: Omit<FleetOpts, 'sessionIds' | 'precomputedSummaries'> = {},
): FleetPage {
  const summaries = sessionSummaries(db);
  // session_id as a tiebreaker: without it, two sessions sharing the exact
  // same last_ts (provider timestamps aren't guaranteed unique to the
  // millisecond) have no defined relative order across SEPARATE calls to
  // this function -- SQL makes no ordering guarantee absent an ORDER BY,
  // so nothing stops the row order sessionSummaries happens to return from
  // differing between the call that ranks page N and the call that ranks
  // page N+1, which would either drop or duplicate a tied row at the page
  // boundary. session_id is unique per session, so this makes the order a
  // TOTAL order -- identical, deterministically, on every call against the
  // same data -- not merely a stable one.
  const sorted = summaries
    .slice()
    .sort((a, b) => (b.last_ts ?? '').localeCompare(a.last_ts ?? '') ||
      a.session_id.localeCompare(b.session_id));
  const pageIds = sorted.slice(offset, offset + limit).map(r => r.session_id);
  // precomputedSummaries: reuses the query just above rather than making
  // fleetState fetch the same ~130ms result a second time purely for its
  // global matching/worktree-sharing context (opts.sessionIds triggers
  // that) -- measured, not assumed: this call was paying for
  // sessionSummaries twice before precomputedSummaries existed.
  const sessions = fleetState(db, { ...opts, sessionIds: pageIds, precomputedSummaries: summaries });
  return { sessions, total: sorted.length };
}

export interface OpenSession {
  pid: number;
  /** Which provider's CLI this is. Straight from the process
   *  (LiveProcess.provider) -- known with certainty from the `pgrep -x
   *  <bin>` that found this pid (src/discovery/live.ts), never from a
   *  matched session. Always attributable, same reasoning as ageSeconds/
   *  rssBytes below: the card IS the process, so this is a fact about the
   *  process itself, not enrichment borrowed from a transcript match. */
  provider: Provider;
  host: LiveProcess['host'];
  cwd: string | null;
  project: string;
  /** Seconds this process has been running. Unlike SessionState's
   *  processAgeSeconds, this is never gated on match quality -- the card
   *  IS the process, so its own age is attributable regardless of whether
   *  any transcript session can be matched to it. */
  ageSeconds: number | null;
  /** Resident memory of this process, in bytes. Same "always attributable"
   *  reasoning as ageSeconds. */
  rssBytes: number | null;
  match: MatchQuality;
  /** The one session this pid's cwd matches uniquely, or null -- both when
   *  no session shares its cwd at all, and when several do (`ambiguous`,
   *  ordinary on a shared-cwd repo). `lastProse`/`events`/`activity` below
   *  are enrichment from THIS session and are null under the exact same
   *  two conditions -- see the `alive` doc comment on SessionState for why
   *  an ambiguous match may never be attributed to any one of the sessions
   *  sharing it. */
  sessionId: string | null;
  lastProse: string | null;
  events: number | null;
  /** The working/waiting/idle distinction from the matched session's own
   *  turn boundary (see the Activity doc comment above) -- null under the
   *  same conditions as sessionId. */
  activity: Activity | null;
  /** True when this pid is a live tmux-backed session (registered by
   *  launchSession/reattachSession, src/main/launch.ts -- src/main/
   *  sessions.ts's own registry, checked live via resolveLiveTmux). Always
   *  `false` from openSessions/openSessionsLive themselves -- neither has,
   *  or should have, a dependency on that main-process-only registry (it is
   *  a mutable singleton, not something this otherwise-pure module should
   *  need to import to stay testable). The `isTmux` dependency below is how
   *  a caller with real access to it (src/main/ipc.ts) corrects the value
   *  before it ever reaches the renderer. Drives whether a card offers
   *  "Reattach in app" -- offering it on an already-interactive session
   *  would be pointless, not wrong, but the renderer has no other way to
   *  tell the two apart. */
  tmux: boolean;
}

/** One card per live process (discovery, spec §7.1a) -- "ALL OPEN
 *  SESSIONS should show. And the source. So I can close if they are
 *  actually dead." A session opened nine days ago and never touched since
 *  is still open; transcript recency (which drives `sessions`/History)
 *  cannot tell that apart from one that is truly gone, only process
 *  discovery can. This enumerates from `processes`, independently of
 *  `sessions` -- the two are deliberately not filtered against each
 *  other, so History (transcripts) still loses nothing (spec §7.1a) even
 *  though most open processes will also show up there.
 *
 *  Enrichment (lastProse/events/activity) is attached only on a UNIQUE
 *  match, same discipline `alive` already enforces on SessionState: an
 *  ambiguous match (several sessions share this pid's cwd, the common
 *  case on a real workspace) must never borrow one of those sessions'
 *  words or turn-boundary state onto this card -- a blank field is
 *  honest, a wrong one is not. `provider` is NOT in that enrichment list
 *  -- it is the one fact discovery already knows with certainty for every
 *  process regardless of any transcript match (see LiveProcess.provider),
 *  so it is read straight from `p`, never from a matched session. */
/** Assembles one OpenSession from a process, its match result, and
 *  enrichment attributable to it (present only for a `unique` match, per
 *  the doc comment on OpenSession below) -- the final step shared by
 *  openSessions (session-array-driven, below) and openSessionsLive
 *  (DB-targeted, further down), so the two cannot drift on what a card
 *  actually shows. */
function buildOpenSession(p: LiveProcess, m: MatchResult, enrichment: {
  sessionId: string | null; lastProse: string | null; events: number | null; activity: Activity | null;
} | null, isTmux: (pid: number) => boolean): OpenSession {
  return {
    pid: p.pid,
    provider: p.provider,
    host: p.host,
    cwd: p.cwd,
    project: projectName(p.cwd),
    ageSeconds: p.ageSeconds ?? null,
    rssBytes: p.rssBytes ?? null,
    match: m.quality,
    sessionId: enrichment?.sessionId ?? null,
    lastProse: enrichment?.lastProse ?? null,
    events: enrichment?.events ?? null,
    activity: enrichment?.activity ?? null,
    tmux: isTmux(p.pid),
  };
}

// Newest-started process first (ageSeconds ascending) -- the most recently
// opened session is the most likely one David just asked about. Unknown
// age (ps failed) sorts last rather than first: it cannot honestly claim
// to be the newest. pid breaks ties deterministically. Shared by
// openSessions and openSessionsLive so both order cards the same way.
function byProcessAge(a: OpenSession, b: OpenSession): number {
  return (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity) || a.pid - b.pid;
}

export function openSessions(
  sessions: SessionState[], processes: LiveProcess[], deps: { isTmux?: (pid: number) => boolean } = {},
): OpenSession[] {
  const isTmux = deps.isTmux ?? (() => false);
  const refs = sessions.map(s => ({ sessionId: s.sessionId, cwd: s.cwd }));
  const matches = classifyMatch(processes, refs);
  const byId = new Map(sessions.map(s => [s.sessionId, s]));

  return processes.map((p, i) => {
    const m = matches[i]!; // classifyMatch returns one result per process, same order
    const matched = m.quality === 'unique' ? byId.get(m.sessionId!) ?? null : null;
    return buildOpenSession(p, m, matched, isTmux);
  }).sort(byProcessAge);
}

/** The targeted alternative to `openSessions(fleetState(db, ...), ...)`:
 *  same output (open cards enriched with match/lastProse/events/activity
 *  on a unique transcript match), but bounded by the number of LIVE
 *  PROCESSES rather than the size of the index -- the property that
 *  matters is that this stays cheap on a machine with 10,000 sessions,
 *  not just today's ~878. Exists because fleet:update (pushFleet,
 *  src/main/ipc.ts) needs real enrichment -- a permanently-null "needs
 *  you" chip is worse than the cost this avoids -- but must not pay
 *  fleetState's per-session cost (~207ms+ against the real index, and
 *  growing with the corpus) on every watcher/spool/discovery push.
 *
 *  Two SQL passes, both bounded by live-process cwds/ids, never by
 *  session count:
 *
 *  1. Which sessions share ANY live process's cwd at all -- this is a
 *     COMPLETE set for matching purposes, not just a fast one: ambiguity
 *     for a given process depends only on OTHER sessions sharing that
 *     SAME cwd, and any such session is, by definition, included here
 *     (its cwd has to equal one of the ones being searched for). A session
 *     whose cwd matches no live process cannot affect any process's match
 *     quality, so excluding it loses nothing. Scoped to `kind =
 *     'session.started'` rows only (roughly one per session, not per
 *     event) -- still a scan of that kind across the whole table (no
 *     index on `kind` here), but the row COUNT it touches no longer grows
 *     with total events, only with total sessions, and the result set is
 *     bounded by live-process cwds regardless of either.
 *  2. For JUST the sessions that end up uniquely matched (bounded by
 *     process count -- at most one per process), the same per-session
 *     detail fleetState computes for every session: event count, last
 *     prose, and the last event's kind (for deriveActivity). `WHERE
 *     session_id IN (...)` on this small, known id list uses the
 *     `events_session_ts(session_id, ts)` index directly.
 *
 *  Blockers reuse openBlockers(db, undefined, now) exactly as fleetState
 *  does -- already a bounded read over signal_events, not the events
 *  table, so there is nothing to scope further. Activity/lifecycle reuse
 *  deriveActivity, the same function fleetState's own per-row map now
 *  calls, so the two paths cannot compute it differently. */
export function openSessionsLive(
  db: Db, processes: LiveProcess[], now: number = Date.now(), deps: { isTmux?: (pid: number) => boolean } = {},
): OpenSession[] {
  const isTmux = deps.isTmux ?? (() => false);
  const cwds = [...new Set(processes.map(p => p.cwd).filter((c): c is string => c !== null))];

  const candidateRows = cwds.length === 0 ? [] : db.prepare(`
    SELECT session_id, json_extract(payload,'$.cwd') cwd, ts, id
    FROM events
    WHERE kind = 'session.started' AND json_extract(payload,'$.cwd') IN (${cwds.map(() => '?').join(',')})
  `).all(...cwds) as { session_id: string; cwd: string; ts: string; id: number }[];

  // Most recent session.started per session_id -- the same "most recent
  // wins" rule fleetState's own cwd subquery uses (a resumed session
  // re-emits one session.started per transcript file). Sorted ascending
  // so each later entry overwrites the map with a newer one.
  const cwdBySession = new Map<string, string>();
  for (const r of [...candidateRows].sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id)) {
    cwdBySession.set(r.session_id, r.cwd);
  }

  const refs = [...cwdBySession.entries()].map(([sessionId, cwd]) => ({ sessionId, cwd }));
  const matches = classifyMatch(processes, refs);

  // Only sessions that end up uniquely matched ever reach the renderer
  // (buildOpenSession below blanks enrichment for anything else) -- bounded
  // by process count, never by how many sessions share a cwd.
  const uniqueIds = [...new Set(
    matches.filter((m): m is MatchResult & { sessionId: string } => m.quality === 'unique').map(m => m.sessionId))];

  const enrichmentById = new Map<string, {
    sessionId: string; lastProse: string | null; events: number | null; activity: Activity;
  }>();
  if (uniqueIds.length > 0) {
    const hasLiveSignal = processes.length > 0;
    const blockers = new Map<string, Blocker>();
    for (const b of openBlockers(db, undefined, now)) blockers.set(b.sessionId, b);

    const rows = db.prepare(`
      SELECT session_id, COUNT(*) events, MAX(ts) last_ts,
        (SELECT json_extract(payload,'$.text') FROM events p
          WHERE p.session_id = e.session_id AND p.kind = 'prose'
          ORDER BY p.ts DESC, p.id DESC LIMIT 1) last_prose,
        (SELECT k.kind FROM events k
          WHERE k.session_id = e.session_id
          ORDER BY k.ts DESC, k.id DESC LIMIT 1) last_kind
      FROM events e WHERE e.session_id IN (${uniqueIds.map(() => '?').join(',')})
      GROUP BY session_id
    `).all(...uniqueIds) as any[];

    for (const r of rows) {
      const blocker = blockers.get(r.session_id) ?? null;
      const { activity } = deriveActivity({
        lastTs: r.last_ts, lastKind: r.last_kind, blocker, hasMatchedProcess: true, hasLiveSignal, now,
      });
      enrichmentById.set(r.session_id, {
        sessionId: r.session_id, lastProse: r.last_prose ?? null, events: r.events ?? 0, activity,
      });
    }
  }

  return processes.map((p, i) => {
    const m = matches[i]!;
    const enrichment = m.quality === 'unique' ? enrichmentById.get(m.sessionId!) ?? null : null;
    return buildOpenSession(p, m, enrichment, isTmux);
  }).sort(byProcessAge);
}
