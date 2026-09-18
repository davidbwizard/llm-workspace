import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync, symlinkSync, renameSync, statSync,
  existsSync, readdirSync, lstatSync, lutimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseClaudeSnapshot, readClaudeSnapshot, readClaudeRateLimits, pruneSnapshots, SNAPSHOT_MAX_BYTES,
} from '../../../src/providers/claude/statusLine.ts';

// Real-shaped status line snapshots (the documented stdin schema, with
// realistic values and a redacted home) -- tests/fixtures/usage/.
const FULL = readFileSync(resolve('tests/fixtures/usage/claude-statusline.json'), 'utf8');
const FIRST_TURN = readFileSync(resolve('tests/fixtures/usage/claude-statusline-first-turn.json'), 'utf8');
const FULL_ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const FIRST_ID = '9b8e7d6c-5a4b-4c3d-8e2f-0a1b2c3d4e5f';

function edit(text: string, fn: (o: any) => void): string {
  const o = JSON.parse(text);
  fn(o);
  return JSON.stringify(o);
}

describe('parseClaudeSnapshot', () => {
  it('reads the fields the app uses from a real-shaped snapshot', () => {
    expect(parseClaudeSnapshot(FULL)).toEqual({
      sessionId: FULL_ID,
      modelId: 'claude-opus-5',
      windowTokens: 1_000_000,
      // input + cache_creation + cache_read, never output (docs formula).
      usedTokens: 3 + 4997 + 457_000,
      fiveHour: { usedPct: 23.5, resetsAt: 1_789_840_800_000 },
      sevenDay: { usedPct: 41.2, resetsAt: 1_790_200_800_000 },
    });
  });

  it('reads a first-turn snapshot: no usage yet, no rate limits', () => {
    expect(parseClaudeSnapshot(FIRST_TURN)).toEqual({
      sessionId: FIRST_ID, modelId: 'claude-haiku-4-5-20251001', windowTokens: 200_000,
      usedTokens: null, fiveHour: null, sevenDay: null,
    });
  });

  it('keeps one rate-limit window when the other is absent', () => {
    const s = parseClaudeSnapshot(edit(FULL, o => { delete o.rate_limits.five_hour; }));
    expect(s?.fiveHour).toBeNull();
    expect(s?.sevenDay).toEqual({ usedPct: 41.2, resetsAt: 1_790_200_800_000 });
  });

  it('treats absent cache counts as zero', () => {
    const s = parseClaudeSnapshot(edit(FULL, o => {
      o.context_window.current_usage = { input_tokens: 1200, output_tokens: 10 };
    }));
    expect(s?.usedTokens).toBe(1200);
  });

  it.each([
    ['a string token count', (o: any) => { o.context_window.current_usage.input_tokens = '3'; }],
    ['a negative token count', (o: any) => { o.context_window.current_usage.cache_read_input_tokens = -1; }],
    ['a non-object current_usage', (o: any) => { o.context_window.current_usage = 'lots'; }],
    ['no context_window at all', (o: any) => { delete o.context_window; }],
  ])('drops usage (only) for %s', (_label, fn) => {
    const s = parseClaudeSnapshot(edit(FULL, fn));
    expect(s?.usedTokens).toBeNull();
    expect(s?.sessionId).toBe(FULL_ID);
  });

  it.each([
    ['a string size', (o: any) => { o.context_window.context_window_size = '1000000'; }],
    ['a zero size', (o: any) => { o.context_window.context_window_size = 0; }],
    ['a fractional size', (o: any) => { o.context_window.context_window_size = 1.5; }],
  ])('drops the window size for %s', (_label, fn) => {
    expect(parseClaudeSnapshot(edit(FULL, fn))?.windowTokens).toBeNull();
  });

  it.each([
    ['a string percentage', (o: any) => { o.rate_limits.five_hour.used_percentage = '23.5'; }],
    ['a negative percentage', (o: any) => { o.rate_limits.five_hour.used_percentage = -3; }],
    ['a non-object window', (o: any) => { o.rate_limits.five_hour = 23.5; }],
  ])('drops a rate-limit window for %s', (_label, fn) => {
    expect(parseClaudeSnapshot(edit(FULL, fn))?.fiveHour).toBeNull();
  });

  it('keeps a window whose reset time is missing or bad, with resetsAt null', () => {
    const s = parseClaudeSnapshot(edit(FULL, o => { o.rate_limits.five_hour.resets_at = 'soon'; }));
    expect(s?.fiveHour).toEqual({ usedPct: 23.5, resetsAt: null });
  });

  it('drops a model id that is not a short string', () => {
    expect(parseClaudeSnapshot(edit(FULL, o => { o.model.id = 42; }))?.modelId).toBeNull();
    expect(parseClaudeSnapshot(edit(FULL, o => { o.model.id = 'x'.repeat(200); }))?.modelId).toBeNull();
  });

  it('ignores unknown fields', () => {
    const s = parseClaudeSnapshot(edit(FULL, o => { o.brand_new = { deep: [1, 2] }; o.rate_limits.hourly = {}; }));
    expect(s?.usedTokens).toBe(462_000);
  });

  it.each([
    ['not JSON', 'nope'],
    ['a JSON array', '[1]'],
    ['JSON null', 'null'],
    ['no session_id', edit(FULL, o => { delete o.session_id; })],
    ['an unsafe session_id', edit(FULL, o => { o.session_id = '../evil'; })],
  ])('is null for %s', (_label, text) => {
    expect(parseClaudeSnapshot(text)).toBeNull();
  });
});

