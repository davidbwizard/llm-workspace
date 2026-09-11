import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import {
  buildFleetPayload, buildFleetListPayload, buildFleetHistoryPayload, pushFleet,
  sanitizeFields, SANITISED_FIELDS, STRUCTURAL_FIELDS,
  BLOCKER_SANITISED_FIELDS, BLOCKER_STRUCTURAL_FIELDS,
  OPEN_SESSION_SANITISED_FIELDS, OPEN_SESSION_STRUCTURAL_FIELDS,
} from '../../src/main/ipc.ts';
import { getCachedLiveProcesses, refreshLiveProcesses } from '../../src/discovery/live.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';
import type { Blocker } from '../../src/store/signals.ts';

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return { provider:'claude', sessionId:'s1', runId:'r1', agentId:null,
    ts:'2026-09-10T12:00:00Z', kind:'prose', payload:{}, nativeId:null,
    sourceFile:'/f', sourceOffset:0, contentHash:'h', subIndex:0,
    parserVersion:1, ...o } as NormalizedEvent;
}

// signal_events has no FK to events, and openBlockers windows on occurred_at
// against the real Date.now() (buildFleetPayload calls fleetState(db) with
// no `now` override) -- so a blocker fixture needs a real, current
// timestamp, unlike the fixed 2026 timestamps the events above use.
function insertBlocker(db: ReturnType<typeof openDb>, command: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO signal_events
    (event_id, occurred_at, ingested_at, provider, session_id, tool_use_id, kind, payload)
    VALUES (?,?,?,?,?,?,?,?)`).run('e1', now, now, 'claude', 's1', 't1',
      'PermissionRequest', JSON.stringify({ tool_name:'Bash', tool_input:{ command } }));
}

// A function or a Date anywhere in the payload crosses the bridge silently
// changed: JSON.stringify turns a Date into a string and drops a function
// entirely, so a naive "did JSON.stringify throw" check (the brief's
// original version of this test) never sees either problem. This walks the
// actual payload object graph before serialisation and names every
// offending path, so the assertion is on the real values, not on whether
// JSON.stringify tolerated them.
function findFunctionsAndDates(value: unknown, path = '$'): string[] {
  if (value instanceof Date) return [`${path} is a Date`];
  if (typeof value === 'function') return [`${path} is a function`];
  if (Array.isArray(value)) return value.flatMap((v, i) => findFunctionsAndDates(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findFunctionsAndDates(v, `${path}.${k}`));
  }
  return [];
}

describe('buildFleetPayload', () => {
  it('returns a serialisable payload with a version', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const p = buildFleetPayload(db);
    expect(p.version).toBe(1);
    expect(() => structuredClone(p)).not.toThrow();
  });

  it('carries no function or Date values across the bridge', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const payload = buildFleetPayload(db);
    expect(findFunctionsAndDates(payload)).toEqual([]);
  });

  it('strips control characters from provider text', () => {
    const db = openDb(':memory:');
    const ESC = String.fromCharCode(27);
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:`hi${ESC}]52;c;aGk=` }, contentHash:'b', subIndex:1 }),
    ]);
    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.lastProse).not.toContain(ESC);
  });

  // U+202E RIGHT-TO-LEFT OVERRIDE / U+202C POP DIRECTIONAL FORMATTING: the
  // classic bidi-spoofing pair. sanitizeForTerminal is a no-op on these --
  // they don't move a cursor or write anywhere -- but a renderer obeys them,
  // so the *displayed* string would show the override's contents reversed
  // even though its underlying code points are still in source order. If
  // buildFleetPayload only ran text through sanitizeForTerminal, this
  // string would cross the boundary unchanged and the renderer would show
  // "hi" followed by "live" reversed, not what the agent wrote.
  it('removes bidi overrides so the text reads in logical order', () => {
    const db = openDb(':memory:');
    const RLO = '\u202e';
    const PDF = '\u202c';
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:`hi ${RLO}evil${PDF} there` }, contentHash:'b', subIndex:1 }),
    ]);
    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.lastProse).toBe('hi evil there');
  });

  it('removes zero-width formatting characters', () => {
    const db = openDb(':memory:');
    const ZWSP = '\u200b';
    const BOM = '\u{feff}';
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:`${BOM}pay${ZWSP}pal.com` }, contentHash:'b', subIndex:1 }),
    ]);
    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.lastProse).toBe('paypal.com');
  });

  // ZWNJ (U+200C) is not decorative -- Persian, Arabic and several Indic
  // scripts require it to render correctly. U+06A9 U+062A U+0627 U+0628
  // ("ketab", book) + ZWNJ + U+0647 U+0627 (the plural suffix "-ha") is the
  // textbook example: without the ZWNJ the two halves visually join into a
  // single, wrong word. A sanitiser that strips it silently corrupts
  // correct text, which is worse than leaving it in -- it happens on
  // honest content every day, not only under attack.
  it('keeps ZWNJ in real Persian text unchanged', () => {
    const db = openDb(':memory:');
    const persian = '\u06a9\u062a\u0627\u0628\u200c\u0647\u0627';
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text: persian }, contentHash:'b', subIndex:1 }),
    ]);
    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.lastProse).toBe(persian);
  });

  // ZWJ (U+200D) joins emoji into a single glyph -- strip it and a family
  // emoji becomes four separate people. Asserted on code points (spread
  // iterates a string by code point, not UTF-16 code unit), not on how it
  // renders.
  it('keeps ZWJ emoji sequences intact', () => {
    const db = openDb(':memory:');
    // man, ZWJ, woman, ZWJ, girl, ZWJ, boy -- the "family" ZWJ sequence
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}';
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text: family }, contentHash:'b', subIndex:1 }),
    ]);
    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.lastProse).toBe(family);
    expect([...p.sessions[0]!.lastProse!]).toHaveLength(7); // 4 emoji + 3 ZWJ
  });

  // This is the gate described above SANITISED_FIELDS/STRUCTURAL_FIELDS in
  // src/main/ipc.ts: every key buildFleetPayload actually puts on a session
  // must be accounted for by exactly one of those two lists. If someone
  // adds a field to SessionState (src/fleet/state.ts) and forgets to
  // classify it here, this fails -- the built session carries a key
  // neither list names, so the sets cannot be equal.
  it('classifies every session field as sanitised or structural, with none left over', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const session = buildFleetPayload(db).sessions[0]!;
    const known = new Set<string>([...SANITISED_FIELDS, ...STRUCTURAL_FIELDS]);
    expect(new Set(Object.keys(session))).toEqual(known);
  });

  // Same gate, for the nested blocker object -- needs a real blocker, so
  // this is the first test in this file to actually populate one.
  it('classifies every blocker field as sanitised or structural, with none left over', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    insertBlocker(db, 'npm run dist:mac');
    const blocker = buildFleetPayload(db).sessions[0]!.blocker!;
    const known = new Set<string>([...BLOCKER_SANITISED_FIELDS, ...BLOCKER_STRUCTURAL_FIELDS]);
    expect(new Set(Object.keys(blocker))).toEqual(known);
  });

  // blocker.kind is populated by String(p.hook_event_name ?? 'unknown')
  // in src/hooks/spool.ts with no enum check at write time -- freeform
  // text next to the already-sanitised blocker.text. It cannot actually be
  // dirtied through the real signal_events -> openBlockers pipeline today:
  // src/store/signals.ts's isBlocking() only admits a signal whose `kind`
  // exactly equals one of a fixed clean set ('PermissionRequest',
  // 'Elicitation', 'Notification', 'PreToolUse') before it ever becomes
  // part of a Blocker, so every reachable blocker.kind is clean by
  // construction of that gate. Sanitising it here anyway is deliberate
  // defence in depth -- display safety at this boundary should not depend
  // on a classification gate that exists for an unrelated purpose and
  // could change. This test proves the classification, which is the part
  // this fix actually changes; the mechanism itself (sanitizeFields applies
  // identically to every field named in BLOCKER_SANITISED_FIELDS, with no
  // per-field special-casing) is proven directly, below, by calling
  // sanitizeFields on a hand-built dirty Blocker -- the only way to
  // observe it, since no real Blocker can ever carry a dirty kind.
  it('classifies blocker.kind as sanitised, not structural', () => {
    expect(BLOCKER_SANITISED_FIELDS).toContain('kind');
  });

  it('sanitises blocker.text end to end, from a real hook payload', () => {
    const db = openDb(':memory:');
    const ESC = String.fromCharCode(27);
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    insertBlocker(db, `rm -rf ${ESC}]52;c;aGk= /tmp`);
    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.blocker!.text).not.toContain(ESC);
  });

  // The two exhaustiveness tests above only prove COVERAGE: every field
  // belongs to SOME list. They are blind to which one -- moving 'project'
  // from SANITISED_FIELDS to STRUCTURAL_FIELDS keeps both of those tests
  // green, since project is still classified, just wrongly, and it is
  // attacker-reachable (the last path segment of cwd). `toEqual` here
  // checks content AND order against a hardcoded expectation, not just
  // presence, so reclassifying a field -- moving it between these two
  // arrays, in either direction -- fails this test. That is deliberate:
  // reclassification is a real, security-relevant decision, and it should
  // require editing and justifying THIS test, not fall out silently from
  // some other change.
  it('pins the session field classification exactly, not just its coverage', () => {
    expect(SANITISED_FIELDS).toEqual(['lastProse', 'project', 'cwd']);
    expect(STRUCTURAL_FIELDS).toEqual([
      'sessionId', 'runId', 'provider', 'lifecycle', 'activity', 'stale',
      'confidence', 'source', 'lastActivityAt', 'agents', 'liveAgents',
      'events', 'blocker', 'match', 'candidates', 'host', 'alive',
      'processAgeSeconds', 'processRssBytes', 'sharesWorktreeWith',
    ]);
  });

  it('pins the blocker field classification exactly, not just its coverage', () => {
    expect(BLOCKER_SANITISED_FIELDS).toEqual(['text', 'kind']);
    expect(BLOCKER_STRUCTURAL_FIELDS).toEqual(['sessionId', 'toolUseId', 'promptId', 'occurredAt']);
  });

  // Pinning the DECLARATION (above) still only proves the lists say the
  // right thing, not that buildFleetPayload's actual output obeys them --
  // a mutation that makes sanitizeFields silently skip a field at runtime,
  // leaving the exported lists untouched, passes every test so far. This
  // list is deliberately NOT imported from src/main/ipc.ts: it is this
  // test's own, independent claim about which session-level fields must
  // come out clean. Importing SANITISED_FIELDS here would make the test
  // circular -- removing a field from that constant would silently remove
  // it from this test's expectations too, so a misclassification could
  // never make it fail (this is exactly how the reviewer's `project`
  // mutation slipped past the union check in the exhaustiveness test).
  //
  // blocker.kind is not included: see the comment on `classifies
  // blocker.kind as sanitised, not structural` above and the direct
  // sanitizeFields test below -- there is no reachable way to get dirty
  // content into a real blocker.kind, so testing it here would only prove
  // that a field with nothing dirty in it has nothing dirty in it.
  const REACHABLE_SESSION_SANITISED_FIELDS = ['lastProse', 'project', 'cwd'] as const;

  it('actually strips a bidi override from every reachable sanitised session field', () => {
    const db = openDb(':memory:');
    const RLO = '\u202e';
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:`/Users/me/proj${RLO}ect` }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:`hi ${RLO} there` }, contentHash:'b', subIndex:1 }),
    ]);
    const session = buildFleetPayload(db).sessions[0]!;
    for (const field of REACHABLE_SESSION_SANITISED_FIELDS) {
      expect(session[field], `session.${field}`).not.toContain(RLO);
    }
  });

  it('actually strips a bidi override from blocker.text', () => {
    const db = openDb(':memory:');
    const RLO = '\u202e';
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    insertBlocker(db, `rm -rf ${RLO} /tmp`);
    const blocker = buildFleetPayload(db).sessions[0]!.blocker!;
    expect(blocker.text).not.toContain(RLO);
  });

  it('sanitizeFields itself cleans blocker.kind and blocker.text when told to, independent of the exported lists', () => {
    const RLO = '\u202e';
    const dirty: Blocker = {
      sessionId: 's1', kind: `Permission${RLO}Request`, toolUseId: null,
      promptId: null, occurredAt: '2026-01-01T00:00:00Z', text: `bad ${RLO} text`,
    };
    // Field list passed here is hand-written, not BLOCKER_SANITISED_FIELDS
    // -- same reason as REACHABLE_SESSION_SANITISED_FIELDS above.
    const clean = sanitizeFields(dirty, ['kind', 'text']);
    expect(clean.kind).not.toContain(RLO);
    expect(clean.text).not.toContain(RLO);
  });
});

