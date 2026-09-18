import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseProcessList, parseTty, parseLsofCwd, parseEtime, parseRss, classifyHost, parseLsofNames,
} from '../../src/discovery/parse.ts';

describe('parseProcessList', () => {
  it('extracts pid and command, one process per line', () => {
    expect(parseProcessList('7994 claude\n11328 codex\n12014 zsh\n')).toEqual([
      { pid: 7994, comm: 'claude' },
      { pid: 11328, comm: 'codex' },
      { pid: 12014, comm: 'zsh' },
    ]);
  });
  it('keeps a full path intact, spaces and all -- only the first field is the pid', () => {
    expect(parseProcessList('42 /Applications/ChatGPT.app/Contents/Resources/codex\n')).toEqual([
      { pid: 42, comm: '/Applications/ChatGPT.app/Contents/Resources/codex' },
    ]);
    expect(parseProcessList('43 /Applications/My App/Contents/MacOS/claude\n')).toEqual([
      { pid: 43, comm: '/Applications/My App/Contents/MacOS/claude' },
    ]);
  });
  it('tolerates the leading whitespace ps pads pids with', () => {
    expect(parseProcessList('  501 claude\n 1234 codex\n')).toEqual([
      { pid: 501, comm: 'claude' },
      { pid: 1234, comm: 'codex' },
    ]);
  });
  it('ignores blank lines and lines with no command', () => {
    expect(parseProcessList('\n7994 claude\n\n12014\nnope\n')).toEqual([{ pid: 7994, comm: 'claude' }]);
  });
  it('returns empty when nothing is running', () => {
    expect(parseProcessList('')).toEqual([]);
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

// Recorded 2026-09-18 from `lsof -Fpn -p 45781,45783,46619,80187` on the
// machine with the moved-folder Codex session (username replaced with a
// same-length placeholder, one IPv6 socket address with documentation ones).
const LSOF_FPN = readFileSync(resolve('tests/fixtures/discovery/lsof-Fpn-codex.txt'), 'utf8');

describe('parseLsofNames', () => {
  it('groups every n line under the p line before it, skipping the f lines lsof always adds', () => {
    const got = parseLsofNames(LSOF_FPN, new Set([45781, 45783, 46619, 80187]));
    expect([...got.keys()]).toEqual([45781, 45783, 46619, 80187]);
    expect(got.get(80187)![0]).toBe('/Users/exampleuser00/Documents/ExampleOrg/Education/educational-farm');
    expect(got.get(80187)!.filter(n => n.includes('/rollout-'))).toHaveLength(6);
    expect(got.get(46619)!.some(n => n.includes('/rollout-'))).toBe(false);
    expect([...got.values()].flat().some(n => /^[pf]\d/.test(n))).toBe(false);
  });

  it('drops names under a pid that was not asked for, and names before any p line', () => {
    const out = 'n/orphan\np1\nfcwd\nn/a\np2\nf3\nn/b\n';
    expect(parseLsofNames(out, new Set([1]))).toEqual(new Map([[1, ['/a']]]));
  });

  it('returns nothing for empty or garbage output', () => {
    expect(parseLsofNames('', new Set([1]))).toEqual(new Map());
    expect(parseLsofNames('lsof: WARNING\n<html>\npnot-a-pid\nn/x\n', new Set([1]))).toEqual(new Map());
  });
});
