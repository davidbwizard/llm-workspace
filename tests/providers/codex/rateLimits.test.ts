import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseTokenCountLine, lastRateLimitsInFile, newestRollouts, readCodexRateLimits,
} from '../../../src/providers/codex/rateLimits.ts';

// Real-shaped rollout lines (Codex 0.154 token_count events, content and
// paths redacted) -- tests/fixtures/usage/codex-rollout.jsonl. Line 4 is a
// token_count with info:null, line 6 the newest one with rate_limits (27%
// weekly primary, a 5-hour secondary), line 8 a later one with
// rate_limits:null.
const FIXTURE = readFileSync(resolve('tests/fixtures/usage/codex-rollout.jsonl'), 'utf8');
const LINES = FIXTURE.trimEnd().split('\n');
const WEEKLY_RESET_MS = 1_789_830_549_000;
const FIVE_HOUR_RESET_MS = 1_789_702_200_000;
const LINE6_TS = Date.parse('2026-09-17T18:50:02.400Z');
const NOW = Date.parse('2026-09-17T19:00:00Z');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llmws-codex-limits-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseTokenCountLine', () => {
  it('reads primary, secondary, plan type and timestamp from a real-shaped token_count', () => {
    expect(parseTokenCountLine(LINES[5]!)).toEqual({
      primary: { usedPct: 27, windowMinutes: 10080, resetsAt: WEEKLY_RESET_MS },
      secondary: { usedPct: 4.5, windowMinutes: 300, resetsAt: FIVE_HOUR_RESET_MS },
      planType: 'self_serve_business_prolite',
      updatedAt: LINE6_TS,
    });
  });

  it('reads one whose info is null and whose secondary is null', () => {
    expect(parseTokenCountLine(LINES[3]!)).toEqual({
      primary: { usedPct: 25, windowMinutes: 10080, resetsAt: WEEKLY_RESET_MS },
      secondary: null,
      planType: 'self_serve_business_prolite',
      updatedAt: Date.parse('2026-09-17T18:49:30.050Z'),
    });
  });

  it('is null for a token_count with rate_limits: null, and for any other record', () => {
    expect(parseTokenCountLine(LINES[7]!)).toBeNull();
    expect(parseTokenCountLine(LINES[0]!)).toBeNull();
    expect(parseTokenCountLine(LINES[6]!)).toBeNull();
    expect(parseTokenCountLine('{"half":')).toBeNull();
    expect(parseTokenCountLine('')).toBeNull();
  });

  function withLimits(fn: (rl: any) => void): string {
    const rec = JSON.parse(LINES[5]!);
    fn(rec.payload.rate_limits);
    return JSON.stringify(rec);
  }

  it('drops a window with a bad percentage, and is null when neither window is usable', () => {
    expect(parseTokenCountLine(withLimits(rl => { rl.secondary.used_percent = '4.5'; }))?.secondary).toBeNull();
    expect(parseTokenCountLine(withLimits(rl => { rl.primary.used_percent = -1; rl.secondary = null; }))).toBeNull();
  });

  it('keeps a window with a missing reset time or length, as null', () => {
    const r = parseTokenCountLine(withLimits(rl => { delete rl.primary.resets_at; rl.primary.window_minutes = 'week'; }));
    expect(r?.primary).toEqual({ usedPct: 27, windowMinutes: null, resetsAt: null });
  });

  it('drops a plan type that is not a short plain identifier', () => {
    expect(parseTokenCountLine(withLimits(rl => { rl.plan_type = 'pro‮'; }))?.planType).toBeNull();
    expect(parseTokenCountLine(withLimits(rl => { rl.plan_type = 'x'.repeat(65); }))?.planType).toBeNull();
    expect(parseTokenCountLine(withLimits(rl => { rl.plan_type = 7; }))?.planType).toBeNull();
    expect(parseTokenCountLine(withLimits(rl => { rl.plan_type = 'plus'; }))?.planType).toBe('plus');
  });

  it('has updatedAt null when the timestamp is missing or bad', () => {
    const rec = JSON.parse(LINES[5]!);
    rec.timestamp = 'yesterday';
    expect(parseTokenCountLine(JSON.stringify(rec))?.updatedAt).toBeNull();
  });
});

