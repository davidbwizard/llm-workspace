// Whether Codex has approved the hooks this app installed.
//
// Codex does not run a hook it has not been shown: a new or changed one puts
// a "Hooks need review" screen in front of the next session, and until the
// person accepts there the hook sits in hooks.json and never fires. Writing
// the file is therefore only half an install, and an app that reported
// "installed" on the strength of the write alone would be claiming a state
// the machine does not show -- the same rule hooksState already keeps for
// settings.json.
//
// Codex records each accepted hook in ~/.codex/config.toml:
//
//     [hooks.state."/Users/me/.codex/hooks.json:permission_request:0:0"]
//     trusted_hash = "sha256:c8ae..."
//
// The key is <file>:<event>:<entry index>:<hook index>, with the event in
// snake_case.
//
// PRESENCE, NOT VERIFICATION. `trusted_hash` is over something this code
// cannot reproduce -- the command string, the hook object and the entry
// object were all measured on 2026-09-24 and none of them hash to the value
// Codex stored. So this answers "has Codex ever approved a hook of ours at
// this position", not "is the hook on disk still the approved one". That is
// the honest limit, and the failure mode is benign: if the record is stale,
// Codex simply asks again, which is what the person is told will happen
// anyway.
//
// Read with a targeted text scan rather than a TOML parser: this needs one
// table header out of a file Codex owns, and a dependency for that is not
// worth carrying. Anything it cannot read reads as "not approved", which is
// the conservative answer -- it prompts the person to check rather than
// quietly claiming approval.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Paths } from '../config.ts';

/** `PermissionRequest` -> `permission_request`, the spelling Codex uses in
 *  its own state keys. */
export function snakeEvent(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The config file Codex keeps its hook trust records in, beside the hooks
 *  file itself. */
export function codexConfigPath(paths: Paths): string {
  return join(dirname(paths.codexHooks), 'config.toml');
}

/** True when Codex has a trust record for a hook of ours on `event`.
 *  False for no record, an unreadable config, or no Codex at all. */
export function codexHookApproved(paths: Paths, event: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(codexConfigPath(paths), 'utf8');
  } catch {
    return false;
  }
  // [hooks.state."<hooks.json>:<event>:<i>:<j>"] -- any index, since where
  // our entry sits in the file depends on what else is already there.
  const key = new RegExp(
    `^\\[hooks\\.state\\."${escapeForRegex(paths.codexHooks)}:${escapeForRegex(snakeEvent(event))}:\\d+:\\d+"\\]`,
    'm',
  );
  return key.test(raw);
}
