// Files an agent's reply names, opened from the conversation pane.
//
// This module exists because the feature deliberately lets a string a model
// wrote reach an OS call, which nothing else in this app does (see
// revealSession's own comment in src/main/ipc.ts: the application name it
// passes to `open` comes from a closed map, never from the window). So the
// boundary is here, not in the renderer:
//
//   - The renderer only PROPOSES the candidate string it saw in the
//     transcript. It decides nothing.
//   - The session's working directory comes from `cwdForPid` -- the app's
//     own discovery data, keyed by pid -- and NEVER from the renderer. A pid
//     the app does not currently know has no root, so nothing resolves.
//   - realpath is taken of BOTH the root and the candidate before they are
//     compared, so a symlink sitting inside the project that points out of
//     it is refused (a lexical check alone cannot see that), and the
//     comparison itself is separator-aware, so /foo/barbaz is not inside
//     /foo/bar.
//   - Markdown is read, capped, and handed back as text for the app's own
//     renderer. Everything else is REVEALED in Finder. Never shell.openPath:
//     that launches the file's default application, which for a .command or
//     a .app is code execution straight out of model-written text. This
//     module takes `reveal` as a dependency and imports nothing from
//     electron, so there is no second, wronger call available to it.
//   - Read only, throughout. Nothing here writes.
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
// The same separator-aware containment check session:image already uses.
// Reused rather than restated: one implementation, one set of tests, and no
// chance of the two drifting into disagreeing about what "inside" means.
import { within } from './images.ts';

/** Past this the viewer says so and offers Finder instead of trying. A
 *  multi-megabyte document turns into tens of thousands of DOM nodes;
 *  react-markdown has no virtualisation and the pane would simply stop
 *  responding. */
export const MAX_MARKDOWN_BYTES = 512 * 1024;
/** ~1KB. A real path is nowhere near this; anything longer is not a path
 *  the renderer read off a screen. */
export const MAX_CANDIDATE_CHARS = 1024;
/** One conversation page's worth of candidates per round trip. The cap
 *  bounds the stat() fan-out a single renderer call can ask for. */
export const MAX_PROBE_CANDIDATES = 64;

const MARKDOWN_EXT = new Set(['.md', '.markdown']);

/** A trailing `:512` or `:512:8`. Shown in the conversation, stripped before
 *  the path is used -- the viewer renders a document, not a code editor, so
 *  the number is only ever a citation. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

export type FileKind = 'markdown' | 'other';

export type FileRefusal =
  | 'invalid' | 'no_session' | 'outside_root' | 'not_found'
  | 'too_large' | 'read_failed' | 'reveal_failed';

export type FileProbeResult =
  | { ok: true; kinds: (FileKind | null)[] }
  | { ok: false; reason: FileRefusal };

export type FileOpenResult =
  | { ok: true; action: 'markdown'; path: string; name: string; size: number; text: string }
  | { ok: true; action: 'revealed'; path: string; name: string }
  /** `name`/`size` ride along only with 'too_large', which is the one
   *  refusal the viewer shows rather than swallows -- it names the file and
   *  offers Finder. */
  | { ok: false; reason: FileRefusal; name?: string; size?: number };

export type FileDeps = {
  /** The session's working folder from the app's OWN fleet state, keyed by
   *  pid. Never the renderer's word for it -- that is the whole point of
   *  this argument existing rather than a cwd parameter on the channel. */
  cwdForPid: (pid: number) => string | null;
  /** shell.showItemInFolder, injected. Never shell.openPath -- see this
   *  file's own header. Injected so tests never actually raise Finder, the
   *  same shape src/main/ipc.ts's revealSession uses for `open`. */
  reveal: (path: string) => void;
};

const refuse = (reason: FileRefusal): { ok: false; reason: FileRefusal } => ({ ok: false, reason });

export function stripLineSuffix(raw: string): string {
  return raw.replace(LINE_SUFFIX, '');
}

async function realOrNull(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

type RootResult = { ok: true; root: string } | { ok: false; reason: FileRefusal };

/** The session's real working directory, or a refusal. Everything else in
 *  this module resolves against what this returns and nothing else. */
async function sessionRoot(rawPid: unknown, deps: FileDeps): Promise<RootResult> {
  if (typeof rawPid !== 'number' || !Number.isInteger(rawPid) || rawPid <= 0) return refuse('invalid');
  const cwd = deps.cwdForPid(rawPid);
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd) || cwd.includes('\0')) return refuse('no_session');
  const root = await realOrNull(cwd);
  if (!root) return refuse('no_session');
  return { ok: true, root };
}

