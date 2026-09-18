import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync, appendFileSync, symlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseTokenCountLine, lastRateLimitsInFile, newestRollouts, readCodexRateLimits,
  parseTokenUsageLine, lastUsageInFile, readCodexContext,
} from '../../../src/providers/codex/rateLimits.ts';

// M1's readSync-short-read test needs to intercept the module's own
// readSync without disturbing every other node:fs call this file makes;
// node:fs's real ESM export is non-configurable (vi.spyOn cannot redefine
// it), so the indirection is a mutable ref a real vi.mock factory forwards
// through, restored to the real function after the one test that uses it.
const { readSyncRef } = vi.hoisted(() => ({ readSyncRef: { current: null as unknown as typeof import('node:fs').readSync } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  readSyncRef.current = actual.readSync;
  return { ...actual, readSync: (...args: Parameters<typeof actual.readSync>) => readSyncRef.current(...args) };
});

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

  // M1: readSync's return value, not the requested length, is the only
  // trustworthy measure of what actually landed in a Buffer.allocUnsafe.
  // This forges a short read that plants a fake, otherwise-well-formed
  // token_count (used_percent: 99) exactly where the unchecked code would
  // go looking first -- so a version that trusts the buffer regardless of
  // what readSync returned would confidently report 99, not null.
  it('returns null, never a value read from past the byte count readSync actually returned', () => {
    const path = file(FIXTURE);
    const fakeLine = JSON.stringify({
      timestamp: '2026-09-17T19:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 99 } } },
    });
    const poison = Buffer.from('\n' + fakeLine, 'utf8');
    const real = readSyncRef.current;
    readSyncRef.current = ((fd, buf, offset, length, position) => {
      const n = real(fd, buf, offset, length, position);
      poison.copy(buf as Buffer, (buf as Buffer).length - poison.length);
      return n - poison.length;
    }) as typeof real;
    try {
      expect(lastRateLimitsInFile(path)).toBeNull();
    } finally {
      readSyncRef.current = real;
    }
  });

  // M2: opened O_NONBLOCK, so a FIFO planted at the path (by another
  // process, or an attacker with write access to the folder) is refused
  // immediately rather than hanging the caller forever waiting for a writer.
  it.runIf(process.platform !== 'win32')('returns null immediately for a FIFO, never blocking', () => {
    const path = join(dir, 'rollout-2026-09-17T18-49-11-fifo.jsonl');
    execFileSync('mkfifo', [path]);
    expect(lastRateLimitsInFile(path)).toBeNull();
  });

  // M2: opened O_NOFOLLOW, so a symlink is refused at open time -- never
  // followed, even to a legitimate rollout.
  it('returns null for a symlink, never following it', () => {
    const real = join(dir, 'elsewhere.jsonl');
    writeFileSync(real, FIXTURE);
    const link = join(dir, 'rollout-2026-09-17T18-49-11-link.jsonl');
    symlinkSync(real, link);
    expect(lastRateLimitsInFile(link)).toBeNull();
  });

  it('returns null for a directory, without logging an error', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(lastRateLimitsInFile(dir)).toBeNull();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
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

  // M2: lstat, not stat -- a symlinked rollout is never counted among the
  // newest, so it can never bump out a real one or leak its target's mtime.
  it('excludes a symlinked rollout, even one newer than every real one', () => {
    const real = rollout('2026/09/17', 'rollout-2026-09-17T07-21-08-real.jsonl', 1_789_700_000);
    const target = join(dir, 'target.jsonl');
    writeFileSync(target, FIXTURE);
    utimesSync(target, 1_789_800_000, 1_789_800_000); // newer than `real`
    const link = join(dir, '2026/09/17', 'rollout-2026-09-17T09-00-00-link.jsonl');
    symlinkSync(target, link);

    expect(newestRollouts(dir).map(r => r.path)).toEqual([real]);
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

// Codex context (usage design, Part A follow-up): the rollout's latest
// token_count that carries usage. tests/fixtures/usage/codex-rollout-context.jsonl
// is a real-shaped CLI rollout (Codex 0.154, content redacted): line 6 and
// line 9 carry usage (window 258400), line 13 is the next turn's
// rate-limits-only token_count (info: null), which must be skipped.
//
// used = last_token_usage.input_tokens ALONE. In the rollout,
// cached_input_tokens is a SUBSET of input_tokens (OpenAI accounting):
// measured over 821 real usages on this machine, cached <= input every time
// and total_tokens == input_tokens + output_tokens in all 713 that carry
// input counts. Adding cached would double-count it. That makes input_tokens
// the same "whole prompt the model saw, output excluded" as Claude's
// input + cache_creation + cache_read.
describe('Codex context from the latest token_count', () => {
  const CTX = readFileSync(resolve('tests/fixtures/usage/codex-rollout-context.jsonl'), 'utf8');
  const CTX_LINES = CTX.trimEnd().split('\n');

  it('reads used = last_token_usage.input_tokens (cached is already inside it) and the model window', () => {
    expect(parseTokenUsageLine(CTX_LINES[8]!)).toEqual({ usedTokens: 184_212, windowTokens: 258_400 });
    expect(parseTokenUsageLine(CTX_LINES[5]!)).toEqual({ usedTokens: 59_521, windowTokens: 258_400 });
  });

  it('is null (keep looking) for a token_count with no usage, and for any other record', () => {
    expect(parseTokenUsageLine(CTX_LINES[12]!)).toBeNull();
    expect(parseTokenUsageLine(CTX_LINES[0]!)).toBeNull();
    expect(parseTokenUsageLine('{"half":')).toBeNull();
  });

  function withInfo(fn: (info: any) => void): string {
    const rec = JSON.parse(CTX_LINES[8]!);
    fn(rec.payload.info);
    return JSON.stringify(rec);
  }

  it('reports a total-only record (input 0, no window -- seen from Codex Desktop) as unknown, not zero', () => {
    const line = withInfo(info => {
      info.last_token_usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 119_280 };
      info.model_context_window = null;
    });
    expect(parseTokenUsageLine(line)).toEqual({ usedTokens: null, windowTokens: null });
  });

  it('type-checks each field on its own', () => {
    expect(parseTokenUsageLine(withInfo(i => { i.last_token_usage.input_tokens = '184212'; }))?.usedTokens).toBeNull();
    expect(parseTokenUsageLine(withInfo(i => { i.model_context_window = 0; }))?.windowTokens).toBeNull();
    expect(parseTokenUsageLine(withInfo(i => { i.model_context_window = '258400'; }))?.windowTokens).toBeNull();
    expect(parseTokenUsageLine(withInfo(i => { i.last_token_usage = null; }))).toBeNull();
  });

  function file(text: string): string {
    const path = join(dir, 'rollout-2026-09-17T12-04-04-01a0b0c1.jsonl');
    writeFileSync(path, text);
    return path;
  }

  it.each([7, 100, 4096, 65536])('finds the latest usage from the end, past the next turn\'s info:null (chunk %d)', (chunkBytes) => {
    expect(lastUsageInFile(file(CTX), { chunkBytes })).toEqual({ usedTokens: 184_212, windowTokens: 258_400 });
  });

  it('stops at the latest usage even when it is unusable, rather than show an older count', () => {
    const unusable = withInfo(info => { info.model_context_window = null; });
    expect(lastUsageInFile(file(CTX + unusable + '\n'))).toEqual({ usedTokens: 184_212, windowTokens: null });
  });

  it('gives up past its byte budget', () => {
    const big = JSON.stringify({ type: 'response_item', payload: { output: 'y'.repeat(20_000) } });
    expect(lastUsageInFile(file(CTX + big + '\n'), { maxBytes: 10_000 })).toBeNull();
  });

  describe('readCodexContext', () => {
    it('reads a rollout, and re-reads it only when it changes', () => {
      const path = file(CTX);
      expect(readCodexContext(path)).toEqual({ usedTokens: 184_212, windowTokens: 258_400 });
      const next = withInfo(info => { info.last_token_usage.input_tokens = 200_000; });
      appendFileSync(path, next + '\n');
      expect(readCodexContext(path)).toEqual({ usedTokens: 200_000, windowTokens: 258_400 });
    });

    it('is null for a missing file or a symlink', () => {
      expect(readCodexContext(join(dir, 'missing.jsonl'))).toBeNull();
      const real = file(CTX);
      const link = join(dir, 'rollout-link.jsonl');
      symlinkSync(real, link);
      expect(readCodexContext(link)).toBeNull();
    });

    // M2: opened O_NONBLOCK, same as the rate-limits reader -- a FIFO
    // planted at the path never blocks the caller.
    it.runIf(process.platform !== 'win32')('returns null immediately for a FIFO, never blocking', () => {
      const path = join(dir, 'rollout-fifo.jsonl');
      execFileSync('mkfifo', [path]);
      expect(readCodexContext(path)).toBeNull();
    });
  });
});