// buildFleetPayload reads discovery/live.ts's process cache (populated by
// src/main/index.ts's interval, out of reach here) rather than triggering a
// sweep itself -- these drive that cache directly via refreshLiveProcesses,
// with an injected exec, so no real pgrep/ps/lsof calls happen in tests.
describe('buildFleetPayload — live process discovery wiring', () => {
  it('lists every session even when process discovery has found nothing (spec 7.1a: enrichment only, never a filter)', async () => {
    await refreshLiveProcesses(async () => ''); // no processes found at all
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r1' }, sessionId:'s1', contentHash:'c1' }),
      ev({ kind:'session.started', payload:{ cwd:'/r2' }, sessionId:'s2', contentHash:'c2' }),
    ]);

    const p = buildFleetPayload(db);
    expect(p.sessions).toHaveLength(2);
    expect(p.sessions.every(s => s.host === null && s.match === 'unknown' && s.alive === false)).toBe(true);
    expect(p.openSessions).toEqual([]); // nothing open, nothing to show -- not a filter bug, honestly zero
  });

  it('populates host/match/candidates for a session whose live process was discovered', async () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/live' } })]);

    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/live\n';
      return '';
    });
    expect(getCachedLiveProcesses()).toHaveLength(1); // sanity: the cache actually took the sweep

    const p = buildFleetPayload(db);
    expect(p.sessions[0]!.match).toBe('unique');
    // 'unknown', not null: null means no process matched at all; 'unknown'
    // means one did, but its ancestry chain (returned '' by the exec above)
    // didn't classify to a recognized host app.
    expect(p.sessions[0]!.host).toBe('unknown');
    // Was `expect(new Set(...)).toEqual(new Set([4242]))`: fleetState's
    // bySession construction used to double-insert a unique match's pid --
    // classifyMatch's own `unique` result sets BOTH m.sessionId and,
    // redundantly, m.candidates = [that same session id], and the old loop
    // processed both, once via a `sessionId` branch and once via the
    // `candidates` branch, for the same session. The Set comparison masked
    // the duplicate; fixed in src/fleet/state.ts (the redundant branch is
    // gone -- only the candidates loop remains), so this now asserts the
    // real array, which would fail again if the duplicate returned.
    expect(p.sessions[0]!.candidates).toEqual([4242]);
    expect(p.sessions[0]!.alive).toBe(true);
  });

  // The model correction: openSessions enumerates from live processes, one
  // card per pid, wired end to end through the real discovery pipeline
  // (refreshLiveProcesses -> the process cache -> buildFleetPayload).
  it('wires openSessions end to end, one card per live process, regardless of transcript match', async () => {
    const db = openDb(':memory:');
    // No session in the index shares either pid's cwd -- proves an open
    // card does not depend on a transcript match to appear at all.
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '100\n';
      if (bin === 'pgrep' && args[1] === 'codex') return '200\n';
      return '';
    });

    const p = buildFleetPayload(db);
    expect(p.openSessions.map(o => o.pid).sort((a, b) => a - b)).toEqual([100, 200]);
    expect(p.openSessions.every(o => o.match === 'unknown' && o.sessionId === null)).toBe(true);
    // provider comes from WHICH pgrep found each pid, wired all the way
    // through the real discovery pipeline -- not from any transcript
    // match, of which there is none here.
    const byPid = new Map(p.openSessions.map(o => [o.pid, o]));
    expect(byPid.get(100)!.provider).toBe('claude');
    expect(byPid.get(200)!.provider).toBe('codex');
  });

  // PREMISE CHANGE from the version of this test predating the provider
  // fix: it used to assert `provider` was null on an ambiguous match. That
  // was correct when provider was session-derived enrichment; it is not
  // anymore -- provider now comes straight from the process (which pgrep
  // found it), so it stays populated regardless of match quality, same as
  // pid/host. Only what is genuinely session-derived (sessionId/lastProse/
  // events/activity) stays blank here.
  it('enriches an open card only on a unique transcript match, leaving session-derived fields blank on an ambiguous one', async () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/repo/shared' }, sessionId:'s1', contentHash:'c1' }),
      ev({ kind:'session.started', payload:{ cwd:'/repo/shared' }, sessionId:'s2', contentHash:'c2' }),
    ]);
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '9\n';
      if (bin === 'lsof') return 'p9\nfcwd\nn/repo/shared\n';
      return '';
    });

    const p = buildFleetPayload(db);
    expect(p.openSessions).toHaveLength(1);
    expect(p.openSessions[0]!.match).toBe('ambiguous');
    expect(p.openSessions[0]!.sessionId).toBeNull();
    expect(p.openSessions[0]!.lastProse).toBeNull();
    expect(p.openSessions[0]!.events).toBeNull();
    expect(p.openSessions[0]!.activity).toBeNull();
    // Still attributable -- these come from the process, not a session.
    expect(p.openSessions[0]!.provider).toBe('claude');
    expect(p.openSessions[0]!.pid).toBe(9);
    expect(p.openSessions[0]!.cwd).toBe('/repo/shared');
  });

  // Same gate as SessionState/Blocker above, for OpenSession.
  it('classifies every open-session field as sanitised or structural, with none left over', async () => {
    const db = openDb(':memory:');
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      return '';
    });
    const open = buildFleetPayload(db).openSessions[0]!;
    const known = new Set<string>([...OPEN_SESSION_SANITISED_FIELDS, ...OPEN_SESSION_STRUCTURAL_FIELDS]);
    expect(new Set(Object.keys(open))).toEqual(known);
  });

  it('pins the open-session field classification exactly, not just its coverage', () => {
    expect(OPEN_SESSION_SANITISED_FIELDS).toEqual(['cwd', 'project', 'lastProse']);
    expect(OPEN_SESSION_STRUCTURAL_FIELDS).toEqual([
      'pid', 'host', 'ageSeconds', 'rssBytes', 'match', 'sessionId', 'provider', 'events', 'activity',
    ]);
  });

  // cwd/project on an open card come straight from `lsof`, not from any
  // session -- they need their own sanitisation pass distinct from the one
  // applied to `sessions`. This is the only place that pass is reachable:
  // every other open-card test above uses a clean cwd.
  it("sanitises an open card's cwd/project even when no session enriches it", async () => {
    const db = openDb(':memory:');
    const RLO = '\u202e';
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '555\n';
      if (bin === 'lsof') return `p555\nfcwd\nn/Users/me/proj${RLO}ect\n`;
      return '';
    });

    const p = buildFleetPayload(db);
    expect(p.openSessions[0]!.cwd).not.toContain(RLO);
    expect(p.openSessions[0]!.project).not.toContain(RLO);
  });
});

