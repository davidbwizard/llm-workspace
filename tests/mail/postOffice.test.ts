import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailPaths, newLetterId, writeFileAtomic, type OutFile } from '../../src/mail/files.ts';
import { createLoop, getLetter, insertLetter, openMailLog, type MailDb } from '../../src/mail/log.ts';
import { DEFAULT_CONFIG } from '../../src/mail/mailConfig.ts';
import { createPostOffice, type PostOffice, type PostOfficeDeps } from '../../src/mail/postOffice.ts';
import type { Command, Reply, RunHandle, RunResult } from '../../src/mail/runner.ts';

let root: string;
let project: string;
let db: MailDb;
let replies: (Reply | RunResult)[];   // what the fake specialist does next
let calls: { cmd: Command; stdin: string; env: NodeJS.ProcessEnv }[];
let notes: string[];
let now: number;

function fakeRun(cmd: Command, stdin: string, _timeoutMs: number, env: NodeJS.ProcessEnv): RunHandle {
  calls.push({ cmd, stdin, env });
  const next = replies.shift() ?? { verdict: 'approved', review: 'Looks good.' };
  if ('exitCode' in next) return { done: Promise.resolve(next), kill: () => {} };
  if (cmd.replyFile) writeFileSync(cmd.replyFile, JSON.stringify(next));
  const stdout = cmd.replyFile ? '' : JSON.stringify({ structured_output: next });
  return { done: Promise.resolve({ exitCode: 0, stdout, stderrTail: '', timedOut: false }), kill: () => {} };
}

const deps = (over: Partial<PostOfficeDeps> = {}): PostOfficeDeps => ({
  paths: mailPaths(join(root, 'mail')), db, home: join(root, 'home'), now: () => now, pid: process.pid,
  isAlive: () => true, run: fakeRun, listCodexMcpServers: () => [], notify: (t, b) => { notes.push(`${t}: ${b}`); },
  log: () => {}, ...over,
});

const config = (over: Record<string, unknown>) =>
  writeFileAtomic(join(root, 'mail/config.json'), JSON.stringify({ ...DEFAULT_CONFIG, ...over }));

const letterJson = (id: string, over: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, id, from: { tool: 'claude', project }, to: 'codex-reviewer', subject: 'Review the spec',
  body: 'Please review.', attachments: ['spec.md'], re: null, sentAt: new Date(now).toISOString(), ...over,
});

/** Drops a letter the way the slot does and hands it to the office. */
function send(office: PostOffice, over: Record<string, unknown> = {}): string {
  const id = newLetterId();
  const file = join(root, 'mail/inbox', `${id}.json`);
  writeFileAtomic(file, letterJson(id, over));
  office.receive(file);
  return id;
}

const out = (id: string): OutFile => JSON.parse(readFileSync(join(root, 'mail/out', `${id}.json`), 'utf8'));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mail-po-')));
  project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'spec.md'), 'spec v1');
  mkdirSync(join(root, 'home/.codex/agents'), { recursive: true });
  mkdirSync(join(root, 'home/.claude/agents'), { recursive: true });
  writeFileSync(join(root, 'home/.codex/agents/reviewer.toml'), 'developer_instructions = """\nYou review specs.\n"""\n');
  writeFileSync(join(root, 'home/.claude/agents/reviewer.md'), '---\nname: reviewer\n---\nYou review specs.\n');
  db = openMailLog(':memory:');
  replies = [];
  calls = [];
  notes = [];
  now = Date.parse('2026-09-28T18:00:00Z');
});
afterEach(() => { db.close(); });

