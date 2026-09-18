import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// "Usage and context" (usage design, Part A): the status line feed. Claude
// Code runs this on every status update with a JSON snapshot on stdin. Every
// run here uses a fresh temp HOME -- nothing in this file ever touches the
// real ~/.llm-workspace.
const script = resolve('src/hooks/statusline.sh');
const FIXTURE = readFileSync(resolve('tests/fixtures/usage/claude-statusline.json'), 'utf8');
const SESSION = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'llmws-statusline-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const dir = () => join(home, '.llm-workspace', 'statusline');

function run(input: string | Buffer, env: NodeJS.ProcessEnv = { ...process.env, HOME: home }) {
  return spawnSync('sh', [script], { input, env });
}

function entries(): string[] {
  return existsSync(dir()) ? readdirSync(dir()) : [];
}

describe('statusline.sh', () => {
  it('writes the snapshot to <home>/.llm-workspace/statusline/<session_id>.json, byte-for-byte', () => {
    const r = run(FIXTURE);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir(), `${SESSION}.json`), 'utf8')).toBe(FIXTURE);
  });

  it('accepts the single-line JSON Claude Code actually pipes', () => {
    const compact = JSON.stringify(JSON.parse(FIXTURE));
    run(compact);
    expect(readFileSync(join(dir(), `${SESSION}.json`), 'utf8')).toBe(compact);
  });

  it('writes the file 0600 inside a 0700 directory, and creates .llm-workspace 0700 too', () => {
    run(FIXTURE);
    expect(statSync(join(dir(), `${SESSION}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.llm-workspace')).mode & 0o777).toBe(0o700);
  });

  it('prints nothing, on stdout or stderr, and exits 0', () => {
    const r = run(FIXTURE);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr.length).toBe(0);
  });

  it('replaces the previous snapshot for the same session, leaving no temp file behind', () => {
    run(FIXTURE);
    const newer = FIXTURE.replace('"used_percentage": 46', '"used_percentage": 47');
    run(newer);
    expect(readFileSync(join(dir(), `${SESSION}.json`), 'utf8')).toBe(newer);
    expect(entries()).toEqual([`${SESSION}.json`]);
  });

  it('keeps one file per session', () => {
    run(FIXTURE);
    run(JSON.stringify({ session_id: 'other-session_2', context_window: {} }));
    expect(entries().sort()).toEqual([`${SESSION}.json`, 'other-session_2.json'].sort());
  });

  it('uses the top-level session_id when a nested one agrees with it', () => {
    run('{"session_id":"top-level","agent":{"session_id":"top-level"}}');
    expect(entries()).toEqual(['top-level.json']);
  });

  // M5: a top-level and a nested session_id that disagree are ambiguous
  // about which session this snapshot belongs to -- refuse rather than
  // guess which one wins.
  it('rejects a payload naming more than one distinct session_id: writes nothing, prints nothing, exits 0', () => {
    const r = run('{"session_id":"top-level","agent":{"session_id":"nested"}}');
    expect(r.status).toBe(0);
    expect(r.stdout.length + r.stderr.length).toBe(0);
    expect(entries()).toEqual([]);
  });

  it.each([
    ['a path traversal', '../../evil'],
    ['a slash', 'a/b'],
    ['a space', 'a b'],
    ['a dot', 'a.b'],
    ['shell text', '$(touch pwned)'],
    ['an empty id', ''],
    ['129 characters', 'a'.repeat(129)],
  ])('rejects a session id with %s: writes nothing, prints nothing, exits 0', (_label, id) => {
    const r = run(JSON.stringify({ session_id: id, model: { id: 'claude-opus-5' } }));
    expect(r.status).toBe(0);
    expect(r.stdout.length + r.stderr.length).toBe(0);
    expect(entries()).toEqual([]);
    expect(readdirSync(home).filter(f => f !== '.llm-workspace')).toEqual([]);
  });

  it('accepts a 128-character id', () => {
    const id = 'a'.repeat(128);
    run(JSON.stringify({ session_id: id }));
    expect(entries()).toEqual([`${id}.json`]);
  });

  it('rejects a session id that is not a string', () => {
    run('{"session_id":12345}');
    expect(entries()).toEqual([]);
  });

  it.each([
    ['plain text', 'not json at all'],
    ['empty input', ''],
    ['binary', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x0a])],
    ['JSON with no session_id', '{"model":{"id":"claude-opus-5"}}'],
  ])('exits 0 on %s, writes nothing and prints nothing', (_label, input) => {
    const r = run(input);
    expect(r.status).toBe(0);
    expect(r.stdout.length + r.stderr.length).toBe(0);
    expect(entries()).toEqual([]);
  });

  it('drops input over 64 KB', () => {
    const big = JSON.stringify({ session_id: SESSION, pad: 'x'.repeat(70 * 1024) });
    const r = run(big);
    expect(r.status).toBe(0);
    expect(entries()).toEqual([]);
  });

  it('keeps input of exactly 64 KB', () => {
    const base = JSON.stringify({ session_id: SESSION, pad: '' });
    const exact = JSON.stringify({ session_id: SESSION, pad: 'x'.repeat(64 * 1024 - base.length) });
    expect(Buffer.byteLength(exact)).toBe(64 * 1024);
    run(exact);
    expect(entries()).toEqual([`${SESSION}.json`]);
  });

  it('exits 0 and writes nothing when HOME is unset', () => {
    const env = { ...process.env };
    delete env.HOME;
    const r = run(FIXTURE, env);
    expect(r.status).toBe(0);
    expect(r.stdout.length + r.stderr.length).toBe(0);
    expect(entries()).toEqual([]);
  });

  it('exits 0 when the folder cannot be created', () => {
    // A regular FILE where the .llm-workspace folder should be.
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home);
    const blocker = join(home, '.llm-workspace');
    writeFileSync(blocker, 'not a folder');
    const r = run(FIXTURE);
    expect(r.status).toBe(0);
    expect(r.stdout.length + r.stderr.length).toBe(0);
  });
});
