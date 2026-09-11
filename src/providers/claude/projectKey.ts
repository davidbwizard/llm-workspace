import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

/** Claude Code's project key: the absolute cwd with EVERY non-alphanumeric
 *  character turned into a dash, the leading slash and any dots included.
 *  Logic harvested from munder-difflin's src/main/transcript.ts (MIT). */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The pre-2026 POSIX key: leading slash DROPPED, only slashes dashed, so
 *  dots survived. Kept solely so older transcripts stay readable. */
export function legacyProjectKey(cwd: string): string {
  return process.platform === 'win32'
    ? projectKey(cwd)
    : cwd.replace(/^\//, '').replaceAll('/', '-');
}

/** Prefer the CURRENT spelling; fall back to the legacy one only when it
 *  exists and the current one does not. When neither exists, return the
 *  CURRENT spelling — that is the one Claude Code will actually write to. */
export function projectDir(cwd: string, root = path.join(os.homedir(), '.claude/projects')): string {
  const current = path.join(root, projectKey(cwd));
  if (existsSync(current)) return current;
  const legacy = path.join(root, legacyProjectKey(cwd));
  if (existsSync(legacy)) return legacy;
  return current;
}
