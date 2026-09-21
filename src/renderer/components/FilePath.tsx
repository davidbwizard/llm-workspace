// Paths an agent wrote, made clickable inside the conversation.
//
// The renderer's whole job here is to PROPOSE a string. It never decides
// what a path means, where it resolves, or whether it may be touched --
// src/main/files.ts does all of that, from a working directory main looks up
// itself by pid. This file finds candidates in transcript text, asks main
// which of them are real, and renders the rest as the plain text it always
// was.
//
// Scope, deliberately: prose and inline code spans only. A fenced code block
// is there to be read and copied, and turning its contents into controls
// fights the Copy button that sits on it -- so the walker below skips mdast
// `code` nodes (fenced/indented) while handling `inlineCode`.
import {
  createContext, useContext, useEffect, useReducer,
  type ReactNode,
} from 'react';
import type { FileKind } from '../../main/files.ts';

/** The class the markdown transform marks a candidate with, and the class
 *  ConversationView.css styles the resulting control as. */
export const FILE_PATH_CLASS = 'fp';

/** Matches src/main/files.ts's MAX_CANDIDATE_CHARS. A candidate longer than
 *  this is refused there, so there is no point proposing it. */
const MAX_CANDIDATE_CHARS = 1024;
/** Matches src/main/files.ts's MAX_PROBE_CANDIDATES: main refuses a longer
 *  batch outright, so the queue below is sliced to this. */
const MAX_BATCH = 64;
/** Bounds on the answer cache. It is keyed by pid, and the entries are short
 *  strings, so the practical limit is how many distinct path-like strings a
 *  session's transcript contains -- tens of kilobytes at worst. The per-pid
 *  ceiling is deliberately far above that: clearing a pid's answers makes
 *  every path already ON SCREEN fall back to plain text (nothing re-asks
 *  until those components remount), so it must be a last resort, not routine
 *  housekeeping. Sessions come and go, so the number of PIDS is what is kept
 *  genuinely small, oldest evicted first. */
const MAX_CACHED = 5000;
const MAX_CACHED_PIDS = 8;

/** What a click on a resolved path does, and which session's folder it
 *  resolves against. Null (the default) is what keeps every path plain text
 *  wherever the conversation is rendered without a live session behind it --
 *  the file viewer's own content, for one. */
export type FileLink = {
  pid: number;
  /** The candidate, line number already stripped. Main revalidates all of
   *  it regardless; this is a proposal, not an instruction. */
  onOpen: (candidate: string) => void;
};
export const FileLinkContext = createContext<FileLink | null>(null);

// ---------------------------------------------------------------- finding

/** One path-ish run. `~`, `.` and `..` prefixes are allowed because agents
 *  write them; `:` is deliberately NOT a segment character, so a URL's
 *  scheme cannot glue itself to the path after it. */
const SEGMENT = '[A-Za-z0-9._+@~-]+';
/** The lookbehind is what keeps this from matching half of something else:
 *  the run must start at a boundary, never mid-token and never straight
 *  after a `/` or `:` -- which is what stops `https://example.com/a/b.md`
 *  being read as a path called `example.com/a/b.md`. */
const CANDIDATE = new RegExp(
  `(?<![A-Za-z0-9._+@~:/-])((?:\\.{1,2}/|~/|/)?${SEGMENT}(?:/${SEGMENT})*)(:\\d+(?::\\d+)?)?`,
  'g',
);
/** A bare filename (no separator at all) only counts as one when it carries
 *  a real extension. Two characters minimum, which is what keeps "e.g.",
 *  "i.e.", "a.m." and "version 1.2" out of the candidate list. */
const BARE_FILENAME = /^[^./][^/]*\.[A-Za-z0-9]{2,10}$/;

export type FoundPath = {
  /** Offset of the first character in the text it was found in. */
  start: number;
  /** Offset one past the last. */
  end: number;
  /** Exactly the characters between those offsets -- what stays on screen,
   *  line number included. */
  text: string;
};

/** Everything in `value` that reads as a path. Cheap and purely textual:
 *  nothing here knows whether any of it exists. */
