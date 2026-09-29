import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { defaultMailDir, mailPaths } from './files.ts';
import { handleMessage } from './mcp.ts';
import { slotTools } from './slotTools.ts';

// Fleet Mail's slot: an MCP server on stdio, started by Claude Code or Codex.
//   node src/mail/slot.ts --from claude|codex
// stdout carries protocol messages only; diagnostics go to stderr.

const at = process.argv.indexOf('--from');
const sender = process.argv[at + 1];
if (at < 0 || (sender !== 'claude' && sender !== 'codex')) {
  process.stderr.write('fleet-mail: usage: slot.ts --from claude|codex\n');
  process.exit(2);
}

const tools = slotTools({
  paths: mailPaths(defaultMailDir(homedir())),
  sender,
  parentPid: process.ppid,
  now: Date.now,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  waitMs: 25_000,
});

const write = (msg: unknown): void => { process.stdout.write(`${JSON.stringify(msg)}\n`); };

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  handleMessage(msg, tools).then(
    res => { if (res) write(res); },
    (e: Error) => {
      process.stderr.write(`fleet-mail: ${e.stack ?? e.message}\n`);
      if (msg?.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
    },
  );
});
