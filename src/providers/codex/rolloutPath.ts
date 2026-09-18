import { basename, isAbsolute, normalize, sep } from 'node:path';

/** A Codex rollout's file name (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */
export const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;

/** True only for an absolute, already-normalised path inside `codexRoot`
 *  whose file name is a rollout's. Shared by the context reader
 *  (src/main/usage.ts), which is about to open the path, and by process
 *  discovery (src/discovery/live.ts), which takes it from `lsof` output. */
export function isRolloutPath(f: unknown, codexRoot: string): f is string {
  if (typeof f !== 'string' || !isAbsolute(f) || normalize(f) !== f) return false;
  const root = normalize(codexRoot).replace(/\/+$/, '') + sep;
  return f.startsWith(root) && ROLLOUT_NAME.test(basename(f));
}
