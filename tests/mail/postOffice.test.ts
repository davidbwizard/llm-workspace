import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailPaths, newLetterId, writeFileAtomic, type OutFile } from '../../src/mail/files.ts';
import { createLoop, getLetter, getLoopSession, insertLetter, openMailLog, setLoopSession, type MailDb } from '../../src/mail/log.ts';
import { DEFAULT_CONFIG } from '../../src/mail/mailConfig.ts';
import { createPostOffice, type PostOffice, type PostOfficeDeps } from '../../src/mail/postOffice.ts';
import { VERDICT_RULE, type Reply, type SessionDriver } from '../../src/mail/session.ts';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const ROLLOUT = '/t/rollout-2026-09-28T19-00-00-01a0e976-4c0d-7b53-b74d-8929b2ef4e17.jsonl';

let root: string;
let project: string;
let db: MailDb;
let now: number;
let notes: string[];
let opened: { runsOn: string; project: string; command: string; tmux: string }[];
let typed: { tmux: string; line: string; queue?: boolean }[];
let calls: string[];
let markers: string[];
let grow: number;
let busy: boolean;
let live: Set<string>;
let replies: (Reply | null)[];   // what the reviewer's transcript shows next; null = no verdict yet

const driver = (): SessionDriver => ({
  open: (runsOn, proj, command, tmux) => { opened.push({ runsOn, project: proj, command, tmux }); live.add(tmux); return null; },
  alive: tmux => live.has(tmux),
  typeLine: (tmux, line, queue) => { calls.push('type'); typed.push(queue ? { tmux, line, queue } : { tmux, line }); return null; },
  claudeTranscript: (_p, id) => `/t/${id}.jsonl`,
  findCodexRollout: marker => { markers.push(marker); return ROLLOUT; },
  size: () => { calls.push('size'); return grow; },
  codexBusy: () => busy,
  readReply: () => (replies.length ? replies.shift()! : { verdict: 'approved', review: 'Looks good.' }),
});

const deps = (over: Partial<PostOfficeDeps> = {}): PostOfficeDeps => ({
  paths: mailPaths(join(root, 'mail')), db, home: join(root, 'home'), now: () => now, pid: process.pid,
  isAlive: () => true, session: driver(), sleep: async ms => { now += ms; }, newSessionId: () => SESSION_ID,
  listCodexMcpServers: async () => [], notify: (t, b) => { notes.push(`${t}: ${b}`); }, log: () => {}, ...over,
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
const passText = (loopId: string, pass: number): string => readFileSync(join(root, 'mail/letters', loopId, `pass-${pass}.md`), 'utf8');

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
  now = Date.parse('2026-09-28T18:00:00Z');
  notes = [];
  opened = [];
  typed = [];
  live = new Set();
  replies = [];
  calls = [];
  markers = [];
  grow = 0;
  busy = false;
});
afterEach(() => { db.close(); });

