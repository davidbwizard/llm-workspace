import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import {
  buildFleetListPayload, buildFleetHistoryPayload, pushFleet, refreshPushEnrichment,
  clampOffset, clampLimit, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, parseConversationCursor,
  sanitizeFields, SANITISED_FIELDS, STRUCTURAL_FIELDS,
  BLOCKER_SANITISED_FIELDS, BLOCKER_STRUCTURAL_FIELDS,
  OPEN_SESSION_SANITISED_FIELDS, OPEN_SESSION_STRUCTURAL_FIELDS,
  killSession, ownProcessAncestry, revealSession, sendKeysFor, resolveReattachTarget,
  freshLiveSession, promptOpenFor,
} from '../../src/main/ipc.ts';
import { registerSession, clearRegistry, tmuxNameForPid } from '../../src/main/sessions.ts';
import { getCachedLiveProcesses, refreshLiveProcesses, type ExecFn } from '../../src/discovery/live.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';
import type { Blocker } from '../../src/store/signals.ts';
import type { LiveProcess } from '../../src/discovery/parse.ts';
import type { OpenSession } from '../../src/fleet/state.ts';
import type { LiveSessionRead } from '../../src/providers/claude/liveSession.ts';

// Fix wave F3: about 9 refreshLiveProcesses calls below give Claude pids
// with no reader stub of their own, so without this every one of them
// would fall through discovery's own readLiveSession to the REAL
// readLiveSessionFile, which opens files under ~/.claude/sessions -- this
// test file must never depend on what happens to be on the machine running
// it. Every other export from the module stays real (built from
// importOriginal), so this changes nothing about how discovery classifies
// a pid beyond making its live-session read report "missing"
// unconditionally, exactly like a machine with no such directory.
// resolveReattachTarget's own tests below inject `read` directly and never
// go through discovery's real readLiveSession, so they are unaffected.
vi.mock('../../src/providers/claude/liveSession.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/claude/liveSession.ts')>();
  return { ...actual, readLiveSessionFile: () => ({ ok: false, reason: 'missing' }) };
});

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return { provider:'claude', sessionId:'s1', runId:'r1', agentId:null,
    ts:'2026-09-10T12:00:00Z', kind:'prose', payload:{}, nativeId:null,
    sourceFile:'/f', sourceOffset:0, contentHash:'h', subIndex:0,
    parserVersion:1, ...o } as NormalizedEvent;
}

// A single page, large enough for every fixture in this file (none inserts
// more than a handful of sessions) -- lets each test call
// buildFleetHistoryPayload(db, 0, PAGE) and just read .sessions[0]/.sessions
// without needing to think about pagination itself, which has its own
// dedicated describe block below.
const PAGE = 50;

// signal_events has no FK to events, and openBlockers windows on occurred_at
// against the real Date.now() (fleetState is called with no `now` override
// here) -- so a blocker fixture needs a real, current timestamp, unlike the
// fixed 2026 timestamps the events above use.
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