export function findPaths(value: string): FoundPath[] {
  const out: FoundPath[] = [];
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(value); m !== null; m = CANDIDATE.exec(value)) {
    const body = m[1] ?? '';
    const line = m[2] ?? '';
    // A sentence's own punctuation sticks to the last segment, because `.`
    // has to be a segment character for "README.md" to work at all. Give
    // it back.
    const trimmed = body.replace(/[.\-]+$/, '');
    if (trimmed.length === 0) continue;
    const whole = trimmed + line;
    if (whole.length > MAX_CANDIDATE_CHARS) continue;
    const isPath = trimmed.includes('/') ? trimmed.length > 1 : BARE_FILENAME.test(trimmed);
    if (!isPath) continue;
    const start = m.index;
    out.push({ start, end: start + whole.length, text: whole });
  }
  return out;
}

/** The path main is asked about: what is on screen, minus a trailing line
 *  number. Mirrors src/main/files.ts's own stripLineSuffix -- main does it
 *  again regardless, since this side is not trusted to have done it. */
export function candidateOf(text: string): string {
  return text.replace(/:\d+(?::\d+)?$/, '');
}

// ------------------------------------------------- the markdown transform

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

/** Nodes whose contents are never linkified. `code` is the fenced/indented
 *  block (see this file's header); `link`/`linkReference` already mean
 *  something else when clicked; `html` never becomes elements here anyway
 *  (ConversationView.tsx's lockdown), so leaving it as text is right. */
const OPAQUE = new Set(['code', 'link', 'linkReference', 'definition', 'image', 'imageReference', 'html', 'yaml']);

/** The hast instructions that turn a marked node into `<span class="fp">`.
 *  mdast-util-to-hast applies `hName`/`hProperties` after the node's own
 *  handler has run, so this works both on the wrapper below and straight on
 *  an `inlineCode` node (whose `<code>` becomes the span). */
const AS_PATH_SPAN = { hName: 'span', hProperties: { className: [FILE_PATH_CLASS] } };

/** A remark plugin: marks every path in prose and in inline code so
 *  react-markdown renders it through PathSpan below. Mutates the tree in
 *  place, which is what remark transforms do. */
export function remarkFilePaths() {
  return (tree: MdNode) => { walk(tree); };
}

function walk(node: MdNode): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  let changed = false;
  const out: MdNode[] = [];
  for (const child of children) {
    if (OPAQUE.has(child.type)) { out.push(child); continue; }
    if (child.type === 'text' && typeof child.value === 'string') {
      const split = splitText(child.value);
      if (split) { out.push(...split); changed = true; } else out.push(child);
      continue;
    }
    if (child.type === 'inlineCode' && typeof child.value === 'string') {
      // Only when the span is a path and nothing else: `see src/a.ts and
      // src/b.ts` inside one code span stays a code span.
      const trimmed = child.value.trim();
      const found = findPaths(trimmed);
      if (found.length === 1 && found[0]!.start === 0 && found[0]!.end === trimmed.length) {
        child.value = trimmed;
        child.data = { ...child.data, ...AS_PATH_SPAN };
      }
      out.push(child);
      continue;
    }
    walk(child);
    out.push(child);
  }
  if (changed) node.children = out;
}

function splitText(value: string): MdNode[] | null {
  const found = findPaths(value);
  if (found.length === 0) return null;
  const parts: MdNode[] = [];
  let at = 0;
  for (const hit of found) {
    if (hit.start > at) parts.push({ type: 'text', value: value.slice(at, hit.start) });
    parts.push({ type: 'filePath', data: { ...AS_PATH_SPAN }, children: [{ type: 'text', value: hit.text }] });
    at = hit.end;
  }
  if (at < value.length) parts.push({ type: 'text', value: value.slice(at) });
  return parts;
}

// -------------------------------------------------------- asking the app

const known = new Map<number, Map<string, FileKind | null>>();
const queued = new Map<number, Set<string>>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Module state outlives a component, deliberately (re-rendering the same
 *  conversation should not re-stat every path) -- which means tests have to
 *  be able to reset it, exactly like state/pending.ts's clearPending. */
