import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, type Db } from '../../src/store/db.ts';
import { insertEvents } from '../../src/store/ingest.ts';
import type { NormalizedEvent } from '../../src/core/types.ts';
import type { OpenSession } from '../../src/fleet/state.ts';
import { resolvePaths } from '../../src/config.ts';
import {
  latestTurns, claudeContextFor, codexRollouts, codexContextFor, withContext, buildUsagePayload,
} from '../../src/main/usage.ts';

const SNAPSHOT = readFileSync(resolve('tests/fixtures/usage/claude-statusline.json'), 'utf8');
const SNAP_ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const ROLLOUT = readFileSync(resolve('tests/fixtures/usage/codex-rollout.jsonl'), 'utf8');
const CONTEXT_ROLLOUT = readFileSync(resolve('tests/fixtures/usage/codex-rollout-context.jsonl'), 'utf8');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llmws-usage-main-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'claude', sessionId: 's1', runId: 'r1', agentId: null,
    ts: '2026-09-18T12:00:00Z', kind: 'turn.completed', payload: {}, nativeId: null,
    sourceFile: '/f', sourceOffset: 0, contentHash: 'h', subIndex: 0, parserVersion: 1, ...o,
  } as NormalizedEvent;
}

function tokens(input: number, read: number, write: number, model = 'claude-opus-5') {
  return { inputTokens: input, outputTokens: 50, cacheReadTokens: read, cacheWriteTokens: write, model };
}

