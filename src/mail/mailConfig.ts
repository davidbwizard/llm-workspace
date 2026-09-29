import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic, type Sender } from './files.ts';

export interface Specialist { runsOn: Sender; agent: string }
export interface MailConfig {
  enabled: boolean;
  passesPerLoop: number;
  lettersPerDay: number;
  runMinutes: number;
  specialists: Record<string, Specialist>;
}
export type ConfigResult = { ok: true; config: MailConfig } | { ok: false; reason: string };

export const DEFAULT_CONFIG: MailConfig = {
  enabled: true,
  passesPerLoop: 4,
  lettersPerDay: 40,
  runMinutes: 10,
  specialists: {
    'codex-reviewer': { runsOn: 'codex', agent: 'reviewer' },
    'claude-reviewer': { runsOn: 'claude', agent: 'reviewer' },
  },
};

const intIn = (v: unknown, min: number, max: number): boolean =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function parseMailConfig(text: string): ConfigResult {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `config.json is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof raw?.enabled !== 'boolean') return { ok: false, reason: 'config.json: "enabled" must be true or false' };
  if (!intIn(raw.passesPerLoop, 1, 20)) return { ok: false, reason: 'config.json: "passesPerLoop" must be a whole number from 1 to 20' };
  if (!intIn(raw.lettersPerDay, 1, 500)) return { ok: false, reason: 'config.json: "lettersPerDay" must be a whole number from 1 to 500' };
  if (!intIn(raw.runMinutes, 1, 60)) return { ok: false, reason: 'config.json: "runMinutes" must be a whole number from 1 to 60' };
  const specs = raw.specialists;
  if (specs === null || typeof specs !== 'object' || Array.isArray(specs)) {
    return { ok: false, reason: 'config.json: "specialists" must be an object' };
  }
  const specialists: Record<string, Specialist> = {};
  for (const [name, s] of Object.entries<any>(specs)) {
    if (!/^[a-z0-9-]{1,40}$/.test(name)) return { ok: false, reason: `config.json: specialist name "${name}" must be 1-40 lowercase letters, digits or dashes` };
    if (s?.runsOn !== 'claude' && s?.runsOn !== 'codex') return { ok: false, reason: `config.json: "${name}".runsOn must be "claude" or "codex"` };
    if (typeof s.agent !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.agent)) return { ok: false, reason: `config.json: "${name}".agent must be an agent file name` };
    specialists[name] = { runsOn: s.runsOn, agent: s.agent };
  }
  return {
    ok: true,
    config: { enabled: raw.enabled, passesPerLoop: raw.passesPerLoop, lettersPerDay: raw.lettersPerDay, runMinutes: raw.runMinutes, specialists },
  };
}

/** Reads config.json, writing the defaults first if it does not exist. */
export function loadMailConfig(path: string): ConfigResult {
  if (!existsSync(path)) writeFileAtomic(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `cannot read config.json (${(e as NodeJS.ErrnoException).code})` };
  }
  return parseMailConfig(text);
}