describe('buildFleetHistoryPayload — sanitisation and shape', () => {
  it('returns a serialisable payload with a version', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const p = buildFleetHistoryPayload(db, 0, PAGE);
    expect(p.version).toBe(1);
    expect(() => structuredClone(p)).not.toThrow();
  });

  it('carries no function or Date values across the bridge', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const payload = buildFleetHistoryPayload(db, 0, PAGE);
    expect(findFunctionsAndDates(payload)).toEqual([]);
  });

  it('strips control characters from provider text', () => {
    const db = openDb(':memory:');
    const ESC = String.fromCharCode(27);
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/r' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:`hi${ESC}]52;c;aGk=` }, contentHash:'b', subIndex:1 }),
    ]);
    const p = buildFleetHistoryPayload(db, 0, PAGE);
    expect(p.sessions[0]!.lastProse).not.toContain(ESC);
  });

  // U+202E RIGHT-TO-LEFT OVERRIDE / U+202C POP DIRECTIONAL FORMATTING: the
  // classic bidi-spoofing pair. sanitizeForTerminal is a no-op on these --
  // they don't move a cursor or write anywhere -- but a renderer obeys them,
  // so the *displayed* string would show the override's contents reversed
  // even though its underlying code points are still in source order. If
  // buildFleetHistoryPayload only ran text through sanitizeForTerminal, this
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
    const p = buildFleetHistoryPayload(db, 0, PAGE);
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
    const p = buildFleetHistoryPayload(db, 0, PAGE);
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
    const p = buildFleetHistoryPayload(db, 0, PAGE);
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
    const p = buildFleetHistoryPayload(db, 0, PAGE);
    expect(p.sessions[0]!.lastProse).toBe(family);
    expect([...p.sessions[0]!.lastProse!]).toHaveLength(7); // 4 emoji + 3 ZWJ
  });

  // This is the gate described above SANITISED_FIELDS/STRUCTURAL_FIELDS in
  // src/main/ipc.ts: every key buildFleetHistoryPayload actually puts on a
  // session must be accounted for by exactly one of those two lists. If
  // someone adds a field to SessionState (src/fleet/state.ts) and forgets
  // to classify it here, this fails -- the built session carries a key
  // neither list names, so the sets cannot be equal.
  it('classifies every session field as sanitised or structural, with none left over', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    const session = buildFleetHistoryPayload(db, 0, PAGE).sessions[0]!;
    const known = new Set<string>([...SANITISED_FIELDS, ...STRUCTURAL_FIELDS]);
    expect(new Set(Object.keys(session))).toEqual(known);
  });

  // Same gate, for the nested blocker object -- needs a real blocker, so
  // this is the first test in this file to actually populate one.
  it('classifies every blocker field as sanitised or structural, with none left over', () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    insertBlocker(db, 'npm run dist:mac');
    const blocker = buildFleetHistoryPayload(db, 0, PAGE).sessions[0]!.blocker!;
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
    const p = buildFleetHistoryPayload(db, 0, PAGE);
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
  // right thing, not that buildFleetHistoryPayload's actual output obeys
  // them -- a mutation that makes sanitizeFields silently skip a field at
  // runtime, leaving the exported lists untouched, passes every test so
  // far. This list is deliberately NOT imported from src/main/ipc.ts: it
  // is this test's own, independent claim about which session-level
  // fields must come out clean. Importing SANITISED_FIELDS here would make
  // the test circular -- removing a field from that constant would
  // silently remove it from this test's expectations too, so a
  // misclassification could never make it fail (this is exactly how the
  // reviewer's `project` mutation slipped past the union check in the
  // exhaustiveness test).
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
    const session = buildFleetHistoryPayload(db, 0, PAGE).sessions[0]!;
    for (const field of REACHABLE_SESSION_SANITISED_FIELDS) {
      expect(session[field], `session.${field}`).not.toContain(RLO);
    }
  });

  it('actually strips a bidi override from blocker.text', () => {
    const db = openDb(':memory:');
    const RLO = '\u202e';
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/r' } })]);
    insertBlocker(db, `rm -rf ${RLO} /tmp`);
    const blocker = buildFleetHistoryPayload(db, 0, PAGE).sessions[0]!.blocker!;
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

// David's correction: fleet:history is paged in SQL, not built whole and
// sliced in the renderer -- "main should never build 878 session objects."
// These prove pagination is real (offset/limit reach the query, not a
// post-hoc JS .slice()) via the one observable a JS-slice implementation
// could not fake: total does not depend on the page requested, and a page
// past the end is legitimately empty while total stays accurate.
describe('buildFleetHistoryPayload — pagination', () => {
  function seed(db: ReturnType<typeof openDb>, ids: string[]): void {
    insertEvents(db, ids.map((id, i) =>
      ev({ sessionId: id, contentHash: id, ts: new Date(2026, 0, 1, 0, i).toISOString() })));
  }

  it('returns a page ordered newest-first, with the total session count', () => {
    const db = openDb(':memory:');
    seed(db, ['old', 'mid', 'new']);
    const p = buildFleetHistoryPayload(db, 0, 2);
    expect(p.sessions.map(s => s.sessionId)).toEqual(['new', 'mid']);
    expect(p.total).toBe(3);
  });

  it('the next page starts where the previous one left off', () => {
    const db = openDb(':memory:');
    seed(db, ['old', 'mid', 'new']);
    const p = buildFleetHistoryPayload(db, 2, 2);
    expect(p.sessions.map(s => s.sessionId)).toEqual(['old']);
    expect(p.total).toBe(3);
  });

  it('returns an empty page, not an error, once offset is past the end', () => {
    const db = openDb(':memory:');
    seed(db, ['s1']);
    const p = buildFleetHistoryPayload(db, 10, 5);
    expect(p.sessions).toEqual([]);
    expect(p.total).toBe(1);
  });
});

// Untrusted input from the renderer (spec S11.2: validate at the IPC
// boundary, not just the text content crossing it) -- registerIpc's
// fleet:history handler passes whatever the renderer sends straight
// through these before buildFleetHistoryPayload ever sees it.
describe('clampOffset / clampLimit', () => {
  it('clamps a negative, NaN, or non-numeric offset to 0', () => {
    expect(clampOffset(-5)).toBe(0);
    expect(clampOffset(NaN)).toBe(0);
    expect(clampOffset('60')).toBe(0);
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(null)).toBe(0);
  });

  it('truncates a fractional offset', () => {
    expect(clampOffset(12.9)).toBe(12);
  });

  it('passes a valid positive offset through unchanged', () => {
    expect(clampOffset(120)).toBe(120);
  });

  it('falls back to the default limit for zero, negative, NaN, or non-numeric input', () => {
    expect(clampLimit(0)).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampLimit(-1)).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampLimit(NaN)).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampLimit('60')).toBe(HISTORY_DEFAULT_LIMIT);
  });

  it('caps an over-large limit at HISTORY_MAX_LIMIT, rather than trusting the renderer for a full-corpus fetch', () => {
    expect(clampLimit(100000)).toBe(HISTORY_MAX_LIMIT);
  });

  it('passes a valid limit within bounds through unchanged', () => {
    expect(clampLimit(25)).toBe(25);
  });
});

describe('parseConversationCursor', () => {
  // session:conversation's cursor crosses the IPC boundary the same
  // untrusted way offset/limit above do -- a compromised or buggy renderer
  // can call ipcRenderer.invoke with any shape at all, regardless of what
  // the preload's TypeScript signature says.
  it('passes through a well-formed cursor unchanged', () => {
    expect(parseConversationCursor({ ts: '2026-09-12T10:00:00Z', id: 42 })).toEqual({ ts: '2026-09-12T10:00:00Z', id: 42 });
  });

  it('falls back to undefined -- "no cursor", the safe default -- for anything that is not an object', () => {
    expect(parseConversationCursor(undefined)).toBeUndefined();
    expect(parseConversationCursor(null)).toBeUndefined();
    expect(parseConversationCursor('2026-09-12T10:00:00Z')).toBeUndefined();
    expect(parseConversationCursor(42)).toBeUndefined();
    expect(parseConversationCursor([])).toBeUndefined();
  });

  it('rejects a missing, non-string, or empty ts', () => {
    expect(parseConversationCursor({ id: 42 })).toBeUndefined();
    expect(parseConversationCursor({ ts: 12345, id: 42 })).toBeUndefined();
    expect(parseConversationCursor({ ts: '', id: 42 })).toBeUndefined();
  });

  it('rejects a missing, non-numeric, or non-integer id -- never coerces a numeric string', () => {
    expect(parseConversationCursor({ ts: '2026-09-12T10:00:00Z' })).toBeUndefined();
    expect(parseConversationCursor({ ts: '2026-09-12T10:00:00Z', id: '42' })).toBeUndefined();
    expect(parseConversationCursor({ ts: '2026-09-12T10:00:00Z', id: 42.5 })).toBeUndefined();
    expect(parseConversationCursor({ ts: '2026-09-12T10:00:00Z', id: NaN })).toBeUndefined();
  });

  it('ignores extra fields rather than rejecting the whole cursor over them', () => {
    expect(parseConversationCursor({ ts: '2026-09-12T10:00:00Z', id: 42, extra: 'whatever' }))
      .toEqual({ ts: '2026-09-12T10:00:00Z', id: 42 });
  });
});