describe('lastRateLimitsInFile -- a tail read, never the whole file', () => {
  function file(text: string): string {
    const path = join(dir, 'rollout-2026-09-17T18-49-11-x.jsonl');
    writeFileSync(path, text);
    return path;
  }

  it('finds the last token_count that has rate limits, skipping a later one without', () => {
    expect(lastRateLimitsInFile(file(FIXTURE))?.primary?.usedPct).toBe(27);
  });

  it.each([7, 64, 333, 4096])('finds it across chunk boundaries (chunk %d bytes)', (chunkBytes) => {
    const bigOutput = JSON.stringify({ timestamp: '2026-09-17T18:50:10.000Z', type: 'response_item',
      payload: { type: 'function_call_output', output: 'y'.repeat(50_000) } });
    const path = file(FIXTURE + bigOutput + '\n' + LINES[8] + '\n');
    expect(lastRateLimitsInFile(path, { chunkBytes })?.updatedAt).toBe(LINE6_TS);
  });

  it('finds a token_count that is the very first line', () => {
    expect(lastRateLimitsInFile(file(LINES[5] + '\n'))?.primary?.usedPct).toBe(27);
  });

  it('tolerates a half-written last line', () => {
    expect(lastRateLimitsInFile(file(FIXTURE + '{"timestamp":"2026-09-17T18:51:00Z","type":"event_msg","payl'))
      ?.primary?.usedPct).toBe(27);
  });

  it('gives up past its byte budget rather than read a huge file to the start', () => {
    const bigOutput = JSON.stringify({ type: 'response_item', payload: { output: 'y'.repeat(20_000) } });
    const path = file(FIXTURE + bigOutput + '\n');
    expect(lastRateLimitsInFile(path, { maxBytes: 10_000 })).toBeNull();
    expect(lastRateLimitsInFile(path, { maxBytes: 100_000 })?.primary?.usedPct).toBe(27);
  });

  it('is null for a file with no rate limits, an empty file, or a missing file', () => {
    expect(lastRateLimitsInFile(file(LINES.slice(6).join('\n') + '\n'))).toBeNull();
    expect(lastRateLimitsInFile(file(''))).toBeNull();
    expect(lastRateLimitsInFile(join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('finding the newest rollouts', () => {
  function rollout(day: string, name: string, mtimeSec: number, text = FIXTURE): string {
    const d = join(dir, day);
    mkdirSync(d, { recursive: true });
    const path = join(d, name);
    writeFileSync(path, text);
    utimesSync(path, mtimeSec, mtimeSec);
    return path;
  }

  it('returns at most five rollout files, newest by mtime first, including an older day still being written', () => {
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) paths.push(rollout('2026/09/18', `rollout-2026-09-18T0${i}-00-00-a${i}.jsonl`, 1_789_700_000 + i));
    const longRunning = rollout('2026/09/17', 'rollout-2026-09-17T07-21-08-long.jsonl', 1_789_700_100);
    writeFileSync(join(dir, '2026/09/18', 'notes.txt'), 'x');

    const got = newestRollouts(dir).map(r => r.path);
    expect(got).toEqual([longRunning, paths[5], paths[4], paths[3], paths[2]]);
  });

  it('is empty for a missing root', () => {
    expect(newestRollouts(join(dir, 'missing'))).toEqual([]);
  });

  describe('readCodexRateLimits', () => {
    it('reports the most recent rate limits among the newest rollouts', () => {
      const olderEvent = LINES.slice(0, 4).join('\n') + '\n'; // only the 25% token_count
      rollout('2026/09/17', 'rollout-2026-09-17T18-49-11-a.jsonl', 1_789_700_050);
      rollout('2026/09/18', 'rollout-2026-09-18T01-00-00-b.jsonl', 1_789_700_090, olderEvent);

      expect(readCodexRateLimits(dir, NOW)).toEqual({
        primary: { usedPct: 27, windowMinutes: 10080, resetsAt: WEEKLY_RESET_MS },
        secondary: { usedPct: 4.5, windowMinutes: 300, resetsAt: FIVE_HOUR_RESET_MS },
        planType: 'self_serve_business_prolite',
        updatedAt: LINE6_TS,
      });
    });

    it('leaves out a window that has already reset', () => {
      rollout('2026/09/17', 'rollout-2026-09-17T18-49-11-a.jsonl', 1_789_700_050);
      const r = readCodexRateLimits(dir, FIVE_HOUR_RESET_MS + 1);
      expect(r?.secondary).toBeUndefined();
      expect(r?.primary?.usedPct).toBe(27);
    });

    it('is null once every window has reset, or with no rate limits anywhere', () => {
      rollout('2026/09/17', 'rollout-2026-09-17T18-49-11-a.jsonl', 1_789_700_050);
      expect(readCodexRateLimits(dir, WEEKLY_RESET_MS + 1)).toBeNull();
      rmSync(join(dir, '2026'), { recursive: true });
      rollout('2026/09/17', 'rollout-2026-09-17T18-49-11-b.jsonl', 1_789_700_050, LINES.slice(6).join('\n') + '\n');
      expect(readCodexRateLimits(dir, NOW)).toBeNull();
      expect(readCodexRateLimits(join(dir, 'missing'), NOW)).toBeNull();
    });

    it('sees new lines appended to a file it already read', () => {
      const path = rollout('2026/09/17', 'rollout-2026-09-17T18-49-11-a.jsonl', 1_789_700_050);
      expect(readCodexRateLimits(dir, NOW)?.primary?.usedPct).toBe(27);
      const rec = JSON.parse(LINES[5]!);
      rec.timestamp = '2026-09-17T18:55:00.000Z';
      rec.payload.rate_limits.primary.used_percent = 31;
      appendFileSync(path, JSON.stringify(rec) + '\n');
      utimesSync(path, 1_789_700_060, 1_789_700_060);
      expect(readCodexRateLimits(dir, NOW)?.primary?.usedPct).toBe(31);
    });
  });
});
