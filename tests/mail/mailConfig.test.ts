import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadMailConfig, parseMailConfig } from '../../src/mail/mailConfig.ts';

const text = (over: Record<string, unknown>) => JSON.stringify({ ...DEFAULT_CONFIG, ...over });

describe('mail config', () => {
  it('accepts the defaults', () => {
    expect(parseMailConfig(text({}))).toEqual({ ok: true, config: DEFAULT_CONFIG });
  });

  it('refuses bad values with a reason', () => {
    expect(parseMailConfig('{')).toMatchObject({ ok: false });
    expect(parseMailConfig(text({ enabled: 'yes' }))).toEqual({ ok: false, reason: 'config.json: "enabled" must be true or false' });
    expect(parseMailConfig(text({ passesPerLoop: 0 }))).toMatchObject({ ok: false });
    expect(parseMailConfig(text({ lettersPerDay: 2.5 }))).toMatchObject({ ok: false });
    expect(parseMailConfig(text({ runMinutes: 61 }))).toMatchObject({ ok: false });
    expect(parseMailConfig(text({ specialists: { 'Bad Name': { runsOn: 'codex', agent: 'reviewer' } } }))).toMatchObject({ ok: false });
    expect(parseMailConfig(text({ specialists: { r: { runsOn: 'gemini', agent: 'reviewer' } } }))).toMatchObject({ ok: false });
    expect(parseMailConfig(text({ specialists: { r: { runsOn: 'codex', agent: '../x' } } }))).toMatchObject({ ok: false });
  });

  it('writes the defaults when the file is missing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-')), 'config.json');
    expect(loadMailConfig(file)).toEqual({ ok: true, config: DEFAULT_CONFIG });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_CONFIG);
  });

  it('keeps an existing file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mail-')), 'config.json');
    writeFileSync(file, text({ enabled: false }));
    expect(loadMailConfig(file)).toMatchObject({ ok: true, config: { enabled: false } });
  });
});
