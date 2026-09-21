import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  probeSessionFiles, openSessionFile, stripLineSuffix, MAX_MARKDOWN_BYTES,
  MAX_PROBE_CANDIDATES, MAX_CANDIDATE_CHARS, isPermissionError, type FileDeps,
} from '../../src/main/files.ts';
import { within } from '../../src/main/images.ts';

// This whole file is a security test with a feature attached. The candidate
// string comes out of agent-written transcript text by way of the renderer,
// and the thing at the other end of it is an OS call -- so the refusals are
// the subject here, not the happy path. Every test below that asserts a
// refusal is asserting that a string the model wrote did NOT reach `reveal`
// or `readFile`.

const PID = 4821;

// base/
//   project/                 <- the session's working directory
//     README.md
//     notes/deep.md
//     run.command            <- NOT markdown: reveal only, never launched
//     escape.md -> ../outside/secret.md
//     huge.md                <- one byte past the cap
//   outside/secret.md        <- what the symlink really points at
//   projectbackup/secret.md  <- the /foo/barbaz prefix case
let base = '';
let root = '';

beforeAll(async () => {
  // realpath the whole base: macOS's tmpdir is itself a symlink
  // (/var -> /private/var), so an un-resolved base would make every
  // containment assertion here pass or fail for the wrong reason.
  base = await realpath(await mkdtemp(join(tmpdir(), 'llmw-files-')));
  root = join(base, 'project');
  await mkdir(join(root, 'notes'), { recursive: true });
  await mkdir(join(base, 'outside'), { recursive: true });
  await mkdir(join(base, 'projectbackup'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Title\n\nBody text.\n');
  await writeFile(join(root, 'notes', 'deep.md'), '# Deep\n');
  await writeFile(join(root, 'run.command'), '#!/bin/sh\nsay pwned\n');
  await writeFile(join(root, 'huge.md'), 'x'.repeat(MAX_MARKDOWN_BYTES + 1));
  await writeFile(join(base, 'outside', 'secret.md'), '# Secret\n');
  await writeFile(join(base, 'projectbackup', 'secret.md'), '# Also secret\n');
  await symlink(join(base, 'outside', 'secret.md'), join(root, 'escape.md'));
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function deps(overrides: Partial<FileDeps> = {}): FileDeps {
  return {
    cwdForPid: pid => (pid === PID ? root : null),
    reveal: vi.fn(),
    ...overrides,
  };
}

const openOne = (candidate: unknown, d = deps(), pid: unknown = PID, reveal?: unknown) =>
  openSessionFile(pid, candidate, reveal, d);

describe('within: the separator-aware containment check', () => {
  // The reason this is not `real.startsWith(root)`. A naive prefix test
  // passes /foo/barbaz as inside /foo/bar, which is a different directory.
  it('refuses a sibling whose name merely starts with the root', () => {
    expect('/foo/barbaz'.startsWith('/foo/bar')).toBe(true);
    expect(within('/foo/barbaz', '/foo/bar')).toBe(false);
    expect(within(`/foo/barbaz${sep}x.md`, '/foo/bar')).toBe(false);
  });

  it('accepts the root itself and anything genuinely under it', () => {
    expect(within('/foo/bar', '/foo/bar')).toBe(true);
    expect(within(`/foo/bar${sep}x.md`, '/foo/bar')).toBe(true);
    expect(within(`/foo/bar${sep}a${sep}b.md`, '/foo/bar')).toBe(true);
  });
});

describe('openSessionFile: what never reaches the disk', () => {
  it('refuses a candidate that is not a string', async () => {
    for (const bad of [undefined, null, 42, {}, ['README.md']]) {
      expect(await openOne(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses an empty candidate', async () => {
    expect(await openOne('')).toEqual({ ok: false, reason: 'invalid' });
    expect(await openOne('   ')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a candidate carrying a NUL byte', async () => {
    // The truncation trick: everything after the NUL is invisible to a C
    // string, so a checked prefix and an opened path can differ.
    expect(await openOne('README.md\0../../outside/secret.md')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a candidate over the length cap', async () => {
    expect(await openOne('a'.repeat(MAX_CANDIDATE_CHARS + 1))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a pid that is not a live session in the app\'s own fleet state', async () => {
    expect(await openOne('README.md', deps(), 999999)).toEqual({ ok: false, reason: 'no_session' });
    expect(await openOne('README.md', deps(), -1)).toEqual({ ok: false, reason: 'invalid' });
    expect(await openOne('README.md', deps(), 1.5)).toEqual({ ok: false, reason: 'invalid' });
    expect(await openOne('README.md', deps(), '4821')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never takes the working directory from the caller of the candidate', async () => {
    // cwdForPid is the ONLY source of the root. A session the app does not
    // know has no root, so nothing resolves at all -- not even a path that
    // plainly exists on disk.
    const d = deps({ cwdForPid: () => null });
    expect(await openOne('README.md', d)).toEqual({ ok: false, reason: 'no_session' });
    expect(await openOne(join(root, 'README.md'), d)).toEqual({ ok: false, reason: 'no_session' });
  });

  it('refuses a path that escapes the root by traversal', async () => {
    const d = deps();
    expect(await openOne('../outside/secret.md', d)).toEqual({ ok: false, reason: 'outside_root' });
    expect(await openOne('notes/../../outside/secret.md', d)).toEqual({ ok: false, reason: 'outside_root' });
    expect(await openOne(join(base, 'outside', 'secret.md'), d)).toEqual({ ok: false, reason: 'outside_root' });
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it('refuses a symlink that sits INSIDE the project but points outside it', async () => {
    // The one the lexical check alone cannot catch: project/escape.md is
    // inside the root by every string test, and is a different directory
    // by realpath.
    const d = deps();
    expect(await openOne('escape.md', d)).toEqual({ ok: false, reason: 'outside_root' });
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it('refuses a sibling directory whose name merely starts with the root\'s', async () => {
    // /foo/barbaz against a /foo/bar root, on the real filesystem.
    const d = deps();
    expect(await openOne('../projectbackup/secret.md', d)).toEqual({ ok: false, reason: 'outside_root' });
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it('refuses a path that does not exist', async () => {
    expect(await openOne('nope.md')).toEqual({ ok: false, reason: 'not_found' });
    expect(await openOne('notes/nope.md')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses a markdown file past the size cap, and never reads it', async () => {
    const result = await openOne('huge.md');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'too_large', name: 'huge.md' });
    expect((result as { size: number }).size).toBeGreaterThan(MAX_MARKDOWN_BYTES);
    expect(result).not.toHaveProperty('text');
  });
});

describe('openSessionFile: what it actually does', () => {
  it('reads a markdown file inside the project', async () => {
    const result = await openSessionFile(PID, 'README.md', undefined, deps());
    expect(result).toEqual({
      ok: true, action: 'markdown', path: join(root, 'README.md'),
      name: 'README.md', size: 20, text: '# Title\n\nBody text.\n',
    });
  });

  it('resolves a relative path against the session\'s own folder', async () => {
    const result = await openSessionFile(PID, 'notes/deep.md', undefined, deps());
    expect(result).toMatchObject({ ok: true, action: 'markdown', path: join(root, 'notes', 'deep.md') });
  });

  it('strips a trailing line number before using the path, and only then', async () => {
    expect(stripLineSuffix('src/main/ipc.ts:504')).toBe('src/main/ipc.ts');
    expect(stripLineSuffix('src/main/ipc.ts:504:12')).toBe('src/main/ipc.ts');
    expect(stripLineSuffix('README.md')).toBe('README.md');
    // A colon that is not a line number is left alone, so it fails to
    // resolve rather than silently opening something else.
    expect(stripLineSuffix('odd:name.md')).toBe('odd:name.md');
    expect(await openOne('README.md:12')).toMatchObject({ ok: true, action: 'markdown', name: 'README.md' });
  });

  it('reveals every non-markdown file in Finder instead of opening it', async () => {
    const d = deps();
    const result = await openSessionFile(PID, 'run.command', undefined, d);
    expect(result).toEqual({ ok: true, action: 'revealed', path: join(root, 'run.command'), name: 'run.command' });
    // The realpath, not the candidate the renderer sent.
    expect(d.reveal).toHaveBeenCalledWith(join(root, 'run.command'));
  });

  it('reveals a markdown file too when asked to, without reading it', async () => {
    const d = deps();
    const result = await openSessionFile(PID, 'README.md', true, d);
    expect(result).toEqual({ ok: true, action: 'revealed', path: join(root, 'README.md'), name: 'README.md' });
    expect(result).not.toHaveProperty('text');
    expect(d.reveal).toHaveBeenCalledWith(join(root, 'README.md'));
  });

  it('reports a failed reveal rather than claiming success', async () => {
    const d = deps({ reveal: () => { throw new Error('no Finder'); } });
    expect(await openSessionFile(PID, 'run.command', undefined, d)).toEqual({ ok: false, reason: 'reveal_failed' });
  });
});

// macOS gates ~/Documents, ~/Desktop and ~/Downloads per-application. This
// never bites in dev, because the app runs under the terminal's identity and
// iTerm already holds the grant; a packaged Fleet.app is a new identity, so
// the first read either prompts or, if the person has denied it, fails. And
// David's own projects live under ~/Documents.
//
// Measured on this machine, 2026-09-21, against real TCC-protected paths
// (~/Library/Safari/Bookmarks.plist, ~/Library/Messages/chat.db):
//
//   realpath  OK      stat  OK      access  OK      readFile  EPERM
//
// So a denied read does NOT look like a missing file at any earlier stage:
// every check passes and only the read itself fails, with EPERM. That is
// what makes "file not found" the wrong sentence and a silently empty
// viewer the wrong outcome.
describe('a read the OS refuses is a permission problem, not a missing file', () => {
  it('knows the two errnos a denied read actually produces', () => {
    // EPERM is what macOS TCC returns (measured above). EACCES is the
    // ordinary Unix mode bits. Both mean "it is there, you may not read it".
    expect(isPermissionError({ code: 'EPERM' })).toBe(true);
    expect(isPermissionError({ code: 'EACCES' })).toBe(true);
    // The one it must never swallow: a genuinely absent file.
    expect(isPermissionError({ code: 'ENOENT' })).toBe(false);
    expect(isPermissionError(new Error('nope'))).toBe(false);
    expect(isPermissionError(null)).toBe(false);
  });

  it('refuses an unreadable markdown file as permission_denied, not read_failed', async () => {
    const locked = join(root, 'locked.md');
    await writeFile(locked, '# Secret\n');
    await chmod(locked, 0o000);
    try {
      const result = await openSessionFile(PID, 'locked.md', undefined, deps());
      expect(result).toMatchObject({ ok: false, reason: 'permission_denied', name: 'locked.md' });
    } finally {
      await chmod(locked, 0o600);
      await rm(locked, { force: true });
    }
  });

  it('names the file it could not read, so the message can say which', async () => {
    const locked = join(root, 'locked2.md');
    await writeFile(locked, '# Secret\n');
    await chmod(locked, 0o000);
    try {
      const result = await openSessionFile(PID, 'locked2.md', undefined, deps());
      expect(result).toMatchObject({ ok: false, name: 'locked2.md' });
      expect((result as { path?: string }).path).toBe(join(root, 'locked2.md'));
    } finally {
      await chmod(locked, 0o600);
      await rm(locked, { force: true });
    }
  });

  it('still says not_found for a file that genuinely is not there', async () => {
    expect(await openOne('absent.md')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('probeSessionFiles', () => {
  it('answers a batch in order, with null for anything it refuses', async () => {
    const result = await probeSessionFiles(PID, [
      'README.md', 'run.command', 'notes/deep.md', 'escape.md',
      '../outside/secret.md', 'nope.md', '', 'huge.md',
    ], deps());
    expect(result).toEqual({
      ok: true,
      kinds: ['markdown', 'other', 'markdown', null, null, null, null, 'markdown'],
    });
  });

  it('never reveals or reads anything', async () => {
    const d = deps();
    await probeSessionFiles(PID, ['README.md', 'run.command'], d);
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it('refuses a batch that is not an array, is empty, or is over the cap', async () => {
    expect(await probeSessionFiles(PID, 'README.md', deps())).toEqual({ ok: false, reason: 'invalid' });
    expect(await probeSessionFiles(PID, [], deps())).toEqual({ ok: false, reason: 'invalid' });
    const tooMany = Array.from({ length: MAX_PROBE_CANDIDATES + 1 }, () => 'README.md');
    expect(await probeSessionFiles(PID, tooMany, deps())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an unknown pid before it looks at any candidate', async () => {
    expect(await probeSessionFiles(999999, ['README.md'], deps())).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports a directory as "other", so it reveals rather than opens', async () => {
    expect(await probeSessionFiles(PID, ['notes'], deps())).toEqual({ ok: true, kinds: ['other'] });
  });
});