// fleet:list is the renderer's one-time initial pull (FleetView.tsx calls
// it exactly once, on mount) and is built to never touch fleetState --
// these prove that split holds: the payload shape is genuinely different
// from buildFleetPayload's (no sessions array at all), and openSessions on
// it carries no transcript enrichment even when a real match is available
// via the full computation, matching buildFleetListPayload's own doc
// comment in src/main/ipc.ts.
describe('buildFleetListPayload — the fleet:list fast path', () => {
  it('never includes the sessions array', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const p = buildFleetListPayload(db);
    expect('sessions' in p).toBe(false);
  });

  it('reports historyCount matching buildFleetPayload(db).sessions.length', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r1' }, sessionId:'s1', contentHash:'c1' }),
      ev({ kind:'session.started', payload:{ cwd:'/r2' }, sessionId:'s2', contentHash:'c2' }),
    ]);
    expect(buildFleetListPayload(db).historyCount).toBe(buildFleetPayload(db).sessions.length);
  });

  it('never matches openSessions against transcripts, even when a real match exists', async () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/live' } })]);
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/live\n';
      return '';
    });
    // Sanity: the full computation WOULD match this pid uniquely.
    expect(buildFleetPayload(db).openSessions[0]!.match).toBe('unique');
    // buildFleetListPayload deliberately does not: it never touches fleetState.
    const p = buildFleetListPayload(db);
    expect(p.openSessions[0]!.match).toBe('unknown');
    expect(p.openSessions[0]!.sessionId).toBeNull();
    expect(p.openSessions[0]!.lastProse).toBeNull();
  });

  it("sanitises an open card's cwd/project even on the fast path", async () => {
    const RLO = '\u202e';
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '555\n';
      if (bin === 'lsof') return `p555\nfcwd\nn/Users/me/proj${RLO}ect\n`;
      return '';
    });
    const db = openDb(':memory:');
    const p = buildFleetListPayload(db);
    expect(p.openSessions[0]!.cwd).not.toContain(RLO);
    expect(p.openSessions[0]!.project).not.toContain(RLO);
  });
});