// buildFleetListPayload reads discovery/live.ts's process cache (populated
// by src/main/index.ts's interval, out of reach here) rather than
// triggering a sweep itself -- these drive that cache directly via
// refreshLiveProcesses, with an injected exec, so no real pgrep/ps/lsof
// calls happen in tests.
//
// David's correction goes further than the original brief: fleet:list
// (and pushFleet, below -- the same function backs both) never matches
// against a transcript at all, not even to enrich an open card once a
// unique match exists. These prove that holds even when a real match IS
// available.
describe('buildFleetListPayload — process-only, never touches the index', () => {
  it('lists every open process even when process discovery has found nothing (spec 7.1a: enrichment only, never a filter)', async () => {
    await refreshLiveProcesses(async () => ''); // no processes found at all
    expect(buildFleetListPayload().openSessions).toEqual([]);
  });

  // The model correction: openSessions enumerates from live processes, one
  // card per pid, wired end to end through the real discovery pipeline
  // (refreshLiveProcesses -> the process cache -> buildFleetListPayload).
  it('wires openSessions end to end, one card per live process, regardless of transcript match', async () => {
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '100\n';
      if (bin === 'pgrep' && args[1] === 'codex') return '200\n';
      return '';
    });

    const p = buildFleetListPayload();
    expect(p.openSessions.map(o => o.pid).sort((a, b) => a - b)).toEqual([100, 200]);
    expect(p.openSessions.every(o => o.match === 'unknown' && o.sessionId === null)).toBe(true);
    const byPid = new Map(p.openSessions.map(o => [o.pid, o]));
    expect(byPid.get(100)!.provider).toBe('claude');
    expect(byPid.get(200)!.provider).toBe('codex');
  });

  it('never includes the sessions array', async () => {
    await refreshLiveProcesses(async () => '');
    expect('sessions' in buildFleetListPayload()).toBe(false);
  });

  it('never matches openSessions against a transcript, even when a unique match exists in the index', async () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/live' } })]);
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/live\n';
      return '';
    });
    // Sanity: History (fleet:history) WOULD match this pid uniquely.
    expect(buildFleetHistoryPayload(db, 0, PAGE).sessions[0]!.match).toBe('unique');
    // buildFleetListPayload deliberately does not: it never touches the db.
    const p = buildFleetListPayload();
    expect(p.openSessions[0]!.match).toBe('unknown');
    expect(p.openSessions[0]!.sessionId).toBeNull();
    expect(p.openSessions[0]!.lastProse).toBeNull();
    expect(p.openSessions[0]!.events).toBeNull();
    expect(p.openSessions[0]!.activity).toBeNull();
    // Still attributable -- these come from the process, not a session.
    expect(p.openSessions[0]!.provider).toBe('claude');
    expect(p.openSessions[0]!.pid).toBe(4242);
  });

  // Same gate as SessionState/Blocker above, for OpenSession.
  it('classifies every open-session field as sanitised or structural, with none left over', async () => {
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      return '';
    });
    const open = buildFleetListPayload().openSessions[0]!;
    const known = new Set<string>([...OPEN_SESSION_SANITISED_FIELDS, ...OPEN_SESSION_STRUCTURAL_FIELDS]);
    expect(new Set(Object.keys(open))).toEqual(known);
  });

  it('pins the open-session field classification exactly, not just its coverage', () => {
    expect(OPEN_SESSION_SANITISED_FIELDS).toEqual(['cwd', 'project', 'lastProse']);
    expect(OPEN_SESSION_STRUCTURAL_FIELDS).toEqual([
      'pid', 'host', 'ageSeconds', 'rssBytes', 'match', 'sessionId', 'provider', 'events', 'activity', 'tmux',
      'junk',
    ]);
  });

  // Fix-wave item 1's eligibility gate ("Reattach in app" offered only for a
  // non-tmux-backed session) is only honest if the real registry, not a
  // stand-in, decides `tmux` here -- proven end to end through
  // buildFleetListPayload itself, not by calling openSessions directly.
  it('reports tmux true for a pid this app itself registered, false for one it never did', async () => {
    clearRegistry();
    try {
      registerSession(4242, 'llmws-claude-abc');
      await refreshLiveProcesses(async (bin, args) => {
        if (bin === 'pgrep' && args[1] === 'claude') return '4242\n5555\n';
        return '';
      });
      const byPid = new Map(buildFleetListPayload().openSessions.map(o => [o.pid, o]));
      expect(byPid.get(4242)!.tmux).toBe(true);
      expect(byPid.get(5555)!.tmux).toBe(false);
    } finally {
      clearRegistry();
    }
  });

  // cwd/project on an open card come straight from `lsof`, not from any
  // session -- they need their own sanitisation pass. This is the only
  // place that pass is reachable: every other open-card test above uses a
  // clean cwd.
  it("sanitises an open card's cwd/project", async () => {
    const RLO = '\u202e';
    await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '555\n';
      if (bin === 'lsof') return `p555\nfcwd\nn/Users/me/proj${RLO}ect\n`;
      return '';
    });
    const p = buildFleetListPayload();
    expect(p.openSessions[0]!.cwd).not.toContain(RLO);
    expect(p.openSessions[0]!.project).not.toContain(RLO);
  });
});

