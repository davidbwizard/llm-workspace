import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseProcessList, parseTty, parseLsofCwd, parseEtime, parseRss, classifyHost, parseLsofNames,
  nodeHostedProvider,
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

// The npm-install bug (2026-09-22, found on the first outside user's
// machine): an npm-installed provider CLI is a JavaScript entry point with a
// `#!/usr/bin/env node` shebang, so the kernel runs NODE and the process's
// comm is `node`. Matching on comm alone never found it, and that user's
// sessions became untypeable after every app restart.
//
// Every fixture below is a real argv shape, captured 2026-09-22 with
// `ps -axo pid=,args=` (43 node processes on the dev machine). The
// false-positive cases are as load-bearing as the matches: reporting an
// unrelated Node process as a live agent session means the app would offer
// to type into it.
describe('nodeHostedProvider', () => {
  describe('matches a node-hosted provider CLI', () => {
    it('matches the npm global bin entry, the shape an npm install produces', () => {
      expect(nodeHostedProvider('node /Users/u/.nvm/versions/node/v22.13.0/bin/claude')).toBe('claude');
      expect(nodeHostedProvider('node /usr/local/bin/codex')).toBe('codex');
    });

    it('matches when argv[0] is a full path to node rather than the bare name', () => {
      expect(nodeHostedProvider('/Users/u/.nvm/versions/node/v20.20.2/bin/node /opt/homebrew/bin/claude'))
        .toBe('claude');
    });

    it('matches through a prefix with no /bin/ segment (pnpm, bun and volta global dirs vary)', () => {
      expect(nodeHostedProvider('node /Users/u/Library/pnpm/codex')).toBe('codex');
    });

    it('matches the package entry point run directly, by its node_modules scope and name', () => {
      expect(nodeHostedProvider('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'))
        .toBe('claude');
      expect(nodeHostedProvider('node /Users/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js'))
        .toBe('codex');
    });

    it('skips node option flags to find the script', () => {
      expect(nodeHostedProvider('node --enable-source-maps --max-old-space-size=8192 /usr/local/bin/claude'))
        .toBe('claude');
      expect(nodeHostedProvider('node --experimental-vm-modules /usr/local/bin/codex')).toBe('codex');
    });

    it('keeps the match when the CLI has arguments of its own', () => {
      expect(nodeHostedProvider('node /usr/local/bin/claude --resume abc-123')).toBe('claude');
      expect(nodeHostedProvider('node /usr/local/bin/codex resume --last')).toBe('codex');
    });
  });

  // Each of these is a real process class that was running on the dev machine
  // while this was written. A match here is a live agent session the app
  // would offer to type into.
  describe('does not match an unrelated Node process', () => {
    it('does not match a plain node server', () => {
      expect(nodeHostedProvider('node server.js')).toBeNull();
      expect(nodeHostedProvider('node /Users/u/Documents/claude-sessions-viewer/src/server/index.js')).toBeNull();
    });

    it('does not match a Vite dev server or preview server', () => {
      expect(nodeHostedProvider('node /Users/u/Documents/educational-farm/node_modules/.bin/vite preview --host 127.0.0.1 --port 4176'))
        .toBeNull();
      expect(nodeHostedProvider('node /Users/u/Documents/cocoa-grid/node_modules/.bin/vite')).toBeNull();
    });

    it('does not match an Electron main process, nor this app itself', () => {
      // Electron's comm is never `node`, so live.ts would not even ask --
      // but the argv is rejected on its own merits too.
      expect(nodeHostedProvider('/Users/u/Documents/llm-workspace/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/u/Documents/llm-workspace'))
        .toBeNull();
      expect(nodeHostedProvider('node /Users/u/Documents/llm-workspace/node_modules/.bin/electron .')).toBeNull();
    });

    it('does not match an MCP server or another node_modules tool, including OpenAI\'s own node-hosted ones', () => {
      expect(nodeHostedProvider('node /Users/u/Documents/trello-mcp-enhanced/build/index.js')).toBeNull();
      // ChatGPT.app ships its own node and runs a scoped package under it.
      // `@oai/cua-repl` is not `@openai/codex`, and `cua-repl` is not `codex`.
      expect(nodeHostedProvider('/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl'))
        .toBeNull();
    });

    it('does not match node with no script at all', () => {
      expect(nodeHostedProvider('node')).toBeNull();
      expect(nodeHostedProvider('')).toBeNull();
      expect(nodeHostedProvider('node --version')).toBeNull();
    });

    it('bails out on eval and check modes rather than reading the code as a path', () => {
      expect(nodeHostedProvider('node -e /usr/local/bin/claude')).toBeNull();
      expect(nodeHostedProvider('node --eval /usr/local/bin/codex')).toBeNull();
      expect(nodeHostedProvider('node -p /usr/local/bin/claude')).toBeNull();
      expect(nodeHostedProvider('node --check /usr/local/bin/claude')).toBeNull();
      expect(nodeHostedProvider('node --input-type=module -e /usr/local/bin/claude')).toBeNull();
    });

    // Deliberate: reach traded for precision. A relative path cannot be
    // resolved from a process listing (it is relative to THAT process's cwd,
    // not ours), and an installed CLI's path is always absolute.
    it('does not match a relative script path, even one named exactly like a provider', () => {
      expect(nodeHostedProvider('node ./claude')).toBeNull();
      expect(nodeHostedProvider('node bin/codex')).toBeNull();
      expect(nodeHostedProvider('node scripts/playtest-game.mjs --game dig-or-dash')).toBeNull();
    });

    // Deliberate: a project file named claude.js is far likelier than an
    // executable named exactly `claude`, so only the extensionless name --
    // which is what an npm bin entry is -- counts.
    it('does not match a same-named script with a file extension', () => {
      expect(nodeHostedProvider('node /Users/u/Documents/my-app/claude.js')).toBeNull();
      expect(nodeHostedProvider('node /Users/u/Documents/my-app/src/codex.mjs')).toBeNull();
    });

    it('does not match a lookalike scope or package directory', () => {
      expect(nodeHostedProvider('node /usr/local/lib/node_modules/@anthropic-ai/sdk/bin/run.js')).toBeNull();
      expect(nodeHostedProvider('node /usr/local/lib/node_modules/@openai/agents/bin/run.js')).toBeNull();
      expect(nodeHostedProvider('node /Users/u/claude-code/cli.js')).toBeNull();
    });
  });
});
