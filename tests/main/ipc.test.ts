import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import {
  buildFleetPayload, SANITISED_FIELDS, STRUCTURAL_FIELDS,
  BLOCKER_SANITISED_FIELDS, BLOCKER_STRUCTURAL_FIELDS,
} from '../../src/main/ipc.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';

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
  // per-field special-casing) is proven end to end by the next test, on
  // `text`, which -- via tool_input.command -- genuinely is reachable.
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