// pushFleet backs fleet:update, sent on every watcher/spool/ingest/
// discovery change (src/main/index.ts). Unlike fleet:list, it DOES enrich
// openSessions -- via openSessionsLive (src/fleet/state.ts), the targeted
// alternative to fleetState -- since a permanently-null "needs you" chip
// is not an acceptable trade for taking the index off the critical path.
// Still never sends historyCount or the sessions array.
// pushFleet itself never touches the database -- refreshPushEnrichment
// does, on the discovery interval (src/main/index.ts), not on every push
// (see its doc comment: openSessionsLive's candidate-cwd query measured
// 30-60ms warm against the real index, which scales with total events,
// not live-process count, so it does not belong on a path that can fire
// every ~250ms during a watcher burst).
describe('pushFleet / refreshPushEnrichment — the fleet:update push', () => {
  it('sends whatever refreshPushEnrichment last cached, never a sessions array', async () => {
    const db = openDb(':memory:');
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:'Reused the JWT helper.' }, contentHash:'b', subIndex:1 }),
    ]);
    const processes = await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/live\n';
      return '';
    });
    refreshPushEnrichment(db, processes);

    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as
      Parameters<typeof pushFleet>[0];
    pushFleet(win);
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0]!;
    expect(channel).toBe('fleet:update');
    expect('sessions' in payload).toBe(false);
    expect(payload.openSessions[0]!.match).toBe('unique');
    expect(payload.openSessions[0]!.lastProse).toBe('Reused the JWT helper.');
  });

  it('pushFleet itself never queries the database', async () => {
    const db = openDb(':memory:');
    insertEvents(db, [ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' })]);
    const processes = await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/live\n';
      return '';
    });
    refreshPushEnrichment(db, processes);

    const prepareSpy = vi.spyOn(db, 'prepare');
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as
      Parameters<typeof pushFleet>[0];
    pushFleet(win);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('sanitises an enriched open card the same way buildFleetHistoryPayload does', async () => {
    const db = openDb(':memory:');
    const RLO = '‮';
    insertEvents(db, [
      ev({ kind:'session.started', payload:{ cwd:'/repo/live' }, contentHash:'a' }),
      ev({ kind:'prose', payload:{ text:`bad ${RLO} text` }, contentHash:'b', subIndex:1 }),
    ]);
    const processes = await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/live\n';
      return '';
    });
    refreshPushEnrichment(db, processes);

    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as
      Parameters<typeof pushFleet>[0];
    pushFleet(win);
    const payload = send.mock.calls[0]![1];
    expect(payload.openSessions[0]!.lastProse).not.toContain(RLO);
  });

  // Bug 2, wired end to end: refreshPushEnrichment (called here exactly as
  // src/main/index.ts's discovery interval calls it) must actually pass the
  // real launchedAtForPid through to openSessionsLive -- registerSession is
  // what src/main/launch.ts calls at the moment main launches a pid, and
  // this proves that recorded launch time is what turns an otherwise-
  // ambiguous cwd match (two sessions share '/repo/shared' here) into a
  // unique one for the pid the app itself started. A forgotten wire-up
  // (e.g. `openSessionsLive(db, processes, now, { isTmux: pidIsTmux })`
  // alone, dropping `launchedAtForPid`) would leave this 'ambiguous'.
  it("passes the real launch registry through, so a launched pid's ambiguous cwd match resolves to unique in the actual push", async () => {
    clearRegistry();
    try {
      const db = openDb(':memory:');
      insertEvents(db, [
        // s1 pre-existed before the app launched pid 4242.
        ev({ sessionId:'s1', kind:'session.started', ts:'2026-09-10T11:00:00Z',
          payload:{ cwd:'/repo/shared' }, contentHash:'a' }),
        // s2 is the session the app actually launched -- its first event
        // lands after the registered launch time.
        ev({ sessionId:'s2', kind:'session.started', ts:'2026-09-10T11:30:00Z',
          payload:{ cwd:'/repo/shared' }, contentHash:'b' }),
      ]);
      registerSession(4242, 'llmws-claude-abc', Date.parse('2026-09-10T11:15:00Z'));
      const processes = await refreshLiveProcesses(async (bin, args) => {
        if (bin === 'pgrep' && args[1] === 'claude') return '4242\n';
        if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/shared\n';
        return '';
      });
      refreshPushEnrichment(db, processes);

      const send = vi.fn();
      const win = { isDestroyed: () => false, webContents: { send } } as unknown as
        Parameters<typeof pushFleet>[0];
      pushFleet(win);
      const payload = send.mock.calls[0]![1];
      expect(payload.openSessions[0]!.match).toBe('unique');
      expect(payload.openSessions[0]!.sessionId).toBe('s2');
    } finally {
      clearRegistry();
    }
  });

  it('does nothing when there is no window', () => {
    expect(() => pushFleet(null)).not.toThrow();
  });

  it('does nothing when the window is destroyed', () => {
    const send = vi.fn();
    const win = { isDestroyed: () => true, webContents: { send } } as unknown as
      Parameters<typeof pushFleet>[0];
    pushFleet(win);
    expect(send).not.toHaveBeenCalled();
  });
});

// session:kill is the app's first destructive action. Every test here
// injects hop/exec/signal (never the real process.pid's actual ancestry,
// never a real discovery sweep, never process.kill) -- per the brief this
// was built from, no test may ever touch a real process.
describe('ownProcessAncestry', () => {
  it('walks from process.pid, including itself, one hop per parent, stopping at ppid <= 1', async () => {
    const hop = async (pid: number) => {
      if (pid === process.pid) return '9001 zsh';
      if (pid === 9001) return '1 launchd';
      throw new Error(`unexpected hop(${pid})`);
    };
    expect(await ownProcessAncestry(hop)).toEqual([process.pid, 9001]);
  });

  // Fail-soft in the safe direction: an unparsable hop (ps failed, or a
  // pid with no living parent) stops the walk rather than throwing --
  // an incomplete ancestor list can only under-protect a pid this walk
  // never reached, never wrongly clear one it did.
  it('stops the walk, without throwing, when a hop cannot be parsed', async () => {
    const hop = async () => ''; // ps failed / pid exited mid-lookup
    expect(await ownProcessAncestry(hop)).toEqual([process.pid]);
  });

  it('respects maxDepth rather than walking forever', async () => {
    const hop = async (pid: number) => `${pid + 1} something`; // never reaches ppid <= 1
    expect(await ownProcessAncestry(hop, 3)).toHaveLength(3);
  });
});

