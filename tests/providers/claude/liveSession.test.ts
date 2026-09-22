import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLiveSessionFile, readLiveSessionFile, startTimeAgrees, chosenName,
  LIVE_SESSION_MAX_BYTES, LIVE_SESSION_START_TOLERANCE_MS, LIVE_SESSION_PROC_START_TOLERANCE_MS,
} from '../../../src/providers/claude/liveSession.ts';

// Shape copied from a real ~/.claude/sessions/<pid>.json (Claude Code
// 2.1.270), with every identifying value replaced.
const REAL_SHAPE = {
  pid: 14041, sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/Users/me/trellome',
  startedAt: 1789408337635, procStart: 'Mon Sep 14 17:52:16 2026', version: '2.1.270',
  peerProtocol: 1, peerFeatures: ['notify_idle'], kind: 'interactive', entrypoint: 'cli',
  pidDomain: 'darwin', tmux: 'llmws-claude-00000000:@0.%0', messagingSocketPath: '/tmp/cc-socks/14041.sock',
  name: 'trellome-35', nameSource: 'derived', nameSince: 1789408337635, status: 'idle',
  updatedAt: 1789410297851, statusUpdatedAt: 1789410297851, bridgeSessionId: 'session_0000',
};
const text = (o: object) => JSON.stringify(o);

describe('parseLiveSessionFile', () => {
  it('reads the fields the app uses from the real shape', () => {
    expect(parseLiveSessionFile(text(REAL_SHAPE), 14041)).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000001', cwd: '/Users/me/trellome',
      startedAtMs: 1789408337635, status: 'idle', statusUpdatedAtMs: 1789410297851,
      waitingFor: null, procStartMs: 1789408336000,
      name: 'trellome-35', nameSource: 'derived',
    });
  });

  // Claude Code writes the session's own display name here -- the one
  // `claude -n` sets at launch and `/rename` changes later. Same tolerance
  // as every other optional field in this file: an unrecognised shape nulls
  // the field, it never rejects the file.
  it('reads name and nameSource, and nulls either without rejecting the file', () => {
    const named = { ...REAL_SHAPE, name: 'FLEET STUFF', nameSource: 'user' };
    expect(parseLiveSessionFile(text(named), 14041)?.name).toBe('FLEET STUFF');
    expect(parseLiveSessionFile(text(named), 14041)?.nameSource).toBe('user');

    const { name: _n, nameSource: _s, ...unnamed } = REAL_SHAPE;
    const parsed = parseLiveSessionFile(text(unnamed), 14041);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBeNull();
    expect(parsed?.nameSource).toBeNull();

    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, name: 42 }), 14041)?.name).toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, nameSource: ['user'] }), 14041)?.nameSource).toBeNull();
    // A blank name is no name -- never a blank card title.
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, name: '   ' }), 14041)?.name).toBeNull();
    // An unrecognised nameSource is kept verbatim: chosenName below reads
    // it as "not derived", which is the rule, not a shape to police here.
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, nameSource: 'cli' }), 14041)?.nameSource).toBe('cli');
  });
});

