import { describe, it, expect } from 'vitest';
import { formatContextShort, formatResetIn, resetTextFor, formatUpdatedAgo, contextTone, clampBarPct } from '../../src/renderer/usageFormat.ts';

// Usage design, Part B: the context chip's short form. <1000 -> exact;
// <1,000,000 -> whole thousands with a "k" suffix, no decimals;
// >=1,000,000 -> one decimal with an "M" suffix.
describe('formatContextShort', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [999, '999'],
    [1000, '1k'],
    [2000, '2k'],
    [20_000, '20k'],
    [200_000, '200k'],
    [462_400, '462k'],
    [462_600, '463k'], // rounds, not truncates
    [999_999, '1000k'], // the boundary the design's own thresholds allow
    [1_000_000, '1.0M'],
    [1_234_567, '1.2M'],
    [12_000_000, '12.0M'],
  ])('formats %d as %s', (tokens, expected) => {
    expect(formatContextShort(tokens)).toBe(expected);
  });
});

describe('contextTone -- the chip\'s colour thresholds', () => {
  it('is critical below 10 left', () => {
    expect(contextTone(9)).toBe('critical');
    expect(contextTone(0)).toBe('critical');
  });
  it('is signal from 10 up to (not including) 20', () => {
    expect(contextTone(10)).toBe('signal');
    expect(contextTone(19)).toBe('signal');
  });
  it('is null (the normal muted tone) at 20 and above', () => {
    expect(contextTone(20)).toBeNull();
    expect(contextTone(100)).toBeNull();
  });
});

describe('formatResetIn', () => {
  it('shows hours and minutes together when both are non-zero', () => {
    expect(formatResetIn(2 * 3_600_000 + 10 * 60_000)).toBe('resets in 2h 10m');
  });
  it('drops the minutes when they round to exactly zero', () => {
    expect(formatResetIn(3 * 3_600_000)).toBe('resets in 3h');
  });
  it('shows minutes alone under an hour', () => {
    expect(formatResetIn(45 * 60_000)).toBe('resets in 45m');
  });
  it('rounds a sub-minute remainder up to 1m rather than showing 0m for a still-future time', () => {
    expect(formatResetIn(10_000)).toBe('resets in 1m');
  });
});

// Part A review note: resetsAt is not range-checked by main, so the
// renderer must never print a reset line for a non-finite or non-future
// time -- it omits the line entirely rather than a confusing "resets in
// -3m" or a NaN.
describe('resetTextFor -- only for a finite, future reset', () => {
  const now = 1_000_000;
  it('is null when there is no resetsAt at all', () => {
    expect(resetTextFor(null, now)).toBeNull();
  });
  it('is null for a non-finite resetsAt', () => {
    expect(resetTextFor(Number.NaN, now)).toBeNull();
    expect(resetTextFor(Number.POSITIVE_INFINITY, now)).toBeNull();
  });
  it('is null for a resetsAt at or before now', () => {
    expect(resetTextFor(now, now)).toBeNull();
    expect(resetTextFor(now - 1, now)).toBeNull();
  });
  it('formats a genuine future reset', () => {
    expect(resetTextFor(now + 10 * 60_000, now)).toBe('resets in 10m');
  });
});

describe('formatUpdatedAgo', () => {
  it('reports whole minutes elapsed', () => {
    expect(formatUpdatedAgo(1_000_000, 1_000_000 + 3 * 60_000)).toBe('updated 3 min ago');
  });
  it('never goes negative -- clock skew reads as just now', () => {
    expect(formatUpdatedAgo(1_000_000, 999_000)).toBe('updated 0 min ago');
  });
});

// Part A review note: usedPct has no upper cap (spend limits can exceed
// 100), so the bar's own visual width (and its aria-valuenow, which must
// never exceed the declared aria-valuemax of 100) has to be clamped
// separately from whatever text shows the real, possibly-over-100 number.
describe('clampBarPct', () => {
  it('passes an ordinary percentage through unchanged', () => {
    expect(clampBarPct(42)).toBe(42);
  });
  it('clamps a percentage over 100 down to 100', () => {
    expect(clampBarPct(142)).toBe(100);
  });
  it('floors a negative percentage to 0', () => {
    expect(clampBarPct(-5)).toBe(0);
  });
});