describe('killSession', () => {
  // process.pid has no discoverable ancestors in these fixtures -- most
  // tests below aren't exercising the ancestor guard, so their hop just
  // fails soft immediately (see ownProcessAncestry's own fail-soft test
  // above for why that is safe, not merely convenient).
  const noAncestors = async () => '';

  it('refuses a non-integer, non-positive, or wrong-typed pid -- and never refreshes discovery or signals', async () => {
    const signal = vi.fn();
    const exec = vi.fn(async () => '');
    for (const bad of [1.5, NaN, Infinity, -1, 0, '4242', null, undefined, {}, [4242]]) {
      expect(await killSession(bad, { hop: noAncestors, exec, signal }))
        .toEqual({ status: 'refused', reason: 'invalid_pid' });
    }
    expect(signal).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses this app's own process -- and never refreshes discovery or signals", async () => {
    const signal = vi.fn();
    const exec = vi.fn(async () => '');
    expect(await killSession(process.pid, { hop: noAncestors, exec, signal }))
      .toEqual({ status: 'refused', reason: 'own_process' });
    expect(signal).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses an ancestor of this app's own process -- and never refreshes discovery or signals", async () => {
    const signal = vi.fn();
    const exec = vi.fn(async () => '');
    const hop = async (pid: number) => (pid === process.pid ? '9001 zsh' : '1 launchd');
    expect(await killSession(9001, { hop, exec, signal }))
      .toEqual({ status: 'refused', reason: 'protected_ancestor' });
    expect(signal).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a pid absent from a freshly refreshed discovery sweep -- and never signals', async () => {
    const signal = vi.fn();
    const exec: ExecFn = async () => ''; // sweep finds nothing at all
    expect(await killSession(4242, { hop: noAncestors, exec, signal }))
      .toEqual({ status: 'refused', reason: 'not_discovered' });
    expect(signal).not.toHaveBeenCalled();
  });

  // The one path that actually signals: pid is a positive integer, not
  // this app or an ancestor of it, and IS present in a sweep run by this
  // very call -- only then does a signal go out, and it is always SIGTERM.
  it('signals a freshly discovered pid with SIGTERM, never SIGKILL', async () => {
    const signal = vi.fn();
    const exec: ExecFn = async (bin, args) => (bin === 'pgrep' && args[1] === 'claude' ? '4242\n' : '');
    expect(await killSession(4242, { hop: noAncestors, exec, signal })).toEqual({ status: 'killed' });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  // Proves the refresh in killSession is real, not a read of whatever an
  // earlier test in this file left cached: seed the cache with an empty
  // sweep first, then prove a pid only this call's own exec reports is
  // still accepted -- that is only possible if killSession re-swept.
  it('refreshes discovery itself before validating, rather than trusting an existing cache', async () => {
    await refreshLiveProcesses(async () => '');
    expect(getCachedLiveProcesses().some(p => p.pid === 5555)).toBe(false);
    const signal = vi.fn();
    const exec: ExecFn = async (bin, args) => (bin === 'pgrep' && args[1] === 'codex' ? '5555\n' : '');
    expect(await killSession(5555, { hop: noAncestors, exec, signal })).toEqual({ status: 'killed' });
  });

  it('reports already_gone, not an error or a crash, when the process exits between validation and the signal', async () => {
    const exec: ExecFn = async (bin, args) => (bin === 'pgrep' && args[1] === 'claude' ? '4242\n' : '');
    const esrch = Object.assign(new Error('No such process'), { code: 'ESRCH' });
    const signal = vi.fn(() => { throw esrch; });
    expect(await killSession(4242, { hop: noAncestors, exec, signal })).toEqual({ status: 'already_gone' });
  });

  it('reports refused/signal_failed, not a throw, when the OS refuses the signal for another reason', async () => {
    const exec: ExecFn = async (bin, args) => (bin === 'pgrep' && args[1] === 'claude' ? '4242\n' : '');
    const eperm = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    const signal = vi.fn(() => { throw eperm; });
    expect(await killSession(4242, { hop: noAncestors, exec, signal }))
      .toEqual({ status: 'refused', reason: 'signal_failed' });
  });

  // Whole-branch review, item 1: forgetSession had zero production callers
  // -- killSession never removed a pid it just ended from the tmux
  // registry, so a long-running app doing many launches leaked one entry
  // per pid forever. Proven here by actually registering the pid first and
  // checking the registry afterwards -- not merely that the kill reported
  // success, which would pass even with the registry entry left behind.
  it('clears the tmux registry entry for a pid it just killed', async () => {
    clearRegistry();
    try {
      registerSession(4242, 'llmws-claude-abc');
      const exec: ExecFn = async (bin, args) => (bin === 'pgrep' && args[1] === 'claude' ? '4242\n' : '');
      expect(await killSession(4242, { hop: noAncestors, exec, signal: vi.fn() })).toEqual({ status: 'killed' });
      expect(tmuxNameForPid(4242)).toBeNull();
    } finally {
      clearRegistry();
    }
  });

  it('clears the tmux registry entry even when the process was already gone', async () => {
    clearRegistry();
    try {
      registerSession(4242, 'llmws-claude-abc');
      const exec: ExecFn = async (bin, args) => (bin === 'pgrep' && args[1] === 'claude' ? '4242\n' : '');
      const esrch = Object.assign(new Error('No such process'), { code: 'ESRCH' });
      const signal = vi.fn(() => { throw esrch; });
      expect(await killSession(4242, { hop: noAncestors, exec, signal })).toEqual({ status: 'already_gone' });
      expect(tmuxNameForPid(4242)).toBeNull();
    } finally {
      clearRegistry();
    }
  });

  it('leaves the registry alone when the kill is refused -- nothing was actually ended', async () => {
    clearRegistry();
    try {
      registerSession(4242, 'llmws-claude-abc');
      const exec: ExecFn = async () => ''; // sweep finds nothing -- not_discovered
      expect(await killSession(4242, { hop: noAncestors, exec, signal: vi.fn() }))
        .toEqual({ status: 'refused', reason: 'not_discovered' });
      expect(tmuxNameForPid(4242)).toBe('llmws-claude-abc');
    } finally {
      clearRegistry();
    }
  });
});

// Comments can contain the same channel names the assertion below looks for
// (e.g. a comment listing a channel that was since removed). Strip them so
// the assertion matches only code that actually runs -- same pattern as
// tests/main/security.test.ts.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

// B2 (whole-branch review, 2026-09-11): defaultHop used to call execFileP
// directly with no `timeout`, so an unresponsive `ps` hung ownProcessAncestry
// -- and so killSession, which awaits it before validating -- forever. It
// now shares discovery/live.ts's execFileSoft, whose own timeout+SIGKILL
// behaviour is proven behaviourally (a real hung subprocess) in
// tests/discovery/live.test.ts; defaultHop always shells to the real `ps`
// binary (not swappable to a command a test can make hang), so what is left
// to pin here is the wiring itself -- that this call site actually uses the
// shared, tested helper rather than a separate, untimed implementation.
describe('defaultHop (B2)', () => {
  it('delegates to the shared, timeout-bounded execFileSoft rather than a raw execFileP call', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    expect(ipc).toMatch(/execFileSoft\(\s*'ps'/);
    // The untimed local execFileP wrapper this replaced is gone entirely --
    // not just unused at this one call site, but removed, so it can't
    // regress back in.
    expect(ipc).not.toMatch(/execFileP/);
  });

  it('still resolves a real ps lookup end to end against this process\'s own pid (regression check for the refactor)', async () => {
    // No injected hop -- exercises the real defaultHop and the real `ps`
    // binary, against this test process's own (definitely live) pid, so it
    // cannot hang.
    const ancestry = await ownProcessAncestry();
    expect(ancestry[0]).toBe(process.pid);
  });
});

describe('IPC channel parity', () => {
  it('every channel main handles is exposed by the preload, and vice versa', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    const preload = strip(readFileSync('src/preload/index.ts', 'utf8'));
    const handled = [...ipc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]).sort();
    const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]).sort();
    expect(handled).toEqual(exposed);
  });
});