describe('buildFleetHistoryPayload — fleet:history', () => {
  it('never includes openSessions', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const p = buildFleetHistoryPayload(db);
    expect('openSessions' in p).toBe(false);
  });

  it('matches buildFleetPayload(db).sessions exactly', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r1' }, sessionId:'s1', contentHash:'c1' }),
      ev({ kind:'session.started', payload:{ cwd:'/r2' }, sessionId:'s2', contentHash:'c2' }),
    ]);
    expect(buildFleetHistoryPayload(db).sessions).toEqual(buildFleetPayload(db).sessions);
  });
});

// Unlike fleet:list (above), pushFleet is event-driven rather than the
// renderer's one-time initial pull, so it can afford fleetState's cost --
// and does, deliberately: this is how openSessions' transcript enrichment
// (activity/lastProse, FleetView's "needs you" chip) ever reaches the
// renderer at all, since fleet:list itself never computes it. Still never
// sends the full sessions array, so a push does not undo the payload-size
// win the fleet:list/fleet:history split exists for.
describe('pushFleet — the fleet:update push', () => {
  it('sends the enriched openSessions list plus historyCount, never the sessions array', async () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/live' } })]);
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/live\n';
      return '';
    });
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as
      Parameters<typeof pushFleet>[1];
    pushFleet(db, win);
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0]!;
    expect(channel).toBe('fleet:update');
    expect('sessions' in payload).toBe(false);
    expect(payload.historyCount).toBe(1);
    expect(payload.openSessions[0]!.match).toBe('unique');
  });

  it('does nothing when there is no window', () => {
    const db = openDb(':memory:');
    expect(() => pushFleet(db, null)).not.toThrow();
  });
});

// Comments can contain the same channel names the assertion below looks for
// (e.g. a comment listing a channel that was since removed). Strip them so
// the assertion matches only code that actually runs -- same pattern as
// tests/main/security.test.ts.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

describe('IPC channel parity', () => {
  it('every channel main handles is exposed by the preload, and vice versa', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    const preload = strip(readFileSync('src/preload/index.ts', 'utf8'));
    const handled = [...ipc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]).sort();
    const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]).sort();
    expect(handled).toEqual(exposed);
  });
});
