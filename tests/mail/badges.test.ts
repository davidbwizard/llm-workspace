import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mailBadges } from '../../src/mail/badges.ts';
import { createLoop, insertLetter, openMailLog, setLoopSession, updateLetter, type MailDb, type NewLetter } from '../../src/mail/log.ts';

const NOW = 1_000_000_000_000;
let db: MailDb;
let read: Set<string>;

const loop = (id: string, specialist: string, updated = NOW) =>
  createLoop(db, { id, specialist, project: '/work/llm-workspace-mail', fromTool: 'claude', status: 'open', passes: 1 }, updated);
const letter = (id: string, loopId: string, pass: number, over: Partial<NewLetter> = {}) => insertLetter(db, {
  id, loopId, pass, fromTool: 'claude', fromPid: 500, project: '/work/llm-workspace-mail', to: 'codex-reviewer', subject: 's',
  body: 'b', attachments: [], status: 'queued', reason: null, ownerPid: 1, createdAt: NOW, ...over,
});
const badges = (since = NOW - 86_400_000) => mailBadges(db, {
  isRead: id => read.has(id), pidOfTmux: name => (name === 'llmws-codex-mail-L1' ? 900 : null), passLimit: 3, since,
});

beforeEach(() => { db = openMailLog(':memory:'); read = new Set(); });
afterEach(() => { db.close(); });

describe('mailBadges', () => {
  it('counts the reviews a session started, and shows one writing', () => {
    loop('L1', 'codex-reviewer');
    letter('a1', 'L1', 1, { status: 'replied' });
    updateLetter(db, 'a1', { status: 'replied', verdict: 'changes_requested' });
    letter('a2', 'L1', 2, { status: 'running' });
    loop('L2', 'claude-reviewer');
    letter('b1', 'L2', 1, { to: 'claude-reviewer' });
    updateLetter(db, 'b1', { status: 'replied', verdict: 'approved' });
    read.add('b1');
    expect(badges()[500]).toEqual([{
      kind: 'sender', count: '×2', state: 'writing',
      tip: '2 reviews · codex-reviewer, pass 2 of 3, writing · claude-reviewer, pass 1 of 3, approved',
    }]);
  });

  it('shows a reply that has not been read yet', () => {
    loop('L1', 'codex-reviewer');
    letter('a1', 'L1', 1);
    updateLetter(db, 'a1', { status: 'replied', verdict: 'changes_requested' });
    expect(badges()[500]).toEqual([{ kind: 'sender', count: '×1', state: 'fresh', tip: '1 review · codex-reviewer, pass 1 of 3, changes requested' }]);
    read.add('a1');
    expect(badges()[500]![0]!.state).toBe('idle');
  });

  it('marks the reviewer session with its pass', () => {
    loop('L1', 'codex-reviewer');
    setLoopSession(db, 'L1', { sessionId: null, tmux: 'llmws-codex-mail-L1', transcript: null });
    letter('a1', 'L1', 1, { status: 'running' });
    expect(badges()[900]).toEqual([{ kind: 'reviewer', count: '1/3', state: 'writing', tip: 'Writing pass 1 of 3 for claude · llm-workspace-mail' }]);
    updateLetter(db, 'a1', { status: 'replied', verdict: 'approved' });
    expect(badges()[900]).toEqual([{ kind: 'reviewer', count: '1/3', state: 'idle', tip: 'Answered pass 1 of 3 for claude · llm-workspace-mail' }]);
  });

  it('leaves out loops idle for longer than the window, and letters with no sender process', () => {
    loop('OLD', 'codex-reviewer', NOW - 90_000_000);
    letter('o1', 'OLD', 1, { status: 'replied' });
    loop('L2', 'codex-reviewer');
    letter('n1', 'L2', 1, { fromPid: null });
    expect(badges()).toEqual({});
  });
});