describe('latestTurns -- the fallback when there is no status line snapshot', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    insertEvents(db, [
      ev({ ts: '2026-09-18T12:00:00Z', payload: tokens(10, 1000, 100), contentHash: 'a' }),
      ev({ ts: '2026-09-18T12:05:00Z', payload: tokens(3, 150_000, 2_000), contentHash: 'b' }),
      // A subagent's own turn is not the main conversation's context.
      ev({ ts: '2026-09-18T12:06:00Z', agentId: 'agent-x', payload: tokens(5, 900_000, 0), contentHash: 'c' }),
      // A synthetic record with no tokens is not a measurement.
      ev({ ts: '2026-09-18T12:07:00Z', payload: tokens(0, 0, 0, '<synthetic>'), contentHash: 'd' }),
      ev({ ts: '2026-09-18T12:08:00Z', kind: 'prose', payload: { text: 'hi' }, contentHash: 'e' }),
      ev({ sessionId: 's2', ts: '2026-09-18T11:00:00Z', payload: tokens(1, 2, 3, 'claude-haiku-4-5'), contentHash: 'f' }),
    ]);
  });

  it("returns each session's latest main-thread turn with tokens, in one query", () => {
    const prepare = vi.spyOn(db, 'prepare');
    const got = latestTurns(db, ['s1', 's2', 'nobody']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(got.get('s1')).toEqual({ usedTokens: 152_003, modelId: 'claude-opus-5', tsMs: Date.parse('2026-09-18T12:05:00Z') });
    expect(got.get('s2')).toEqual({ usedTokens: 6, modelId: 'claude-haiku-4-5', tsMs: Date.parse('2026-09-18T11:00:00Z') });
    expect(got.has('nobody')).toBe(false);
  });

  it('runs no query for no sessions', () => {
    const prepare = vi.spyOn(db, 'prepare');
    expect(latestTurns(db, []).size).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('claudeContextFor / codexContextFor / withContext', () => {
  let db: Db;
  let statusLineDir: string;
  let codexSessions: string;
  let rolloutPath: string;
  const opts = () => ({ statusLineDir, codexSessions });
  beforeEach(() => {
    db = openDb(':memory:');
    statusLineDir = join(dir, 'statusline');
    mkdirSync(statusLineDir);
    codexSessions = join(dir, 'codex-sessions');
    mkdirSync(join(codexSessions, '2026/09/17'), { recursive: true });
    rolloutPath = join(codexSessions, '2026/09/17', 'rollout-2026-09-17T12-04-04-01a0b0c1.jsonl');
    writeFileSync(rolloutPath, CONTEXT_ROLLOUT);
    insertEvents(db, [
      ev({ sessionId: SNAP_ID, ts: '2026-09-18T12:00:00Z', payload: tokens(1, 100, 0), contentHash: 'a' }),
      ev({ sessionId: 'turn-only', ts: '2026-09-18T12:00:00Z', payload: tokens(3, 120_000, 0, 'claude-haiku-4-5'), contentHash: 'b' }),
      ev({ provider: 'codex', sessionId: 'codex-1', kind: 'prose', ts: '2026-09-17T19:05:41Z',
        payload: { text: 'Two findings' }, sourceFile: rolloutPath, contentHash: 'c' }),
    ]);
    const snap = join(statusLineDir, `${SNAP_ID}.json`);
    writeFileSync(snap, SNAPSHOT);
    const after = Date.parse('2026-09-18T12:01:00Z') / 1000;
    utimesSync(snap, after, after);
  });

  it('uses the snapshot, else the latest turn, else null', () => {
    const got = claudeContextFor(db, [SNAP_ID, 'turn-only', 'nothing'], opts());
    expect(got.get(SNAP_ID)).toEqual({ usedTokens: 462_000, windowTokens: 1_000_000, leftPct: 54 });
    expect(got.get('turn-only')).toEqual({ usedTokens: 120_003, windowTokens: 200_000, leftPct: 40 });
    expect(got.get('nothing')).toBeNull();
  });

  function open(o: Partial<OpenSession> & { pid: number }): OpenSession {
    return {
      provider: 'claude', host: 'unknown', cwd: '/repo/x', project: 'x', ageSeconds: null, rssBytes: null,
      match: 'unique', sessionId: null, lastProse: null, events: null, activity: null, tmux: false,
      junk: false, context: null, agents: null, liveAgents: null, name: null, ...o,
    };
  }

  it("gives a Codex session its rollout's latest usage against the model window", () => {
    // 184,212 of 258,400: (258,400 - 184,212) / 258,400 -> 28.7 -> 29.
    expect(codexContextFor(db, ['codex-1', 'no-rollout'], opts()))
      .toEqual(new Map([['codex-1', { usedTokens: 184_212, windowTokens: 258_400, leftPct: 29 }], ['no-rollout', null]]));
  });

  it('fills context on Claude and Codex cards with a session, and leaves unmatched cards null', () => {
    const cards = [
      open({ pid: 1, sessionId: SNAP_ID }),
      open({ pid: 2, sessionId: 'turn-only' }),
      open({ pid: 3, sessionId: null, match: 'ambiguous' }),
      open({ pid: 4, provider: 'codex', sessionId: 'codex-1' }),
      open({ pid: 5, provider: 'codex', sessionId: null, match: 'ambiguous' }),
    ];
    const got = withContext(db, cards, opts());
    expect(got.map(c => c.context?.leftPct ?? null)).toEqual([54, 40, null, 29, null]);
    // Order and every other field untouched.
    expect(got.map(({ context: _c, ...rest }) => rest)).toEqual(cards.map(({ context: _c, ...rest }) => rest));
  });

  it('runs no query when no card needs one', () => {
    const prepare = vi.spyOn(db, 'prepare');
    withContext(db, [open({ pid: 5, provider: 'codex', sessionId: null, match: 'ambiguous' })], opts());
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('codexRollouts -- which file holds a Codex session', () => {
  const root = '/Users/me/.codex/sessions';
  const day = `${root}/2026/09/17`;
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    const codex = (o: Partial<NormalizedEvent>) => ev({ provider: 'codex', kind: 'prose', payload: { text: 'x' }, ...o });
    insertEvents(db, [
      codex({ sessionId: 'c1', ts: '2026-09-17T10:00:00Z', sourceFile: `${day}/rollout-2026-09-17T10-00-00-old.jsonl`, contentHash: 'a' }),
      codex({ sessionId: 'c1', ts: '2026-09-17T11:00:00Z', sourceFile: `${day}/rollout-2026-09-17T11-00-00-new.jsonl`, contentHash: 'b' }),
      // A subagent thread shares the root's session id but writes its own
      // rollout; its usage is not the conversation's context.
      codex({ sessionId: 'c1', agentId: 'thread-sub', ts: '2026-09-17T12:00:00Z',
        sourceFile: `${day}/rollout-2026-09-17T12-00-00-sub.jsonl`, contentHash: 'c' }),
      codex({ sessionId: 'outside', sourceFile: '/tmp/evil/rollout-x.jsonl', contentHash: 'd' }),
      codex({ sessionId: 'dotdot', sourceFile: `${root}/../../evil/rollout-x.jsonl`, contentHash: 'e' }),
      codex({ sessionId: 'not-a-rollout', sourceFile: `${day}/notes.jsonl`, contentHash: 'f' }),
    ]);
  });

  it("returns the root thread's latest rollout, in one query, and nothing outside the sessions folder", () => {
    const prepare = vi.spyOn(db, 'prepare');
    const got = codexRollouts(db, ['c1', 'outside', 'dotdot', 'not-a-rollout', 'nobody'], root);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(got).toEqual(new Map([['c1', `${day}/rollout-2026-09-17T11-00-00-new.jsonl`]]));
  });
});

describe('buildUsagePayload -- usage:get', () => {
  const NOW = Date.parse('2026-09-17T19:00:00Z');

  it('returns exactly { claude, codex } with each provider\'s current windows', () => {
    const paths = resolvePaths(dir);
    mkdirSync(paths.statusLineDir, { recursive: true });
    const snap = join(paths.statusLineDir, `${SNAP_ID}.json`);
    writeFileSync(snap, SNAPSHOT);
    utimesSync(snap, NOW / 1000 - 60, NOW / 1000 - 60);
    const day = join(paths.codexSessions, '2026/09/17');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-09-17T18-49-11-01a0b0b3.jsonl'), ROLLOUT);

    const payload = buildUsagePayload(paths, NOW);

    expect(payload).toEqual({
      claude: {
        fiveHour: { usedPct: 23.5, resetsAt: 1_789_840_800_000 },
        sevenDay: { usedPct: 41.2, resetsAt: 1_790_200_800_000 },
        updatedAt: NOW - 60_000,
      },
      codex: {
        primary: { usedPct: 27, windowMinutes: 10080, resetsAt: 1_789_830_549_000 },
        secondary: { usedPct: 4.5, windowMinutes: 300, resetsAt: 1_789_702_200_000 },
        planType: 'self_serve_business_prolite',
        updatedAt: Date.parse('2026-09-17T18:50:02.400Z'),
      },
    });
    // Plain data only: it crosses the IPC bridge by structured clone.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('is { claude: null, codex: null } with no data anywhere', () => {
    expect(buildUsagePayload(resolvePaths(dir), NOW)).toEqual({ claude: null, codex: null });
    expect(existsSync(join(dir, '.llm-workspace'))).toBe(false);
  });
});