describe('revealSession', () => {
  // Same validation shape as killSession, and for the same reason: the pid
  // is the ONLY thing the renderer gets to say. Which application to bring
  // forward is looked up in main's own discovery data, so a compromised
  // renderer cannot name something for `open` to launch.
  it('refuses a pid absent from a freshly refreshed discovery sweep, and opens nothing', async () => {
    const open = vi.fn();
    const exec: ExecFn = async () => '';
    expect(await revealSession(4242, { exec, open }))
      .toEqual({ status: 'refused', reason: 'not_discovered' });
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the application main resolved for the host, not one the caller named', async () => {
    const open = vi.fn();
    const exec: ExecFn = async (bin, args) =>
      bin === 'pgrep' && args[1] === 'claude' ? '4242\n'
      : bin === 'ps' && args.includes('-o') ? '1 iTerm2\n' : '';
    const result = await revealSession(4242, { exec, open });
    if (result.status === 'revealed') {
      expect(open).toHaveBeenCalledTimes(1);
      expect(typeof open.mock.calls[0]![0]).toBe('string');
    } else {
      // A host classifyHost could not identify has nowhere to jump to.
      expect(result).toEqual({ status: 'refused', reason: 'not_discovered' });
      expect(open).not.toHaveBeenCalled();
    }
  });
});

describe('session:keys', () => {
  beforeEach(() => clearRegistry());

  it('refuses a pid with no tmux session -- the iTerm case', () => {
    expect(sendKeysFor(4821, 'hello', { has: () => true, send: () => ({ ok: true, stdout: '' }) }))
      .toEqual({ status: 'refused', reason: 'not_tmux' });
  });

  it('refuses when the session vanished between render and click', () => {
    registerSession(4821, 'llmws-claude-abc');
    // capture is mocked to SUCCEED here, deliberately: without it, dropping
    // the resolveLiveTmux() call (and falling back to plain `known`) still
    // reaches the real, absent tmux binary at the capture-pane check below,
    // which fails too and produces the same 'session_gone' -- a mutation
    // that survives by accident. Mocking capture as healthy isolates what
    // this test actually means to pin: resolveLiveTmux's own has() check.
    expect(sendKeysFor(4821, 'hello', {
      has: () => false,
      capture: () => ({ ok: true, stdout: '' }),
      send: () => ({ ok: true, stdout: '' }),
    })).toEqual({ status: 'refused', reason: 'session_gone' });
  });

  // Multi-line is delivered as a BRACKETED PASTE, not as keystrokes
  // (measured 2026-09-15: Claude Code receives a bracketed paste as one
  // message and does not submit on the embedded newlines). Three calls, in
  // this order, and send-keys -l is never one of them.
  it('delivers multi-line text as a bracketed paste, never as send-keys -l', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: Array<{ args: string[]; input?: string }> = [];
    const r = sendKeysFor(4821, 'line one\nline two', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[], input?: string) => { calls.push({ args, input }); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'sent' });
    // The buffer name is per-send (pid + counter), so it is captured from
    // the load call rather than hardcoded -- and the paste MUST name that
    // same buffer, which is the property that actually matters.
    const buffer = calls[0]!.args[2]!;
    expect(buffer).toMatch(/^llmws-p\d+-\d+$/);
    expect(calls.map(c => c.args)).toEqual([
      ['load-buffer', '-b', buffer, '-'],
      ['paste-buffer', '-p', '-d', '-b', buffer, '-t', '=llmws-claude-abc:'],
      ['send-keys', '-t', '=llmws-claude-abc:', 'Enter'],
    ]);
    expect(calls[0]!.input).toBe('line one\nline two');
    // The keystroke path never sees a newline. This is the assertion that
    // keeps the relaxation confined to the paste path.
    for (const c of calls) {
      if (c.args.includes('-l')) expect(c.args.at(-1)).not.toMatch(/\n/);
    }
  });

  it('keeps single-line text on the unchanged send-keys -l path, with no buffer involved', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = sendKeysFor(4821, 'yes', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'sent' });
    expect(calls).toEqual([
      ['send-keys', '-t', '=llmws-claude-abc:', '-l', 'yes'],
      ['send-keys', '-t', '=llmws-claude-abc:', 'Enter'],
    ]);
  });

  it('refuses, and sends no Enter, when the buffer cannot be loaded', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = sendKeysFor(4821, 'a\nb', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[]) => {
        calls.push(args);
        return args[0] === 'load-buffer' ? { ok: false, error: 'no server' } : { ok: true, stdout: '' };
      },
    });
    expect(r).toEqual({ status: 'refused', reason: 'session_gone' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['load-buffer', '-b']);
    // The real tmux error must not be swallowed behind the generic
    // "That session has ended." the user is shown.
    expect(errs).toHaveBeenCalledWith('tmux load-buffer failed:', 'no server');
    errs.mockRestore();
  });

  // A failed paste leaves the loaded buffer behind. With a per-send buffer
  // name nothing later overwrites it, so it would accumulate on the tmux
  // server for as long as the server lives -- hence an explicit delete.
  it('deletes the buffer, logs the real error, and sends no Enter when the paste fails', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = sendKeysFor(4821, 'a\nb', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[]) => {
        calls.push(args);
        return args[0] === 'paste-buffer' ? { ok: false, error: 'no pane' } : { ok: true, stdout: '' };
      },
    });
    expect(r).toEqual({ status: 'refused', reason: 'session_gone' });
    const buffer = calls[0]![2]!;
    expect(calls.map(c => c[0])).toEqual(['load-buffer', 'paste-buffer', 'delete-buffer']);
    expect(calls[2]).toEqual(['delete-buffer', '-b', buffer]);
    expect(errs).toHaveBeenCalledWith('tmux paste-buffer failed:', 'no pane');
    errs.mockRestore();
  });

  // Critical: two app instances sharing one tmux server. tmux REPLACES a
  // named buffer rather than creating a second, so a fixed name lets
  // A.load, B.load, A.paste deliver B's text into A's session and submit
  // it. Every send therefore gets its own name.
  it('never reuses a buffer name between sends, so two instances cannot cross messages', () => {
    registerSession(4821, 'llmws-claude-abc');
    const names: string[] = [];
    const deps = {
      has: () => true,
      capture: () => ({ ok: true as const, stdout: '' }),
      send: (args: string[]) => {
        if (args[0] === 'load-buffer') names.push(args[2]!);
        return { ok: true as const, stdout: '' };
      },
    };
    sendKeysFor(4821, 'a\nb', deps);
    sendKeysFor(4821, 'c\nd', deps);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    // The pid segment is what separates two app instances from each other.
    for (const n of names) expect(n).toBe(`llmws-p${process.pid}-${n.split('-')[2]}`);
  });

  // The choice guard is not path-specific: a multi-line message must be
  // refused while a picker is open exactly as a single-line one is.
  it('still refuses a multi-line message with prompt_open, and touches no buffer', () => {
    registerSession(4821, 'llmws-claude-abc');
    let called = false;
    const r = sendKeysFor(4821, 'a\nb', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: () => { called = true; return { ok: true, stdout: '' }; },
      promptOpen: () => true,
    });
    expect(r).toEqual({ status: 'refused', reason: 'prompt_open' });
    expect(called).toBe(false);
  });

  it('sends text and Enter as two separate calls, text first, with -l', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = sendKeysFor(4821, 'yes', {
      has: () => true,
      // The pane is confirmed live before anything is sent -- see the
      // capture-pane test below for the refusal path this stands in for.
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
    });
    expect(r).toEqual({ status: 'sent' });
    expect(calls).toHaveLength(2);
    // Trailing ':' on the target -- tmux.ts's target() appends it because a
    // real tmux 3.7c server rejects a bare '=name' for target-PANE commands
    // (send-keys included) with "can't find pane"; see tmux.test.ts.
    expect(calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', 'yes']);
    expect(calls[1]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', 'Enter']);
  });

  // spec §9: the session name resolving is not proof the pane is still
  // there to receive anything -- re-verify with a real capture, immediately
  // before sending, not just that the name exists.
  it('refuses when the pane no longer looks like the session we think it is', () => {
    registerSession(4821, 'llmws-claude-abc');
    const r = sendKeysFor(4821, 'yes', {
      has: () => true,
      capture: () => ({ ok: false as const, error: 'no such pane' }),
      send: () => ({ ok: true, stdout: '' }),
    });
    expect(r).toEqual({ status: 'refused', reason: 'session_gone' });
  });

  // Reply guard (2026-09-15 in-app testing): a choice (a question picker or
  // a permission prompt) ignores typed text and Enter selects whichever
  // option is highlighted -- measured the same day, "blue" recorded as
  // "Red". Nothing may be sent while one is open.
  it('refuses with prompt_open, and never calls send, when a choice is open', () => {
    registerSession(4821, 'llmws-claude-abc');
    let called = false;
    const r = sendKeysFor(4821, 'yes', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: () => { called = true; return { ok: true, stdout: '' }; },
      promptOpen: () => true,
    });
    expect(r).toEqual({ status: 'refused', reason: 'prompt_open' });
    expect(called).toBe(false);
  });

  it('still sends text and Enter when promptOpen reports no choice is open', () => {
    registerSession(4821, 'llmws-claude-abc');
    const calls: string[][] = [];
    const r = sendKeysFor(4821, 'yes', {
      has: () => true,
      capture: () => ({ ok: true, stdout: '' }),
      send: (args: string[]) => { calls.push(args); return { ok: true, stdout: '' }; },
      promptOpen: () => false,
    });
    expect(r).toEqual({ status: 'sent' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', '-l', 'yes']);
    expect(calls[1]).toEqual(['send-keys', '-t', '=llmws-claude-abc:', 'Enter']);
  });
});