describe('post office', () => {
  it('runs one letter and returns the reply', async () => {
    const office = createPostOffice(deps());
    office.receive(join(root, 'mail/inbox', `${'a'.repeat(32)}.json.123.tmp`));   // the slot's temp file: ignored
    replies.push({ verdict: 'changes_requested', review: 'Strong start. Tighten section 2.' });
    const id = send(office);
    await office.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd.file).toBe('codex');
    expect(calls[0].cmd.cwd).toBe(project);
    expect(calls[0].env.FLEET_MAIL_SPECIALIST).toBe(id);
    expect(calls[0].stdin).toContain('You review specs.');
    expect(calls[0].stdin).toContain('Please review.');
    expect(out(id)).toMatchObject({ status: 'replied', verdict: 'changes_requested', pass: 1, passLimit: 4, loopStatus: 'open', specialist: 'codex-reviewer' });
    expect(existsSync(join(root, 'mail/inbox', `${id}.json`))).toBe(false);
  });

  it('closes the loop on approval', async () => {
    const office = createPostOffice(deps());
    const id = send(office, { to: 'claude-reviewer' });
    await office.idle();
    expect(calls[0].cmd.file).toBe('claude');
    expect(out(id)).toMatchObject({ status: 'replied', verdict: 'approved', loopStatus: 'approved' });
  });

  it('runs a loop to its pass limit and notifies David', async () => {
    config({ passesPerLoop: 2 });
    const office = createPostOffice(deps());
    replies.push({ verdict: 'changes_requested', review: 'Fix A.' }, { verdict: 'changes_requested', review: 'Fix B.' });
    const first = send(office);
    await office.idle();
    writeFileSync(join(project, 'spec.md'), 'spec v2');
    const second = send(office, { re: first, body: 'Fixed A.' });
    await office.idle();
    expect(out(second)).toMatchObject({ status: 'replied', pass: 2, loopStatus: 'limit' });
    expect(notes).toEqual(['Review loop hit its limit: Review the spec: codex-reviewer still wants changes after 2 passes.']);
    expect(out(send(office, { re: second }))).toMatchObject({ status: 'refused', reason: expect.stringMatching(/pass limit/) });
  });

  it('refuses a follow-up that changed nothing', async () => {
    const office = createPostOffice(deps());
    replies.push({ verdict: 'changes_requested', review: 'Fix A.' });
    const first = send(office);
    await office.idle();
    expect(out(send(office, { re: first, body: 'Thanks!' })))
      .toMatchObject({ status: 'refused', reason: 'nothing changed since the last pass: attach the revised file' });
    expect(calls).toHaveLength(1);
  });

  it('enforces the daily limit and the off switch', async () => {
    config({ lettersPerDay: 1 });
    const office = createPostOffice(deps());
    send(office);
    await office.idle();
    expect(out(send(office))).toMatchObject({ status: 'refused', reason: 'daily limit of 1 letters reached' });
    config({ enabled: false });
    expect(out(send(office))).toMatchObject({ status: 'refused', reason: 'mail is off' });
    expect(calls).toHaveLength(1);
  });

  it('marks a run that timed out and fails its loop', async () => {
    const office = createPostOffice(deps());
    replies.push({ exitCode: null, stdout: '', stderrTail: '', timedOut: true });
    const id = send(office);
    await office.idle();
    expect(out(id)).toMatchObject({ status: 'timed_out', reason: 'ran past 10 minutes', loopStatus: 'failed' });
  });

  it('runs a letter once when two Fleets watch the same inbox', async () => {
    const a = createPostOffice(deps());
    const b = createPostOffice(deps());
    const id = newLetterId();
    const file = join(root, 'mail/inbox', `${id}.json`);
    writeFileAtomic(file, letterJson(id));
    a.receive(file);
    b.receive(file);
    await a.idle();
    await b.idle();
    expect(calls).toHaveLength(1);
  });

  it('cancels letters a stopped Fleet left behind, but not a live one', () => {
    createLoop(db, { id: 'L', specialist: 'codex-reviewer', project, fromTool: 'claude', status: 'open', passes: 1 }, now);
    const base = { loopId: 'L', pass: 1, fromTool: 'claude' as const, project, to: 'codex-reviewer', subject: 's', body: 'b', attachments: [], reason: null, createdAt: now };
    insertLetter(db, { ...base, id: 'd'.repeat(32), status: 'running', ownerPid: 111 });
    insertLetter(db, { ...base, id: 'e'.repeat(32), status: 'queued', ownerPid: 222 });
    createPostOffice(deps({ isAlive: pid => pid === 222 }));
    expect(out('d'.repeat(32))).toMatchObject({ status: 'cancelled', reason: 'Fleet stopped before this finished' });
    expect(getLetter(db, 'e'.repeat(32))?.status).toBe('queued');
  });

  it('turns mail off when the log cannot be written', () => {
    const office = createPostOffice(deps());
    db.close();
    const id = send(office);
    expect(out(id)).toMatchObject({ status: 'refused', reason: expect.stringMatching(/^mail is off: /) });
    expect(notes[0]).toMatch(/^Fleet Mail stopped: /);
    expect(calls).toHaveLength(0);
    db = openMailLog(':memory:');   // for afterEach
  });
});
