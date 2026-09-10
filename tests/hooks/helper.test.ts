import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let spool: string;
const helper = resolve('src/hooks/helper.sh');

beforeEach(() => { spool = mkdtempSync(join(tmpdir(), 'spool-')); chmodSync(helper, 0o755); });
afterEach(() => rmSync(spool, { recursive: true, force: true }));

function run(payload: string) {
  execFileSync('sh', [helper], { input: payload, env: { ...process.env, LLMWS_SPOOL: spool } });
}

describe('hook helper', () => {
  it('writes one file per invocation', () => {
    run('{"hook_event_name":"Stop","session_id":"s1"}');
    run('{"hook_event_name":"Stop","session_id":"s2"}');
    expect(readdirSync(spool).filter(f => f.endsWith('.json'))).toHaveLength(2);
  });

  it('wraps the payload with a unique event_id and occurred_at', () => {
    run('{"hook_event_name":"PermissionRequest","session_id":"s1"}');
    const file = readdirSync(spool).find(f => f.endsWith('.json'))!;
    const rec = JSON.parse(readFileSync(join(spool, file), 'utf8'));
    expect(rec.event_id).toMatch(/[0-9A-Fa-f-]{36}/);
    expect(rec.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.payload.hook_event_name).toBe('PermissionRequest');
    expect(rec.payload.session_id).toBe('s1');
  });

  it('gives every invocation a distinct event_id', () => {
    run('{"hook_event_name":"Stop"}');
    run('{"hook_event_name":"Stop"}');
    const ids = readdirSync(spool).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(spool, f), 'utf8')).event_id);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves no partial .tmp files behind — writes are atomic renames', () => {
    run('{"hook_event_name":"Stop"}');
    expect(readdirSync(spool).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('exits 0 even on malformed input, so it never blocks the agent', () => {
    expect(() => run('not json')).not.toThrow();
  });
});