// The rule the card and the conversation header both follow, in one place:
// `derived` means Claude invented the name for itself, and the folder is
// the better label; anything else means a person chose it, and it wins.
describe('chosenName', () => {
  const file = (over: Record<string, unknown>) =>
    parseLiveSessionFile(text({ ...REAL_SHAPE, ...over }), 14041)!;

  it('ignores a name Claude derived for itself', () => {
    expect(chosenName(file({ name: 'server-new-20', nameSource: 'derived' }))).toBeNull();
  });

  it('keeps a name a person chose with /rename', () => {
    expect(chosenName(file({ name: 'FLEET STUFF', nameSource: 'user' }))).toBe('FLEET STUFF');
  });

  it('keeps a name from any source that is not "derived" -- including one this app has never seen', () => {
    expect(chosenName(file({ name: 'FLEET STUFF', nameSource: 'cli' }))).toBe('FLEET STUFF');
    const { nameSource: _drop, ...noSource } = REAL_SHAPE;
    expect(chosenName(parseLiveSessionFile(text({ ...noSource, name: 'FLEET STUFF' }), 14041)!)).toBe('FLEET STUFF');
  });

  it('is null when there is no name at all', () => {
    const { name: _n, ...unnamed } = REAL_SHAPE;
    expect(chosenName(parseLiveSessionFile(text(unnamed), 14041)!)).toBeNull();
  });

  // KNOWN_ISSUES.md, "A slow trust-prompt accept can permanently hide a
  // session's waiting card" (fixed 2026-09-18): `procStart` is Claude's own
  // ctime/asctime-shaped string ("Www Mmm dd hh:mm:ss yyyy"), in UTC
  // (measured against `ps -o lstart=` for live pids). Malformed or absent
  // never rejects the file -- same tolerance as every other optional field
  // here -- it only leaves startTimeAgrees (below) without its fallback.
  it('parses procStart into procStartMs, nulling it when malformed or missing', () => {
    expect(parseLiveSessionFile(text(REAL_SHAPE), 14041)?.procStartMs).toBe(1789408336000);
    const { procStart: _omit, ...noProcStart } = REAL_SHAPE;
    expect(parseLiveSessionFile(text(noProcStart), 14041)?.procStartMs).toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, procStart: 42 }), 14041)?.procStartMs).toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, procStart: '2026-09-14T17:52:16Z' }), 14041)?.procStartMs)
      .toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, procStart: 'Mon Sep 14 17:52:16' }), 14041)?.procStartMs)
      .toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, procStart: '' }), 14041)?.procStartMs).toBeNull();
  });

  // Quick answers design §3/§5.1: `waitingFor` is `"permission prompt"` for
  // Bash, Write and plan approval, `"input needed"` for a question -- the
  // signal deriveActivity (src/fleet/state.ts) uses to tell the two kinds
  // of waiting apart from the status file alone. Same tolerance as every
  // other optional field here: absent or the wrong type nulls it rather
  // than rejecting the file.
  it('reads waitingFor when present, and nulls it when absent or not a string', () => {
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: 'waiting', waitingFor: 'permission prompt' }), 14041)
      ?.waitingFor).toBe('permission prompt');
    expect(parseLiveSessionFile(text(REAL_SHAPE), 14041)?.waitingFor).toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, waitingFor: 42 }), 14041)?.waitingFor).toBeNull();
  });

  // buildSessionLive (src/main/sessionLive.ts) times a busy Claude session
  // from this field -- a missing or non-numeric value must fall back to no
  // "since" signal, the same tolerance startedAt gets, rather than
  // rejecting a file that is otherwise valid.
  it('nulls statusUpdatedAtMs when statusUpdatedAt is missing or not a number, without rejecting the file', () => {
    const { statusUpdatedAt: _omit, ...noStatusUpdatedAt } = REAL_SHAPE;
    expect(parseLiveSessionFile(text(noStatusUpdatedAt), 14041)?.statusUpdatedAtMs).toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, statusUpdatedAt: 'later' }), 14041)?.statusUpdatedAtMs).toBeNull();
  });

  it('accepts waiting and busy', () => {
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: 'waiting' }), 14041)?.status).toBe('waiting');
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: 'busy' }), 14041)?.status).toBe('busy');
  });

  it('keeps the file but nulls an unrecognised or missing status', () => {
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: 'thinking' }), 14041)?.status).toBeNull();
    expect(parseLiveSessionFile(text({ ...REAL_SHAPE, status: null }), 14041)?.status).toBeNull();
  });

  it.each([
    ['a different pid', { ...REAL_SHAPE, pid: 999 }],
    ['a session id with shell characters', { ...REAL_SHAPE, sessionId: '$(rm -rf ~)' }],
    ['an empty session id', { ...REAL_SHAPE, sessionId: '' }],
    ['a relative cwd', { ...REAL_SHAPE, cwd: 'repo' }],
    ['a missing startedAt', { ...REAL_SHAPE, startedAt: undefined }],
    ['a non-finite startedAt', { ...REAL_SHAPE, startedAt: 'yesterday' }],
  ])('rejects %s', (_label, o) => {
    expect(parseLiveSessionFile(text(o), 14041)).toBeNull();
  });

  it('rejects non-object JSON and invalid JSON', () => {
    expect(parseLiveSessionFile('[]', 14041)).toBeNull();
    expect(parseLiveSessionFile('null', 14041)).toBeNull();
    expect(parseLiveSessionFile('{not json', 14041)).toBeNull();
  });

  it('rejects text over the size cap', () => {
    const big = text({ ...REAL_SHAPE, name: 'x'.repeat(LIVE_SESSION_MAX_BYTES) });
    expect(parseLiveSessionFile(big, 14041)).toBeNull();
  });
});

