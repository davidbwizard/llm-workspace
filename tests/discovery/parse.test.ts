import { describe, it, expect } from 'vitest';
import { parsePgrep, parseTty, parseLsofCwd, parseEtime, parseRss, classifyHost } from '../../src/discovery/parse.ts';

describe('parsePgrep', () => {
  it('extracts pids, one per line', () => {
    expect(parsePgrep('7994\n11328\n12014\n')).toEqual([7994, 11328, 12014]);
  });
  it('ignores blank lines and junk', () => {
    expect(parsePgrep('\n7994\n\nnope\n')).toEqual([7994]);
  });
  it('returns empty when nothing is running', () => {
    expect(parsePgrep('')).toEqual([]);
  });
});

describe('parseTty', () => {
  it('trims the ps output', () => {
    expect(parseTty(' ttys004 \n')).toBe('ttys004');
  });
  it('returns null for a process with no controlling terminal', () => {
    expect(parseTty('??\n')).toBeNull();
    expect(parseTty('')).toBeNull();
  });
});

describe('parseLsofCwd', () => {
  it('reads the n-prefixed field from -Fn output', () => {
    expect(parseLsofCwd('p7994\nfcwd\nn/Users/me/repo\n')).toBe('/Users/me/repo');
  });
  it('returns null when no cwd line is present', () => {
    expect(parseLsofCwd('p7994\nfcwd\n')).toBeNull();
  });
});

describe('parseEtime', () => {
  it('parses MM:SS', () => {
    expect(parseEtime('05:23  1234')).toBe(5 * 60 + 23);
  });
  it('parses HH:MM:SS', () => {
    expect(parseEtime('14:02:34  1234')).toBe((14 * 60 + 2) * 60 + 34);
  });
  it('parses DD-HH:MM:SS', () => {
    expect(parseEtime('09-14:02:34  1234')).toBe(((9 * 24 + 14) * 60 + 2) * 60 + 34);
  });
  it('returns null for malformed input', () => {
    expect(parseEtime('not-a-time  1234')).toBeNull();
    expect(parseEtime('')).toBeNull();
  });
});

describe('parseRss', () => {
  it('converts kilobytes (ps default unit) to bytes', () => {
    expect(parseRss('05:23  1234')).toBe(1234 * 1024);
  });
  it('returns null when the field is missing', () => {
    expect(parseRss('05:23')).toBeNull();
    expect(parseRss('')).toBeNull();
  });
  it('returns null for non-numeric input', () => {
    expect(parseRss('05:23  notanumber')).toBeNull();
  });
});

describe('classifyHost', () => {
  it('recognizes iTerm2 from the ancestry chain', () => {
    expect(classifyHost(['claude', '-zsh', 'login', 'iTermServer-3.6.11', 'iTerm2']))
      .toBe('iterm2');
  });
  it('recognizes VS Code', () => {
    expect(classifyHost(['claude', 'zsh', 'Code Helper', 'Code'])).toBe('vscode');
  });
  it('recognizes Terminal.app', () => {
    expect(classifyHost(['claude', '-zsh', 'login', 'Terminal'])).toBe('terminal');
  });
  it('falls back to unknown', () => {
    expect(classifyHost(['claude', 'sh', 'cron'])).toBe('unknown');
  });
});