describe('reading snapshot files', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llmws-statusline-read-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function put(id: string, text: string, mtimeSec?: number): string {
    const path = join(dir, `${id}.json`);
    const tmp = join(dir, `.${id}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, path); // the way the helper writes: a new inode each time
    if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
    return path;
  }

  describe('readClaudeSnapshot', () => {
    it("returns the session's snapshot and the file's mtime", () => {
      const path = put(FULL_ID, FULL, 1_789_700_000);
      const r = readClaudeSnapshot(dir, FULL_ID);
      expect(r?.snapshot.usedTokens).toBe(462_000);
      expect(r?.mtimeMs).toBe(statSync(path).mtimeMs);
    });

    it('sees a rewrite (cached by file identity, never stale)', () => {
      put(FULL_ID, FULL);
      expect(readClaudeSnapshot(dir, FULL_ID)?.snapshot.usedTokens).toBe(462_000);
      put(FULL_ID, edit(FULL, o => { o.context_window.current_usage.cache_read_input_tokens = 500_000; }));
      expect(readClaudeSnapshot(dir, FULL_ID)?.snapshot.usedTokens).toBe(505_000);
    });

    it('is null for a missing file, an unsafe id, or an id that does not match the content', () => {
      expect(readClaudeSnapshot(dir, FULL_ID)).toBeNull();
      expect(readClaudeSnapshot(dir, '../etc/passwd')).toBeNull();
      put('someone-else', FULL);
      expect(readClaudeSnapshot(dir, 'someone-else')).toBeNull();
    });

    it('refuses a file over 64 KB without parsing it', () => {
      put(FULL_ID, edit(FULL, o => { o.pad = 'x'.repeat(SNAPSHOT_MAX_BYTES); }));
      expect(readClaudeSnapshot(dir, FULL_ID)).toBeNull();
    });

    it('refuses a symlink', () => {
      const real = join(dir, 'elsewhere.json');
      writeFileSync(real, FULL);
      symlinkSync(real, join(dir, `${FULL_ID}.json`));
      expect(readClaudeSnapshot(dir, FULL_ID)).toBeNull();
    });
  });

  describe('readClaudeRateLimits', () => {
    const NOW = 1_789_700_000_000; // before every fixture reset time

    it('takes the newest snapshot that has rate limits, with its mtime as updatedAt', () => {
      put(FIRST_ID, FIRST_TURN, 1_789_699_900); // newest, but no rate limits
      const withLimits = put(FULL_ID, FULL, 1_789_699_800);
      put('older-session', edit(FULL, o => {
        o.session_id = 'older-session';
        o.rate_limits.five_hour.used_percentage = 99;
      }), 1_789_699_000);

      expect(readClaudeRateLimits(dir, NOW)).toEqual({
        fiveHour: { usedPct: 23.5, resetsAt: 1_789_840_800_000 },
        sevenDay: { usedPct: 41.2, resetsAt: 1_790_200_800_000 },
        updatedAt: statSync(withLimits).mtimeMs,
      });
    });

    it('leaves out a window whose reset time has passed', () => {
      put(FULL_ID, FULL, 1_789_699_800);
      const afterFiveHourReset = 1_789_840_800_000;
      const r = readClaudeRateLimits(dir, afterFiveHourReset);
      expect(r?.fiveHour).toBeUndefined();
      expect(r?.sevenDay).toEqual({ usedPct: 41.2, resetsAt: 1_790_200_800_000 });
    });

    it('is null once every window has reset', () => {
      put(FULL_ID, FULL, 1_789_699_800);
      expect(readClaudeRateLimits(dir, 1_790_300_000_000)).toBeNull();
    });

    it('is null with no snapshots with rate limits, or no folder at all', () => {
      put(FIRST_ID, FIRST_TURN);
      expect(readClaudeRateLimits(dir, NOW)).toBeNull();
      expect(readClaudeRateLimits(join(dir, 'missing'), NOW)).toBeNull();
    });

    it('skips temp files, other names and oversized files', () => {
      writeFileSync(join(dir, '.statusline.AbC123'), FULL);
      writeFileSync(join(dir, 'notes.txt'), FULL);
      mkdirSync(join(dir, 'sub.json'));
      put(FULL_ID, edit(FULL, o => { o.pad = 'x'.repeat(SNAPSHOT_MAX_BYTES); }));
      expect(readClaudeRateLimits(dir, NOW)).toBeNull();
    });
  });
});

// Startup pruning (src/main/index.ts, next to rotateSpool): snapshot files
// untouched for 7 days are deleted -- only regular files named by the
// <session_id>.json rule, never through a symlink. Everything in a temp dir.
describe('pruneSnapshots', () => {
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmws-statusline-prune-'));
    outside = mkdtempSync(join(tmpdir(), 'llmws-statusline-outside-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const NOW = Date.parse('2026-09-18T12:00:00Z');
  const DAY = 86_400_000;

  function aged(path: string, ageMs: number): void {
    const t = (NOW - ageMs) / 1000;
    utimesSync(path, t, t);
  }
  function file(name: string, ageMs: number): string {
    const path = join(dir, name);
    writeFileSync(path, FULL);
    aged(path, ageMs);
    return path;
  }

  it('deletes snapshots older than 7 days and keeps newer ones', () => {
    file('old-session.json', 8 * DAY);
    file('ancient_1.json', 400 * DAY);
    file('recent-session.json', 6 * DAY);
    file('fresh.json', 0);

    expect(pruneSnapshots(dir, { maxAgeDays: 7, now: NOW })).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['fresh.json', 'recent-session.json']);
  });

  it('keeps a file exactly at the cutoff', () => {
    file('edge.json', 7 * DAY);
    expect(pruneSnapshots(dir, { maxAgeDays: 7, now: NOW })).toBe(0);
    expect(readdirSync(dir)).toEqual(['edge.json']);
  });

  it('never follows or removes a symlink, and never touches its old target', () => {
    const target = join(outside, 'precious.json');
    writeFileSync(target, 'keep me');
    aged(target, 30 * DAY);
    const link = join(dir, 'looks-like-a-session.json');
    symlinkSync(target, link);
    // The link itself is old too, so neither following it nor skipping the
    // regular-file check could let it survive by accident.
    const t = (NOW - 30 * DAY) / 1000;
    lutimesSync(link, t, t);
    expect(pruneSnapshots(dir, { maxAgeDays: 7, now: NOW })).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('leaves anything not named <session_id>.json alone, however old', () => {
    file('.statusline.AbC123', 30 * DAY);
    file('notes.txt', 30 * DAY);
    file('a.b.json', 30 * DAY);
    file(`${'a'.repeat(129)}.json`, 30 * DAY);
    const sub = join(dir, 'folder.json');
    mkdirSync(sub);
    aged(sub, 30 * DAY);

    expect(pruneSnapshots(dir, { maxAgeDays: 7, now: NOW })).toBe(0);
    expect(readdirSync(dir).length).toBe(5);
    expect(existsSync(sub)).toBe(true);
  });

  it('is a quiet no-op for a missing folder', () => {
    expect(pruneSnapshots(join(dir, 'missing'), { maxAgeDays: 7, now: NOW })).toBe(0);
  });
});