// promptOpenFor's own decision rule, independent of sendKeysFor's plumbing
// above (which only proves the refusal is wired in and nothing is sent).
// Exact status wins when there is one; only a cached PermissionRequest hook
// blocker (`waiting_permission`) counts as a choice through the fallback --
// hook-based `waiting_input` can be an ordinary text prompt, where Reply is
// exactly right, so it must NOT be treated as a choice.
describe('promptOpenFor', () => {
  const STARTED = 1_789_000_000_000;
  const proc = (o: Partial<LiveProcess> = {}): LiveProcess => ({
    pid: 50, provider: 'claude', tty: null, cwd: '/a', host: 'iterm2', ageSeconds: 60, rssBytes: null,
    liveSession: { sessionId: 's', cwd: '/a', startedAtMs: STARTED, status: 'idle' }, ...o,
  });
  const fresh = (status: 'idle' | 'busy' | 'waiting' | null, startedAtMs = STARTED): LiveSessionRead =>
    ({ ok: true, file: { sessionId: 's', cwd: '/a', startedAtMs, status } });

  it('a fresh waiting status is a choice', () => {
    expect(promptOpenFor(50, { cached: [], processes: [proc()], read: () => fresh('waiting') })).toBe(true);
  });

  it('a fresh idle status wins over a cached waiting_permission', () => {
    const cached = [{ pid: 50, provider: 'claude', activity: 'waiting_permission' } as OpenSession];
    expect(promptOpenFor(50, { cached, processes: [proc()], read: () => fresh('idle') })).toBe(false);
  });

  it('a fresh busy status is not a choice', () => {
    expect(promptOpenFor(50, { cached: [], processes: [proc()], read: () => fresh('busy') })).toBe(false);
  });

  it('falls back to a cached waiting_permission when the fresh status is null', () => {
    const cached = [{ pid: 50, provider: 'claude', activity: 'waiting_permission' } as OpenSession];
    expect(promptOpenFor(50, { cached, processes: [proc()], read: () => fresh(null) })).toBe(true);
  });

  it('does not treat a cached waiting_input as a choice', () => {
    const cached = [{ pid: 50, provider: 'claude', activity: 'waiting_input' } as OpenSession];
    expect(promptOpenFor(50, { cached, processes: [proc()], read: () => fresh(null) })).toBe(false);
  });

  it('falls back to the cache when the fresh read is from a different process instance', () => {
    const cached = [{ pid: 50, provider: 'claude', activity: 'waiting_permission' } as OpenSession];
    expect(promptOpenFor(50, { cached, processes: [proc()], read: () => fresh('waiting', STARTED + 60_000) })).toBe(true);
  });

  it('never reads for Codex, and reports no choice', () => {
    const read = vi.fn((): LiveSessionRead => fresh('waiting'));
    expect(promptOpenFor(50, { cached: [], processes: [proc({ provider: 'codex' })], read })).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('is false when nothing identifies the pid', () => {
    expect(promptOpenFor(99, { cached: [], processes: [], read: () => fresh(null) })).toBe(false);
  });
});

describe('terminal:data parity', () => {
  // The parity test above only sees ipcMain.handle/ipcRenderer.invoke, so a
  // push channel is invisible to it and ships unguarded otherwise.
  it('every webContents.send channel has a matching ipcRenderer.on in preload', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    const preload = strip(readFileSync('src/preload/index.ts', 'utf8'));
    const pushed = [...ipc.matchAll(/webContents\.send\('([^']+)'/g)].map(m => m[1]).sort();
    const heard = [...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map(m => m[1]).sort();
    expect(pushed).toEqual(heard);
  });
});

// Task 13 replaced the stubs with real handlers backed by src/main/launch.ts
// -- updated (not deleted, per the controller's instruction) to assert the
// real wiring instead. Asserting on source, the same way the B2 and
// security-posture tests above do, rather than on a call through
// registerIpc: registerIpc dereferences the real `ipcMain`, which is
// undefined under plain-node vitest (see this file's top-of-module
// comment), so a call-through test would throw regardless of which channel
// it targeted. launchSession/reattachSession's own actual behaviour is
// tests/main/launch.test.ts's job; this only proves ipc.ts still reaches
// them rather than a hardcoded stub or something else entirely -- if a
// future change reintroduces the not_implemented literal, or rewires either
// channel away from launch.ts, this fails loudly instead of quietly
// regressing.
describe("session:launch / session:reattach -- Task 13's real handlers", () => {
  it('no longer answer with the not_implemented stub', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    expect(ipc).not.toMatch(/'session:launch',\s*\(\)\s*=>\s*\(\{\s*status:\s*'failed',\s*reason:\s*'not_implemented'\s*\}\)/);
    expect(ipc).not.toMatch(/'session:reattach',\s*\(\)\s*=>\s*\(\{\s*status:\s*'failed',\s*reason:\s*'not_implemented'\s*\}\)/);
  });

  it('are wired to launchSession and reattachSession from src/main/launch.ts', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    expect(ipc).toMatch(/import\s*\{[^}]*launchSession[^}]*\}\s*from\s*'\.\/launch\.ts'/);
    expect(ipc).toMatch(/import\s*\{[^}]*reattachSession[^}]*\}\s*from\s*'\.\/launch\.ts'/);
    const launchHandler = ipc.match(/ipcMain\.handle\(\s*'session:launch',([\s\S]*?)\n {2}\}\);/)?.[1] ?? '';
    const reattachHandler = ipc.match(/ipcMain\.handle\(\s*'session:reattach',([\s\S]*?)\n {2}\}\);/)?.[1] ?? '';
    expect(launchHandler).toMatch(/launchSession\(/);
    expect(reattachHandler).toMatch(/reattachSession\(/);
  });

  // Fix-wave item 5's recovery path: session:resume is what a retry after
  // 'killed_not_relaunched' calls -- same source-assertion shape as above,
  // for the same plain-node-vitest reason.
  it('session:resume is wired to resumeSession from src/main/launch.ts', () => {
    const ipc = strip(readFileSync('src/main/ipc.ts', 'utf8'));
    expect(ipc).toMatch(/import\s*\{[^}]*resumeSession[^}]*\}\s*from\s*'\.\/launch\.ts'/);
    const resumeHandler = ipc.match(/ipcMain\.handle\(\s*'session:resume',([\s\S]*?)\n {2}\}\);/)?.[1] ?? '';
    expect(resumeHandler).toMatch(/resumeSession\(/);
  });
});