describe('post office', () => {
  it('opens a Codex session for pass 1 and returns its reply', async () => {
    const office = createPostOffice(deps());
    office.receive(join(root, 'mail/inbox', `${'a'.repeat(32)}.json.123.tmp`));   // the slot's temp file: ignored
    replies.push({ verdict: 'changes_requested', review: 'Strong start. Tighten section 2.' });
    const id = send(office);
    await office.idle();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ runsOn: 'codex', project, tmux: `llmws-codex-mail-${id.slice(0, 8)}` });
    expect(opened[0]!.command).toContain(`FLEET_MAIL_SPECIALIST='${id}'`);
    expect(opened[0]!.command).toContain('--sandbox read-only -a never');
    const pass1 = passText(id, 1);
    for (const part of ['You review specs.', 'Please review.', VERDICT_RULE]) expect(pass1).toContain(part);
    expect(out(id)).toMatchObject({ status: 'replied', verdict: 'changes_requested', pass: 1, passLimit: 4, loopStatus: 'open', specialist: 'codex-reviewer', project });
    expect(getLoopSession(db, id)).toEqual({ sessionId: '01a0e976-4c0d-7b53-b74d-8929b2ef4e17', tmux: opened[0]!.tmux, transcript: ROLLOUT });
    expect(existsSync(join(root, 'mail/inbox', `${id}.json`))).toBe(false);
  });

  it('opens a named, read-only Claude session and closes the loop on approval', async () => {
    const office = createPostOffice(deps());
    const id = send(office, { to: 'claude-reviewer' });
    await office.idle();
    expect(opened[0]!.runsOn).toBe('claude');
    expect(opened[0]!.command).toContain(`--session-id '${SESSION_ID}' -n 'Mail · claude-reviewer · Review the spec'`);
    expect(opened[0]!.command).toContain('--tools Read Grep Glob');
    expect(getLoopSession(db, id)).toMatchObject({ sessionId: SESSION_ID, transcript: `/t/${SESSION_ID}.jsonl` });
    expect(out(id)).toMatchObject({ status: 'replied', verdict: 'approved', loopStatus: 'approved' });
  });

  it('starts a Codex specialist with its MCP servers off', async () => {
    const office = createPostOffice(deps({ listCodexMcpServers: async () => ['trello'] }));
    send(office);
    await office.idle();
    expect(opened[0]!.command).toContain("-c 'mcp_servers.trello.enabled=false'");
  });

  it('sends pass 2 into the same session', async () => {
    const office = createPostOffice(deps());
    replies.push({ verdict: 'changes_requested', review: 'Fix A.' });
    const first = send(office);
    await office.idle();
    writeFileSync(join(project, 'spec.md'), 'spec v2');
    const second = send(office, { re: first, body: 'Fixed A.' });
    await office.idle();
    expect(opened).toHaveLength(1);
    expect(typed).toEqual([{ tmux: opened[0]!.tmux, line: `Pass 2: read ${join(root, 'mail/letters', first, 'pass-2.md')} and do what it says.` }]);
    expect(passText(first, 2)).toContain('Fixed A.');
    expect(out(second)).toMatchObject({ status: 'replied', pass: 2 });
  });

  it('finds the Codex transcript by its pass file, not the letter id', async () => {
    const office = createPostOffice(deps());
    const id = send(office);
    await office.idle();
    expect(markers).toEqual([join(root, 'mail/letters', id, 'pass-1.md')]);
  });

  it('takes the reply offset before typing a pass, and records it', async () => {
    const office = createPostOffice(deps());
    replies.push({ verdict: 'changes_requested', review: 'Fix A.' });
    const first = send(office);
    await office.idle();
    grow = 5000;
    calls = [];
    writeFileSync(join(project, 'spec.md'), 'spec v2');
    const second = send(office, { re: first });
    await office.idle();
    expect(calls.slice(0, 2)).toEqual(['size', 'type']);
    expect(db.prepare('SELECT transcript_offset AS o FROM letters WHERE id = ?').get(second)).toEqual({ o: 5000 });
  });

  it('queues the pass with Tab when the Codex reviewer is mid-turn', async () => {
    const office = createPostOffice(deps());
    replies.push({ verdict: 'changes_requested', review: 'Fix A.' });
    const first = send(office);
    await office.idle();
    busy = true;
    writeFileSync(join(project, 'spec.md'), 'spec v2');
    send(office, { re: first });
    await office.idle();
    expect(typed[0]).toMatchObject({ queue: true });
  });

  it('reopens a closed Codex session with codex resume', async () => {
    const office = createPostOffice(deps());
    replies.push({ verdict: 'changes_requested', review: 'Fix A.' });
    const first = send(office);
    await office.idle();
    live.clear();
    writeFileSync(join(project, 'spec.md'), 'spec v2');
    send(office, { re: first });
    await office.idle();
    expect(opened[1]!.command).toContain("codex resume --sandbox read-only -a never");
    expect(opened[1]!.command).toContain("'01a0e976-4c0d-7b53-b74d-8929b2ef4e17' 'Pass 2: read");
  });

  it('fails a pass at once when its session closes before replying', async () => {
    const office = createPostOffice(deps({ session: { ...driver(), readReply: () => { live.clear(); return null; } } }));
    const started = now;
    const id = send(office);
    await office.idle();
    expect(out(id)).toMatchObject({ status: 'failed', reason: 'the session closed before replying' });
    expect(now - started).toBeLessThan(60_000);
  });

  it('stops watching on stop and leaves the letter for the next start', async () => {
    let office: ReturnType<typeof createPostOffice> | null = null;
    office = createPostOffice(deps({ session: { ...driver(), readReply: () => { office!.stop(); return null; } } }));
    const id = send(office);
    await office.idle();
    expect(getLetter(db, id)?.status).toBe('running');
    expect(live.size).toBe(1);
  });

  it('skips re-reading a transcript that has not grown', async () => {
    let reads = 0;
    const office = createPostOffice(deps({ session: { ...driver(), readReply: () => { reads += 1; return null; } } }));
    send(office);
    await office.idle();
    expect(reads).toBe(1);
  });

  it('fails one letter, not all mail, when the Codex transcript search errors', async () => {
    let fail = true;
    const office = createPostOffice(deps({
      session: { ...driver(), findCodexRollout: () => { if (fail) { fail = false; throw new Error('EACCES'); } return ROLLOUT; } },
    }));
    const first = send(office);
    await office.idle();
    expect(out(first)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/could not find the session transcript/) });
    const second = send(office);
    await office.idle();
    expect(out(second)).toMatchObject({ status: 'replied' });
  });

  it('reopens a closed session with resume', async () => {
    const office = createPostOffice(deps());
    replies.push({ verdict: 'changes_requested', review: 'Fix A.' });
    const first = send(office, { to: 'claude-reviewer' });
    await office.idle();
    live.clear();
    writeFileSync(join(project, 'spec.md'), 'spec v2');
    send(office, { to: 'claude-reviewer', re: first });
    await office.idle();
    expect(opened).toHaveLength(2);
    expect(opened[1]!.command).toContain(`claude --resume '${SESSION_ID}' 'Pass 2: read`);
    expect(opened[1]!.tmux).toBe(opened[0]!.tmux);
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
    expect(opened).toHaveLength(1);
    expect(typed).toHaveLength(0);
  });

  it('enforces the daily limit and the off switch', async () => {
    config({ lettersPerDay: 1 });
    const office = createPostOffice(deps());
    send(office);
    await office.idle();
    expect(out(send(office))).toMatchObject({ status: 'refused', reason: 'daily limit of 1 letters reached' });
    config({ enabled: false });
    expect(out(send(office))).toMatchObject({ status: 'refused', reason: 'mail is off' });
    expect(opened).toHaveLength(1);
  });

  it('times out without closing the session', async () => {
    const office = createPostOffice(deps({ session: { ...driver(), readReply: () => null } }));
    const id = send(office);
    await office.idle();
    expect(out(id)).toMatchObject({ status: 'timed_out', reason: expect.stringMatching(/the session is still open/), loopStatus: 'failed' });
    expect(live.size).toBe(1);
  });

  it('fails one letter, not all mail, when its transcript cannot be read', async () => {
    let fail = true;
    const office = createPostOffice(deps({
      session: { ...driver(), readReply: () => { if (fail) { fail = false; throw new Error('EACCES'); } return { verdict: 'approved', review: 'OK.' }; } },
    }));
    const first = send(office);
    await office.idle();
    expect(out(first)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/could not read the session transcript/) });
    const second = send(office);
    await office.idle();
    expect(out(second)).toMatchObject({ status: 'replied' });
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
    expect(opened).toHaveLength(1);
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

  it('tells every letter in hand when the log breaks mid-run', async () => {
    let wake: () => void = () => {};
    replies.push(null);
    const office = createPostOffice(deps({ sleep: () => new Promise<void>(r => { wake = r; }) }));
    const first = send(office);
    const second = send(office);
    db.close();
    wake();
    await office.idle();
    expect(out(first)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^mail is off: /) });
    expect(out(second)).toMatchObject({ status: 'cancelled', reason: expect.stringMatching(/^mail is off: /) });
    db = openMailLog(':memory:');   // for afterEach
  });

  it('never throws out of receive, even when the notification fails', () => {
    const office = createPostOffice(deps({ notify: () => { throw new Error('no notification centre'); } }));
    db.close();
    expect(() => send(office)).not.toThrow();
    db = openMailLog(':memory:');   // for afterEach
  });

  it('refuses an oversized letter file without reading it', () => {
    const office = createPostOffice(deps());
    const id = send(office, { body: 'x'.repeat(300_000) });
    expect(out(id)).toMatchObject({ status: 'refused', reason: 'letter file is over 256 KB' });
  });

  it('turns mail off when the log cannot be written', () => {
    const office = createPostOffice(deps());
    db.close();
    const id = send(office);
    expect(out(id)).toMatchObject({ status: 'refused', reason: expect.stringMatching(/^mail is off: /) });
    expect(notes[0]).toMatch(/^Fleet Mail stopped: /);
    expect(opened).toHaveLength(0);
    db = openMailLog(':memory:');   // for afterEach
  });
});