type Resolved =
  | { ok: true; real: string; kind: FileKind; size: number }
  | { ok: false; reason: FileRefusal };

/** One candidate -> a real path inside `root`, or a refusal. This is the
 *  only place a renderer-supplied string becomes a path, and every check
 *  the module makes lives here. */
async function resolveIn(root: string, candidate: unknown): Promise<Resolved> {
  if (typeof candidate !== 'string') return refuse('invalid');
  const raw = candidate.trim();
  // NUL first: everything after one is invisible to a C string, so a
  // checked prefix and an opened path could otherwise differ.
  if (raw.length === 0 || raw.length > MAX_CANDIDATE_CHARS || raw.includes('\0')) return refuse('invalid');

  let p = stripLineSuffix(raw);
  if (p.length === 0) return refuse('invalid');
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  const abs = isAbsolute(p) ? p : resolve(root, p);

  const real = await realOrNull(abs);
  // realpath fails for a path that does not exist, which is also the
  // "must exist" check -- there is no second, TOCTOU-widening stat before
  // it.
  if (!real) return refuse('not_found');
  // Both sides are real paths by here: `root` was resolved in
  // sessionRoot. A symlink inside the project pointing out of it fails
  // exactly here, and so does /foo/barbaz against a /foo/bar root.
  if (!within(real, root)) return refuse('outside_root');

  let info;
  try { info = await stat(real); } catch { return refuse('not_found'); }
  // A directory is 'other': revealing it in Finder is meaningful, opening
  // it in a markdown viewer is not.
  const kind: FileKind = info.isFile() && MARKDOWN_EXT.has(extname(real).toLowerCase()) ? 'markdown' : 'other';
  return { ok: true, real, kind, size: info.size };
}

/** Which of these candidates are real files under this session's folder,
 *  and which of those are markdown. Read-only: nothing here opens, reads or
 *  reveals anything. The renderer asks this so a path that does not resolve
 *  can be left as plain text instead of becoming a link that does nothing.
 *
 *  Answers positionally -- `kinds[i]` is `candidates[i]`'s -- with null for
 *  every candidate refused, for any reason. The renderer is told only
 *  "not a file here", never why: a per-candidate refusal reason would let
 *  a compromised renderer probe the filesystem's shape outside the root. */
export async function probeSessionFiles(
  rawPid: unknown, candidates: unknown, deps: FileDeps,
): Promise<FileProbeResult> {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_PROBE_CANDIDATES) {
    return refuse('invalid');
  }
  const r = await sessionRoot(rawPid, deps);
  if (!r.ok) return r;
  const kinds = await Promise.all(candidates.map(async c => {
    const res = await resolveIn(r.root, c);
    return res.ok ? res.kind : null;
  }));
  return { ok: true, kinds };
}

/** Act on one candidate. Markdown comes back as text for the app's own
 *  renderer; everything else -- and anything at all when `reveal` is true --
 *  is shown in Finder and nothing more. */
export async function openSessionFile(
  rawPid: unknown, candidate: unknown, reveal: unknown, deps: FileDeps,
): Promise<FileOpenResult> {
  const r = await sessionRoot(rawPid, deps);
  if (!r.ok) return r;
  const res = await resolveIn(r.root, candidate);
  if (!res.ok) return res;

  const name = basename(res.real);
  // `reveal === true` strictly: an unrelated truthy value from a buggy or
  // hostile renderer must not silently change which branch runs.
  if (reveal === true || res.kind !== 'markdown') {
    try { deps.reveal(res.real); } catch { return refuse('reveal_failed'); }
    return { ok: true, action: 'revealed', path: res.real, name };
  }

  if (res.size > MAX_MARKDOWN_BYTES) return { ok: false, reason: 'too_large', name, size: res.size };
  let text: string;
  try { text = await readFile(res.real, 'utf8'); } catch { return refuse('read_failed'); }
  // The size was checked before the read; a file that grew in between is
  // still refused rather than sent.
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_MARKDOWN_BYTES) return { ok: false, reason: 'too_large', name, size: bytes };
  return { ok: true, action: 'markdown', path: res.real, name, size: res.size, text };
}