describe('resolveReattachTarget', () => {
  const STARTED = 1_789_000_000_000;
  const proc = (o: Partial<LiveProcess> = {}): LiveProcess => ({
    pid: 50, provider: 'claude', tty: null, cwd: '/repo/a', host: 'iterm2', ageSeconds: 60, rssBytes: null,
    liveSession: { sessionId: 'before-clear', cwd: '/repo/a', startedAtMs: STARTED, status: 'idle' }, ...o,
  });
  const cached = [{ pid: 50, provider: 'claude', cwd: '/repo/a', sessionId: 'before-clear' } as OpenSession];
  const fresh = (sessionId: string, startedAtMs = STARTED, cwd = '/repo/a'): LiveSessionRead =>
    ({ ok: true, file: { sessionId, cwd, startedAtMs, status: 'idle' } });

  it('uses a fresh read when /clear changed the session since the last sweep', () => {
    // cwd deliberately differs from the cached entry's '/repo/a' -- proves
    // the returned cwd comes from the fresh read, not merely echoed from
    // the stale cache alongside a fresh sessionId.
    const r = resolveReattachTarget(50, { cached, processes: [proc()], read: () => fresh('after-clear', STARTED, '/repo/a-moved') });
    expect(r).toEqual({ sessionId: 'after-clear', provider: 'claude', cwd: '/repo/a-moved' });
  });

  it('ignores a fresh read from a different process instance (start time changed)', () => {
    const r = resolveReattachTarget(50, { cached, processes: [proc()], read: () => fresh('someone-else', STARTED + 60_000) });
    expect(r).toEqual({ sessionId: 'before-clear', provider: 'claude', cwd: '/repo/a' });
  });

  it('falls back to the cache when the fresh read fails', () => {
    const r = resolveReattachTarget(50, { cached, processes: [proc()], read: () => ({ ok: false, reason: 'missing' }) });
    expect(r).toEqual({ sessionId: 'before-clear', provider: 'claude', cwd: '/repo/a' });
  });

  it('does not read at all for a process discovery never verified', () => {
    const read = vi.fn((): LiveSessionRead => fresh('x'));
    const { liveSession: _omit, ...unverified } = proc();
    resolveReattachTarget(50, { cached, processes: [unverified], read });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not read for Codex', () => {
    const read = vi.fn((): LiveSessionRead => fresh('x'));
    resolveReattachTarget(50, { cached, processes: [proc({ provider: 'codex' })], read });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns null when nothing identifies the pid', () => {
    expect(resolveReattachTarget(99, { cached, processes: [], read: () => ({ ok: false, reason: 'missing' }) })).toBeNull();
  });
});

// The shared helper resolveReattachTarget above (and promptOpenFor) are both
// built on: the rest of its behaviour is already covered through
// resolveReattachTarget's own tests, since it now calls this directly.
describe('freshLiveSession', () => {
  it('returns null when the start time differs', () => {
    const STARTED = 1_789_000_000_000;
    const proc: LiveProcess = {
      pid: 50, provider: 'claude', tty: null, cwd: '/repo/a', host: 'iterm2', ageSeconds: 60, rssBytes: null,
      liveSession: { sessionId: 's', cwd: '/repo/a', startedAtMs: STARTED, status: 'idle' },
    };
    const read = (): LiveSessionRead =>
      ({ ok: true, file: { sessionId: 's', cwd: '/repo/a', startedAtMs: STARTED + 1, status: 'idle' } });
    expect(freshLiveSession(50, [proc], read)).toBeNull();
  });
});
