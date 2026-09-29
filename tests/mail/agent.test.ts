import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgentInstructions } from '../../src/mail/agent.ts';

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mail-home-'));
  mkdirSync(join(home, '.codex/agents'), { recursive: true });
  mkdirSync(join(home, '.claude/agents'), { recursive: true });
  writeFileSync(join(home, '.codex/agents/reviewer.toml'),
    'name = "reviewer"\ndescription = "d"\ndeveloper_instructions = """\nYou review things.\nBe exact.\n"""\n');
  writeFileSync(join(home, '.codex/agents/escaped.toml'), 'developer_instructions = """\nUse \\n here\n"""\n');
  writeFileSync(join(home, '.claude/agents/reviewer.md'), '---\nname: reviewer\ntools: Read\n---\n\nYou review things.\n');
});

describe('readAgentInstructions', () => {
  it('reads Codex developer_instructions', () => {
    expect(readAgentInstructions(home, { runsOn: 'codex', agent: 'reviewer' })).toEqual({ ok: true, text: 'You review things.\nBe exact.' });
  });

  it('reads a Claude agent body without its front matter', () => {
    expect(readAgentInstructions(home, { runsOn: 'claude', agent: 'reviewer' })).toEqual({ ok: true, text: 'You review things.' });
  });

  it('refuses what it cannot read exactly', () => {
    expect(readAgentInstructions(home, { runsOn: 'codex', agent: 'escaped' })).toMatchObject({ ok: false, reason: expect.stringMatching(/backslash/) });
    expect(readAgentInstructions(home, { runsOn: 'claude', agent: 'missing' })).toMatchObject({ ok: false, reason: expect.stringMatching(/ENOENT/) });
  });
});
