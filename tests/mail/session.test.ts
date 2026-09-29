import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexSessionId, findCodexRollout, firstMessage, openCommand, passLine, readReply, resumeCommand,
  sessionName, splitVerdict, writePassFile, type SessionSpec,
} from '../../src/mail/session.ts';

const claude: SessionSpec = {
  runsOn: 'claude', project: '/p', loopId: 'l'.repeat(32), name: 'Mail · claude-reviewer · Spec',
  sessionId: '11111111-2222-3333-4444-555555555555', letterDir: '/m/letters/L', codexMcpOff: [],
};
const codex: SessionSpec = { ...claude, runsOn: 'codex', sessionId: '', codexMcpOff: ['trello'] };

describe('commands', () => {
  it('opens Claude read-only, named, with a fixed session id', () => {
    expect(openCommand(claude, 'Read /m/letters/L/pass-1.md')).toBe(
      `env FLEET_MAIL_SPECIALIST='${'l'.repeat(32)}' claude 'Read /m/letters/L/pass-1.md' `
      + `--session-id '11111111-2222-3333-4444-555555555555' -n 'Mail · claude-reviewer · Spec' `
      + `--permission-mode dontAsk --strict-mcp-config --add-dir '/m/letters/L' --tools Read Grep Glob`);
  });

  it('opens Codex standalone, read-only, with its MCP servers off and no update screen', () => {
    expect(openCommand(codex, 'Read x')).toBe(
      `env FLEET_MAIL_SPECIALIST='${'l'.repeat(32)}' codex --sandbox read-only -a never `
      + `-c 'check_for_update_on_startup=false' -c 'mcp_servers.trello.enabled=false' -C '/p' 'Read x'`);
  });

  it('resumes with the same settings', () => {
    expect(resumeCommand(claude, 'Pass 2')).toContain(`claude --resume '11111111-2222-3333-4444-555555555555' 'Pass 2' --permission-mode dontAsk`);
    expect(resumeCommand({ ...codex, sessionId: 'abc' }, 'Pass 2')).toContain('codex resume --sandbox read-only -a never');
    expect(resumeCommand({ ...codex, sessionId: 'abc' }, 'Pass 2')).toMatch(/-C '\/p' 'abc' 'Pass 2'$/);
  });

  it('names a session from the letter without control characters or length', () => {
    expect(sessionName('codex-reviewer', 'Spec\nreview\x1b[31m')).toBe('Mail · codex-reviewer · Spec review [31m');
    expect(sessionName('r', 's'.repeat(200)).length).toBe(80);
    expect(sessionName('r', 'a\u202eb\u200bc\x85d')).toBe('Mail · r · a b c d');
  });

  it('writes pass files owner-only and names them in the messages', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'mail-s-')), 'L');
    const file = writePassFile(dir, 2, 'hello');
    expect(file).toBe(join(dir, 'pass-2.md'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(firstMessage(file)).toContain(file);
    expect(passLine(2, file)).toBe(`Pass 2: read ${file} and do what it says.`);
  });
});

describe('replies', () => {
  it('reads a VERDICT line, bold or plain', () => {
    expect(splitVerdict('Good start.\nFix A.\n\nVERDICT: changes_requested')).toEqual({ verdict: 'changes_requested', review: 'Good start.\nFix A.' });
    expect(splitVerdict('All clear.\n**VERDICT: approved**\n')).toEqual({ verdict: 'approved', review: 'All clear.' });
    expect(splitVerdict('Fine.\nVERDICT: approved.')).toEqual({ verdict: 'approved', review: 'Fine.' });
    expect(splitVerdict('Fine.\n> VERDICT: approved')).toEqual({ verdict: 'approved', review: 'Fine.' });
    expect(splitVerdict('Fix it.\n- **VERDICT: changes_requested**.')).toEqual({ verdict: 'changes_requested', review: 'Fix it.' });
    expect(splitVerdict('VERDICT: maybe')).toBeNull();
    expect(splitVerdict('No verdict here.')).toBeNull();
  });

  it('finds the reply in a Claude transcript after the offset', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-t-')), 't.jsonl');
    const line = (text: string) => JSON.stringify({
      type: 'assistant', uuid: `u-${text.length}`, sessionId: 's', timestamp: '2026-09-28T19:00:00Z', cwd: '/p',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    const old = `${line('Old.\nVERDICT: approved')}\n`;
    writeFileSync(file, `${old}${line('Checking the file.')}\n${line('Looks solid.\nVERDICT: changes_requested')}\n`);
    expect(readReply('claude', file, Buffer.byteLength(old))).toEqual({ verdict: 'changes_requested', review: 'Looks solid.' });
    expect(readReply('claude', file, 0)).toEqual({ verdict: 'approved', review: 'Old.' });
    expect(readReply('claude', join(file, '..', 'missing.jsonl'), 0)).toBeNull();
  });

  it('uses the message before a bare VERDICT line as the review', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-t-')), 't.jsonl');
    const line = (uuid: string, text: string) => JSON.stringify({
      type: 'assistant', uuid, sessionId: 's', timestamp: '2026-09-28T19:00:00Z', cwd: '/p',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    writeFileSync(file, `${line('a', 'The full review.')}\n${line('b', 'VERDICT: approved')}\n`);
    expect(readReply('claude', file, 0)).toEqual({ verdict: 'approved', review: 'The full review.' });
  });

  it('finds the reply in a Codex rollout', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-t-')), 'r.jsonl');
    writeFileSync(file, `${JSON.stringify({ timestamp: '2026-09-28T19:00:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Tight spec.\nVERDICT: approved' } })}\n`);
    expect(readReply('codex', file, 0)).toEqual({ verdict: 'approved', review: 'Tight spec.' });
  });

  it('finds a Codex rollout by the loop id in its first prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'mail-c-'));
    const now = Date.parse('2026-09-28T19:00:00');
    const day = join(root, '2026', '09', '28');
    mkdirSync(day, { recursive: true });
    const hit = join(day, 'rollout-2026-09-28T19-00-01-01a0e976-4c0d-7b53-b74d-8929b2ef4e17.jsonl');
    const stale = join(day, 'rollout-2026-09-28T18-00-00-01a0e976-4c0d-7b53-b74d-000000000000.jsonl');
    writeFileSync(hit, 'read /m/letters/LOOPID/pass-1.md');
    writeFileSync(stale, 'read /m/letters/LOOPID/pass-1.md');
    utimesSync(hit, new Date(now), new Date(now));
    utimesSync(stale, new Date(now - 3_600_000), new Date(now - 3_600_000));
    expect(findCodexRollout(root, 'LOOPID', now - 60_000, now)).toBe(hit);
    expect(codexSessionId(hit)).toBe('01a0e976-4c0d-7b53-b74d-8929b2ef4e17');
    expect(findCodexRollout(root, 'OTHER', now - 60_000, now)).toBeNull();
    expect(findCodexRollout(join(root, 'none'), 'LOOPID', now - 60_000, now)).toBeNull();
    const newer = join(day, 'rollout-2026-09-28T19-00-02-01a0e976-4c0d-7b53-b74d-111111111111.jsonl');
    writeFileSync(newer, 'read /m/letters/LOOPID/pass-1.md');
    utimesSync(newer, new Date(now + 1000), new Date(now + 1000));
    symlinkSync(join(day, 'gone'), join(day, 'rollout-2026-09-28T19-00-03-01a0e976-4c0d-7b53-b74d-222222222222.jsonl'));
    expect(findCodexRollout(root, 'LOOPID', now - 60_000, now)).toBe(newer);
  });
});
