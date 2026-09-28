import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Specialist } from './mailConfig.ts';

export function agentFile(home: string, s: Specialist): string {
  return s.runsOn === 'codex' ? join(home, '.codex/agents', `${s.agent}.toml`) : join(home, '.claude/agents', `${s.agent}.md`);
}

/** The agent's instructions, read from David's own agent file. Both CLIs get
 *  them in the prompt, so neither depends on an --agent flag. */
export function readAgentInstructions(home: string, s: Specialist): { ok: true; text: string } | { ok: false; reason: string } {
  const file = agentFile(home, s);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read agent file ${file} (${(e as NodeJS.ErrnoException).code})` };
  }
  if (s.runsOn === 'claude') {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    return body ? { ok: true, text: body } : { ok: false, reason: `${file} has no instructions` };
  }
  // Only the one TOML form the agent files use. Anything else is refused, not guessed at.
  const inner = /^developer_instructions\s*=\s*"""\r?\n?([\s\S]*?)"""/m.exec(text)?.[1];
  if (inner === undefined) return { ok: false, reason: `${file} has no developer_instructions = """...""" block` };
  if (inner.includes('\\')) return { ok: false, reason: `${file}: backslash escapes in developer_instructions are not supported` };
  return { ok: true, text: inner.trim() };
}