export function clearFileProbeCache(): void {
  known.clear();
  queued.clear();
  clearTimeout(timer);
  timer = undefined;
}

function cacheFor(pid: number): Map<string, FileKind | null> {
  let map = known.get(pid);
  if (!map) {
    map = new Map();
    known.set(pid, map);
    // A Map iterates in insertion order, so the first key is the pid whose
    // answers were cached longest ago.
    while (known.size > MAX_CACHED_PIDS) {
      const oldest = known.keys().next();
      if (oldest.done) break;
      known.delete(oldest.value);
    }
  }
  if (map.size >= MAX_CACHED) map.clear();
  return map;
}

function notify(): void { for (const cb of listeners) cb(); }

function request(pid: number, candidate: string): void {
  if (known.get(pid)?.has(candidate)) return;
  let set = queued.get(pid);
  if (!set) { set = new Set(); queued.set(pid, set); }
  if (set.has(candidate)) return;
  set.add(candidate);
  // Coalesced on a macrotask: one reply mentioning six files asks main
  // once, not six times, and a whole page of turns mounting together asks
  // once per page.
  if (timer === undefined) timer = setTimeout(flush, 0);
}

function flush(): void {
  timer = undefined;
  const batches = [...queued.entries()];
  queued.clear();
  const api = window.fleet;
  for (const [pid, set] of batches) {
    const all = [...set];
    for (let i = 0; i < all.length; i += MAX_BATCH) {
      const slice = all.slice(i, i + MAX_BATCH);
      const answer = api?.fileProbe?.(pid, slice);
      if (!answer) { record(pid, slice, () => null); continue; }
      answer.then(
        result => record(pid, slice, j => (result.ok ? result.kinds[j] ?? null : null)),
        (err: unknown) => {
          // A failed probe is recorded as "not a path", not left pending:
          // plain text is the honest outcome, and an unrecorded entry
          // would be re-queued by the next mount forever.
          console.error('session:file:probe failed:', err);
          record(pid, slice, () => null);
        },
      );
    }
  }
}

function record(pid: number, slice: string[], kindAt: (i: number) => FileKind | null): void {
  const map = cacheFor(pid);
  slice.forEach((candidate, i) => map.set(candidate, kindAt(i)));
  notify();
}

/** What main said this path is, or null while nothing is known yet and for
 *  anything it refused. Null is the safe answer in both cases: the path
 *  renders as text. */
function useFileProbe(pid: number | null, candidate: string): FileKind | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (pid === null) return;
    listeners.add(bump);
    request(pid, candidate);
    return () => { listeners.delete(bump); };
  }, [pid, candidate]);
  if (pid === null) return null;
  return known.get(pid)?.get(candidate) ?? null;
}

// ------------------------------------------------------------ the control

function textOf(children: ReactNode): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') return children[0];
  return null;
}

function PathLink({ text }: { text: string }) {
  const link = useContext(FileLinkContext);
  const candidate = candidateOf(text);
  const kind = useFileProbe(link?.pid ?? null, candidate);
  // Not a link at all until main says the file is really there: an agent
  // names plenty of paths that moved, were never created, or belong to
  // another machine, and a control that does nothing is worse than text.
  if (!link || kind === null) return <>{text}</>;
  return (
    <button
      type="button"
      className={FILE_PATH_CLASS}
      data-kind={kind}
      // Finder is never a surprise: the tooltip says which of the two
      // things a click does before it does it.
      title={kind === 'markdown' ? `Open ${candidate}` : `Reveal ${candidate} in Finder`}
      onClick={() => link.onOpen(candidate)}
    >{text}</button>
  );
}

type SpanProps = { className?: string; children?: ReactNode; node?: unknown };

/** react-markdown's `span` renderer. Only ever sees the spans
 *  remarkFilePaths marked -- raw HTML never becomes an element in this pane
 *  -- but checks the class anyway rather than assuming that. */
export function PathSpan({ className, children, node: _node, ...rest }: SpanProps) {
  const text = textOf(children);
  if (text === null || !className?.split(/\s+/).includes(FILE_PATH_CLASS)) {
    return <span className={className} {...rest}>{children}</span>;
  }
  return <PathLink text={text} />;
}
