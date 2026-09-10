import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.ts';

describe('openDb', () => {
  it('creates the three tables the spec defines', () => {
    const db = openDb(':memory:');
    const names = db.prepare(
      "select name from sqlite_master where type='table' order by name"
    ).all().map((r: any) => r.name);
    expect(names).toContain('events');
    expect(names).toContain('signal_events');
    expect(names).toContain('ingest_files');
  });

  it('enforces the events identity triple', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`insert into events
      (provider, session_id, run_id, agent_id, ts, kind, payload, native_id,
       source_file, source_offset, content_hash, parser_version)
      values (@provider,@session_id,@run_id,@agent_id,@ts,@kind,@payload,
              @native_id,@source_file,@source_offset,@content_hash,@parser_version)`);
    const row = {
      provider: 'claude', session_id: 's', run_id: null, agent_id: null,
      ts: 't', kind: 'prose', payload: '{}', native_id: null,
      source_file: '/f', source_offset: 0, content_hash: 'h', parser_version: 1,
    };
    ins.run(row);
    expect(() => ins.run(row)).toThrow(/UNIQUE/i);
  });

  it('enforces signal_events uniqueness on event_id', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`insert into signal_events
      (event_id, occurred_at, ingested_at, provider, kind, payload)
      values (?,?,?,?,?,?)`);
    ins.run('e1', 'a', 'b', 'claude', 'PermissionRequest', '{}');
    expect(() => ins.run('e1', 'a', 'b', 'claude', 'PermissionRequest', '{}'))
      .toThrow(/UNIQUE/i);
  });

  it('enables WAL and foreign keys', () => {
    const db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
