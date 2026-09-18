import { describe, it, expect } from 'vitest';
import {
  contextWindowFor, leftPct, buildContext, sessionContext, clampCompactsAt, currentWindow,
  COMPACTS_AT_DEFAULT,
} from '../../src/core/usage.ts';

describe('contextWindowFor -- the documented windows only', () => {
  it.each([
    ['claude-opus-5', 1_000_000],
    ['claude-sonnet-5', 1_000_000],
    ['claude-fable-5-1', 1_000_000],
    ['claude-haiku-4-5', 200_000],
    ['claude-haiku-4-5-20251001', 200_000],
    ['claude-opus-5-20260801', 1_000_000],
  ])('%s -> %d', (model, window) => {
    expect(contextWindowFor(model)).toBe(window);
  });

  it.each([
    ['an unknown model', 'claude-opus-4-1'],
    ['a look-alike prefix', 'claude-opus-50'],
    ['a synthetic record', '<synthetic>'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a non-dated suffix', 'claude-opus-5-preview'],
    ['a too-short date suffix', 'claude-opus-5-2025100'],
    ['a too-long date suffix', 'claude-opus-5-202510011'],
    ['a non-numeric date suffix', 'claude-opus-5-2025100a'],
  ])('is null for %s -- never guessed', (_label, model) => {
    expect(contextWindowFor(model)).toBeNull();
  });

  it('matches a bracket-suffixed id, like a date-suffixed one', () => {
    expect(contextWindowFor('claude-opus-5[1m]')).toBe(1_000_000);
  });
});

describe('leftPct -- percent left before the compaction point', () => {
  it('is max(0, round(100 * (1 - used / (window * compactsAt/100))))', () => {
    // 462k used of 1M, compacting at 83% (830k): 1 - 462/830 = 0.4434 -> 44.
    expect(leftPct(462_000, 1_000_000, 83)).toBe(44);
    expect(leftPct(0, 200_000, 83)).toBe(100);
    expect(leftPct(100_000, 200_000, 100)).toBe(50);
  });

  it('is 0, not negative, at or past the compaction point', () => {
    expect(leftPct(830_000, 1_000_000, 83)).toBe(0);
    expect(leftPct(990_000, 1_000_000, 83)).toBe(0);
  });

  it('moves with the setting', () => {
    expect(leftPct(400_000, 1_000_000, 50)).toBe(20);
    expect(leftPct(400_000, 1_000_000, 100)).toBe(60);
  });
});

describe('buildContext', () => {
  it('carries used, window and leftPct', () => {
    expect(buildContext(462_000, 1_000_000, 83)).toEqual({ usedTokens: 462_000, windowTokens: 1_000_000, leftPct: 44 });
  });

  it.each([
    ['no window', 1000, null],
    ['a zero window', 1000, 0],
    ['a negative used count', -1, 200_000],
    ['a non-finite used count', Number.NaN, 200_000],
  ])('is null for %s', (_label, used, window) => {
    expect(buildContext(used as number, window as number | null, 83)).toBeNull();
  });
});

describe('sessionContext -- which source, and which window', () => {
  const snapshot = (o: Partial<{ usedTokens: number | null; windowTokens: number | null; modelId: string | null; mtimeMs: number }> = {}) => ({
    usedTokens: 462_000, windowTokens: 1_000_000, modelId: 'claude-opus-5', mtimeMs: 2_000, ...o,
  });
  const turn = (o: Partial<{ usedTokens: number; modelId: string | null; tsMs: number }> = {}) => ({
    usedTokens: 120_000, modelId: 'claude-haiku-4-5', tsMs: 1_000, ...o,
  });

  it("uses the status line snapshot, with the snapshot's own window size", () => {
    expect(sessionContext({ snapshot: snapshot({ windowTokens: 200_000 }), turn: null }, 83))
      .toEqual({ usedTokens: 462_000, windowTokens: 200_000, leftPct: 0 });
  });

  it("falls back to the model's documented window when the snapshot has no size", () => {
    expect(sessionContext({ snapshot: snapshot({ windowTokens: null }), turn: null }, 83))
      .toEqual({ usedTokens: 462_000, windowTokens: 1_000_000, leftPct: 44 });
  });

  it('prefers the snapshot over an older turn', () => {
    expect(sessionContext({ snapshot: snapshot(), turn: turn({ tsMs: 1_000 }) }, 83)?.usedTokens).toBe(462_000);
  });

  it('uses the latest turn.completed when there is no snapshot, with the documented window for its model', () => {
    expect(sessionContext({ snapshot: null, turn: turn() }, 83))
      .toEqual({ usedTokens: 120_000, windowTokens: 200_000, leftPct: 28 });
  });

  it('uses a newer turn over a stale snapshot (the switch was turned off)', () => {
    expect(sessionContext({ snapshot: snapshot({ mtimeMs: 1_000 }), turn: turn({ tsMs: 5_000 }) }, 83)?.usedTokens)
      .toBe(120_000);
  });

  it('is null right after /compact: a fresh snapshot with no current usage wins over the older, pre-compact turn', () => {
    expect(sessionContext({ snapshot: snapshot({ usedTokens: null, mtimeMs: 9_000 }), turn: turn({ tsMs: 1_000 }) }, 83))
      .toBeNull();
  });

  it('is null when a fallback turn has a model with no documented window', () => {
    expect(sessionContext({ snapshot: null, turn: turn({ modelId: 'claude-opus-4-1' }) }, 83)).toBeNull();
  });

  it('is null with neither source', () => {
    expect(sessionContext({ snapshot: null, turn: null }, 83)).toBeNull();
  });
});

describe('clampCompactsAt', () => {
  it('defaults to 83', () => {
    expect(COMPACTS_AT_DEFAULT).toBe(83);
  });

  it.each([
    [83, 83], [50, 50], [100, 100], [49, 50], [0, 50], [-5, 50], [101, 100], [1e9, 100], [83.4, 83], [83.5, 84],
  ])('%d -> %d', (raw, clamped) => {
    expect(clampCompactsAt(raw)).toBe(clamped);
  });

  it.each([
    ['NaN', Number.NaN], ['Infinity', Infinity], ['a string', '90'], ['null', null], ['undefined', undefined],
    ['a boolean', true], ['an object', { compactsAt: 90 }],
  ])('refuses %s', (_label, raw) => {
    expect(clampCompactsAt(raw)).toBeNull();
  });
});

describe('currentWindow -- a window whose reset time has passed is gone', () => {
  it('keeps a window that resets in the future, and one with no reset time', () => {
    expect(currentWindow({ usedPct: 20, resetsAt: 2_000 }, 1_000)).toEqual({ usedPct: 20, resetsAt: 2_000 });
    expect(currentWindow({ usedPct: 20, resetsAt: null }, 1_000)).toEqual({ usedPct: 20, resetsAt: null });
  });

  it('drops one that has already reset', () => {
    expect(currentWindow({ usedPct: 20, resetsAt: 1_000 }, 1_000)).toBeNull();
    expect(currentWindow(null, 1_000)).toBeNull();
  });
});
