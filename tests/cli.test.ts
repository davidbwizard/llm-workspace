import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolvePaths, probeCapabilities, formatEventLine, sanitizeForTerminal } from '../src/config.ts';

describe('resolvePaths', () => {
  it('points at the provider directories the spec names', () => {
    const p = resolvePaths('/home/me');
    expect(p.claudeProjects).toBe('/home/me/.claude/projects');
    expect(p.codexSessions).toBe('/home/me/.codex/sessions');
    expect(p.codexStateDb).toBe('/home/me/.codex/state_5.sqlite');
    expect(p.spool).toBe('/home/me/.llm-workspace/spool');
    expect(p.db).toBe('/home/me/.llm-workspace/index.sqlite');
  });
});

describe('probeCapabilities', () => {
  it('reports what is actually present rather than assuming', () => {
    const caps = probeCapabilities(resolvePaths(process.env.HOME!));
    expect(typeof caps.claudeTranscripts).toBe('boolean');
    expect(typeof caps.codexRollouts).toBe('boolean');
    expect(typeof caps.codexStateDb).toBe('boolean');
    expect(typeof caps.tmux).toBe('boolean');
    expect(typeof caps.hooksInstalled).toBe('boolean');
  });

  it('agrees with the filesystem about Claude transcripts', () => {
    const paths = resolvePaths(process.env.HOME!);
    const caps = probeCapabilities(paths);
    expect(caps.claudeTranscripts).toBe(existsSync(paths.claudeProjects));
  });
});

describe('formatEventLine', () => {
  it('renders prose prominently and tool noise compactly', () => {
    const prose = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: null,
      payload: { text: 'The magic link has no expiry.' },
    } as any);
    expect(prose).toContain('The magic link has no expiry.');

    const tool = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'tool.used', agentId: null,
      payload: { name: 'Bash', target: 'npm test' },
    } as any);
    expect(tool).toContain('Bash');
    expect(tool).toContain('npm test');
  });

  it('tags events with their agent when one is present', () => {
    const line = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: 'agent-task-8-magiclink-abc',
      payload: { text: 'done' },
    } as any);
    expect(line).toContain('task-8-magiclink');
  });

  it('sanitizes escape sequences embedded in provider text before printing', () => {
    const line = formatEventLine({
      ts: '2026-09-10T14:31:22Z', kind: 'prose', agentId: null,
      payload: { text: 'safe\x1b]0;evil title\x07text' },
    } as any);
    expect(line).not.toMatch(/\x1b/);
    expect(line).toContain('safetext');
  });
});

// Transcript text is untrusted: it embeds raw tool output (file contents,
// command output), so a crafted file read by an agent can carry a terminal
// escape sequence. `stream` prints this text directly to stdout, so anything
// left unstripped reaches the user's real terminal.
describe('sanitizeForTerminal', () => {
  it('strips an OSC 52 clipboard-write sequence', () => {
    expect(sanitizeForTerminal('before\x1b]52;c;aGVsbG8=\x07after')).toBe('beforeafter');
  });

  it('strips an OSC 0 window-title sequence', () => {
    expect(sanitizeForTerminal('before\x1b]0;pwned\x07after')).toBe('beforeafter');
  });

  it('strips an OSC sequence terminated by ST (ESC \\) instead of BEL', () => {
    expect(sanitizeForTerminal('before\x1b]0;pwned\x1b\\after')).toBe('beforeafter');
  });

  it('strips a CSI erase-line sequence', () => {
    expect(sanitizeForTerminal('before\x1b[2Kafter')).toBe('beforeafter');
  });

  it('strips a bare ESC with no terminator, without eating the rest of the string', () => {
    expect(sanitizeForTerminal('before\x1bafter')).toBe('beforeafter');
  });

  it('strips a C1 control character', () => {
    expect(sanitizeForTerminal('before\x9bafter')).toBe('beforeafter');
  });

  it('strips C0 controls and DEL, including embedded newlines and tabs', () => {
    expect(sanitizeForTerminal('a\nb\tc\x7fd')).toBe('abcd');
  });

  it('passes ordinary punctuation and non-ASCII text through unchanged', () => {
    const plain = 'Reusing the "existing" JWT helper -> café, 日本語, ↑↓, boxes: ┌─┐';
    expect(sanitizeForTerminal(plain)).toBe(plain);
  });
});