describe('readLiveSessionFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'live-session-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads a valid regular file', () => {
    writeFileSync(join(dir, '14041.json'), text(REAL_SHAPE));
    const r = readLiveSessionFile(14041, dir);
    expect(r.ok && r.file.sessionId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('reports missing when the directory exists but the file does not', () => {
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports missing_dir when the directory itself is gone', () => {
    expect(readLiveSessionFile(14041, join(dir, 'nope'))).toEqual({ ok: false, reason: 'missing_dir' });
  });

  it('refuses a symlink, even one pointing at a valid file', () => {
    const real = join(dir, 'elsewhere.json');
    writeFileSync(real, text(REAL_SHAPE));
    symlinkSync(real, join(dir, '14041.json'));
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'not_regular_file' });
  });

  it('refuses a directory in place of the file', () => {
    mkdirSync(join(dir, '14041.json'));
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'not_regular_file' });
  });

  it('refuses a file over the size cap before parsing it', () => {
    writeFileSync(join(dir, '14041.json'), 'x'.repeat(LIVE_SESSION_MAX_BYTES + 1));
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reports invalid for a malformed file', () => {
    writeFileSync(join(dir, '14041.json'), '{not json');
    expect(readLiveSessionFile(14041, dir)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a pid that is not a positive integer without touching the filesystem', () => {
    expect(readLiveSessionFile(-1, dir)).toEqual({ ok: false, reason: 'invalid' });
    expect(readLiveSessionFile(1.5, dir)).toEqual({ ok: false, reason: 'invalid' });
  });

  // Least privilege (spec §3.1): the module reads exactly <pid>.json and
  // never enumerates the directory, which also holds .key files.
  it('never lists the directory', () => {
    const src = readFileSync('src/providers/claude/liveSession.ts', 'utf8');
    expect(src).not.toMatch(/readdir|opendir/);
  });
});

describe('startTimeAgrees', () => {
  const NOW = 1_789_500_000_000;
  const file = (startedAtMs: number, procStartMs: number | null = null) =>
    ({ sessionId: 's', cwd: '/a', startedAtMs, status: null, procStartMs });

  it('accepts a start within the tolerance', () => {
    expect(startTimeAgrees(file(NOW - 323_000 + 900), 323, NOW)).toBe(true);
    expect(startTimeAgrees(file(NOW - 323_000 - LIVE_SESSION_START_TOLERANCE_MS), 323, NOW)).toBe(true);
  });

  it('rejects a start outside the tolerance (pid reuse)', () => {
    expect(startTimeAgrees(file(NOW - 323_000 - LIVE_SESSION_START_TOLERANCE_MS - 1), 323, NOW)).toBe(false);
  });

  it('rejects when the process age is unknown', () => {
    expect(startTimeAgrees(file(NOW), null, NOW)).toBe(false);
    expect(startTimeAgrees(file(NOW), undefined, NOW)).toBe(false);
  });

  // KNOWN_ISSUES.md, "A slow trust-prompt accept can permanently hide a
  // session's waiting card" (fixed 2026-09-18): a slow folder-trust accept
  // rewrites `startedAt` to the accept moment, well outside the 5 s
  // tolerance, but leaves `procStart` alone. processStart here is
  // `NOW - 323_000` (a 323 s old process).
  it('accepts a rewritten startedAt (43 s off) when procStart still agrees with the process', () => {
    const processStart = NOW - 323_000;
    expect(startTimeAgrees(file(processStart + 43_000, processStart + 400), 323, NOW)).toBe(true);
  });

  it('rejects when procStart is off by more than its own tolerance and startedAt also disagrees', () => {
    const processStart = NOW - 323_000;
    expect(startTimeAgrees(
      file(processStart + 43_000, processStart + LIVE_SESSION_PROC_START_TOLERANCE_MS + 1_000), 323, NOW,
    )).toBe(false);
  });

  it('rejects a pid-reuse file where both startedAt and procStart disagree with the process', () => {
    const processStart = NOW - 323_000;
    expect(startTimeAgrees(file(processStart + 90_000, processStart + 90_000), 323, NOW)).toBe(false);
  });
});
