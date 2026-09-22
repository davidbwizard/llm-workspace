// Paths an agent wrote, made clickable inside the conversation.
//
// The renderer's whole job here is to PROPOSE a string. It never decides
// what a path means, where it resolves, or whether it may be touched --
// src/main/files.ts does all of that, from a working directory main looks up
// itself by pid. This file finds candidates in transcript text, asks main
// which of them are real, and renders the rest as the plain text it always
// was.
//
// Scope: prose, inline code spans, fenced code blocks, and the TARGET of a
// markdown link when that target is a local path.
//
// Measured over 400 of David's real transcripts (2026-09-22, 5,563 `.md`
// mentions): 88.2% already became path spans. The misses that mattered were
// markdown-link targets (120, none linkified -- Codex is instructed to emit
// file references as `[app.py](/abs/path/app.py:12)`, so nearly every file
// reference in a Codex session was invisible here) and fenced code blocks
// (118). Prose misses looked large but were almost entirely this repo's own
// test fixtures quoted back in its own transcripts, and are correctly left
// alone.
//
// http/https link targets are untouched and still leave through the
// existing https-only window-open handler.
import {
  createContext, useContext, useEffect, useMemo, useReducer,
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

/** grep's context-line form: `docs/plan.md-2147-some text`. grep prints
 *  `path:N:` for a matching line and `path-N-` for a context line, and
 *  agents paste both. The `:N:` form already falls out of the line-number
 *  suffix below; this is its twin.
 *
 *  Cut at the LAST extension followed by `-<digits>`, optionally with the
 *  rest of grep's line after it. Greedy, so `a.b-1-c.md` keeps as much as
 *  it can; anchored to the end, so it only ever fires on a whole candidate
 *  rather than mid-path. The trailing separator may already be gone --
 *  findPaths trims trailing punctuation -- which is why it is optional.
 *
 *  Measured: 95 occurrences across 6 distinct files in the sample. Small,
 *  but the alternative is a path that is on screen, reads as ordinary, and
 *  silently never opens. It cannot produce a false live link either way:
 *  the probe still has to say the file is there. */
const GREP_CONTEXT = /^(.*\.[A-Za-z0-9]{1,10})-\d+(?:[-:].*)?$/;

/** The path main is asked about: what is on screen, minus a trailing line
 *  number and minus anything grep glued to the end of it. Mirrors
 *  src/main/files.ts's own stripLineSuffix for the `:N` part -- main does
 *  that again regardless, since this side is not trusted to have done it.
 *  The grep cut is renderer-only on purpose: it is about what agents paste,
 *  not about what main will accept, and main revalidates the result either
 *  way. */
export function candidateOf(text: string): string {
  const grep = GREP_CONTEXT.exec(text);
  const body = grep ? grep[1]! : text;
  return body.replace(/:\d+(?::\d+)?$/, '');
}

// ------------------------------------------------- the markdown transform

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

/** Nodes whose contents are never linkified.
 *
 *  `link` is NOT in this set any more -- see linkTarget below. Its CHILDREN
 *  are still left alone (the label stays the label); it is the target that
 *  is considered. `linkReference` stays opaque: its target lives in a
 *  separate definition node, and reference-style links to local files do
 *  not appear in these transcripts.
 *
 *  `code` is no longer here either: a fenced block's contents are linkified
 *  in the React layer instead (ConversationView.tsx's CodeBlock), so the
 *  block keeps one verbatim text node for copying. `html` never becomes
 *  elements here anyway (ConversationView.tsx's lockdown), so leaving it as
 *  text is right. */
const OPAQUE = new Set(['code', 'linkReference', 'definition', 'image', 'imageReference', 'html', 'yaml']);

/** Whether a markdown link's target is a local path this viewer could open,
 *  rather than something the browser should handle.
 *
 *  Anything carrying a scheme is left alone -- http and https above all,
 *  which keep going out through main's https-only window-open handler, but
 *  also mailto:, file: and anything else. A bare fragment or query is not a
 *  path either. What is left is what agents actually write for a file:
 *  `/abs/path/app.py`, `./notes.md`, `docs/plan.md`. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function localLinkTarget(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (raw.length === 0 || raw.length > MAX_CANDIDATE_CHARS) return null;
  if (HAS_SCHEME.test(raw) || raw.startsWith('#') || raw.startsWith('?') || raw.startsWith('//')) return null;
  // It must still read as a path by the same rule prose uses, so a link
  // target of "click here" is not proposed to main.
  const candidate = candidateOf(raw);
  const found = findPaths(candidate);
  if (found.length !== 1 || found[0]!.start !== 0 || found[0]!.end !== candidate.length) return null;
  return raw;
}

/** The hast instructions that turn a marked node into `<span class="fp">`.
 *  mdast-util-to-hast applies `hName`/`hProperties` after the node's own
 *  handler has run, so this works both on the wrapper below and straight on
 *  an `inlineCode` node (whose `<code>` becomes the span). */
const AS_PATH_SPAN = { hName: 'span', hProperties: { className: [FILE_PATH_CLASS] } };

/** The same, for a node whose visible text is NOT the path -- a markdown
 *  link, whose label is the label and whose target is the candidate. The
 *  target rides along as a data attribute so PathSpan can tell the two
 *  apart without guessing from the children. */
export const PATH_ATTR = 'data-file-path';
function asPathSpan(target: string) {
  return { hName: 'span', hProperties: { className: [FILE_PATH_CLASS], [PATH_ATTR]: target } };
}

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
    if (child.type === 'link') {
      // The TARGET becomes the candidate; the label stays exactly as
      // written (`[app.py](/abs/path/app.py:12)` still reads "app.py").
      // A web target is left completely alone -- not marked, not walked --
      // so http/https behaviour is bit-for-bit what it was.
      const target = localLinkTarget((child as { url?: unknown }).url);
      if (target !== null) {
        child.data = { ...child.data, ...asPathSpan(target) };
      }
      out.push(child);
      continue;
    }
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

/** How long a MISS is believed. A hit is kept for the window's life: a file
 *  that exists does not usually stop existing mid-session, and re-probing
 *  hits would be pure churn. A miss is the answer that goes stale -- an
 *  agent names a doc in a plan and writes it a minute later -- and before
 *  this it was permanent, so the path stayed plain text for the rest of the
 *  session even once the file was there.
 *
 *  Expiry is checked when a probe is REQUESTED, never on render: a mounted
 *  path re-asks when the module notifies it (any probe result for any path
 *  in the same conversation), and a fresh mount re-asks anyway. So the
 *  common case -- the agent writes the file and says so in the next turn,
 *  which probes its own paths -- clears the stale miss as a side effect,
 *  with no timer of its own. */
const MISS_TTL_MS = 30_000;

type Answer = { kind: FileKind | null; at: number };

const known = new Map<number, Map<string, Answer>>();
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

function cacheFor(pid: number): Map<string, Answer> {
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

/** Whether the cached answer still counts. A hit always does; a miss only
 *  until MISS_TTL_MS has passed. */
function fresh(answer: Answer | undefined, now: number): boolean {
  if (answer === undefined) return false;
  return answer.kind !== null || now - answer.at < MISS_TTL_MS;
}

function request(pid: number, candidate: string): void {
  const map = known.get(pid);
  const answer = map?.get(candidate);
  if (fresh(answer, Date.now())) return;
  // A stale miss is dropped rather than left to shadow the new answer.
  if (answer !== undefined) map?.delete(candidate);
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
  const at = Date.now();
  slice.forEach((candidate, i) => map.set(candidate, { kind: kindAt(i), at }));
  notify();
}

/** What main said this path is, or null while nothing is known yet and for
 *  anything it refused. Null is the safe answer in both cases: the path
 *  renders as text. */
function useFileProbe(pid: number | null, candidate: string): FileKind | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (pid === null) return;
    // The listener re-REQUESTS as well as re-rendering, which is what
    // makes an expired miss get asked again without a timer: `request`
    // returns immediately for anything still fresh, so this cannot loop.
    const onChange = () => { request(pid, candidate); bump(); };
    listeners.add(onChange);
    request(pid, candidate);
    return () => { listeners.delete(onChange); };
  }, [pid, candidate]);
  if (pid === null) return null;
  return known.get(pid)?.get(candidate)?.kind ?? null;
}

// ------------------------------------------------------------ the control

function textOf(children: ReactNode): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') return children[0];
  return null;
}

/** `label` is what stays on screen; `candidate` is what main is asked
 *  about. They are the same string for a path written in prose, and differ
 *  for a markdown link, where the label is the link's own text. */
export function PathLink({ candidate, label }: { candidate: string; label: ReactNode }) {
  const link = useContext(FileLinkContext);
  const kind = useFileProbe(link?.pid ?? null, candidate);
  // Not a link at all until main says the file is really there: an agent
  // names plenty of paths that moved, were never created, or belong to
  // another machine, and a control that does nothing is worse than text.
  // This is also why nothing here can ever look live and not be -- the
  // button exists only once a probe has said the file does.
  if (!link || kind === null) return <>{label}</>;
  return (
    <button
      type="button"
      className={FILE_PATH_CLASS}
      data-kind={kind}
      // Finder is never a surprise: the tooltip says which of the two
      // things a click does before it does it.
      title={kind === 'markdown' ? `Open ${candidate}` : `Reveal ${candidate} in Finder`}
      onClick={() => link.onOpen(candidate)}
    >{label}</button>
  );
}

/** A fenced code block's text, with its paths made clickable IN PLACE.
 *
 *  Done here in React rather than in the remark plugin, and that is the
 *  whole trick for the Copy button. The block still renders as one <pre>
 *  whose descendants are text nodes and inline <button>s, and
 *  `textContent` concatenates every descendant -- so the Copy button
 *  (ConversationView.tsx, which reads exactly that) copies the block
 *  verbatim, path text included, byte for byte as written. Nothing is
 *  added to the text, nothing is reordered, and the buttons carry
 *  `user-select: text` so a drag across the block selects through them.
 *
 *  Capped: a block naming hundreds of paths would otherwise stat hundreds
 *  of files for a thing nobody is going to click. Past the cap the rest of
 *  the block is plain text, which is what it was before anyway. */
const MAX_PATHS_PER_BLOCK = 40;

export function LinkedCodeText({ text }: { text: string }) {
  const link = useContext(FileLinkContext);
  const parts = useMemo(() => {
    if (!link) return null;
    const found = findPaths(text).slice(0, MAX_PATHS_PER_BLOCK);
    if (found.length === 0) return null;
    const out: ReactNode[] = [];
    let at = 0;
    found.forEach((hit, i) => {
      if (hit.start > at) out.push(text.slice(at, hit.start));
      out.push(<PathLink key={`${hit.start}-${i}`} candidate={candidateOf(hit.text)} label={hit.text} />);
      at = hit.end;
    });
    if (at < text.length) out.push(text.slice(at));
    return out;
  }, [text, link]);
  if (parts === null) return <>{text}</>;
  return <>{parts}</>;
}

type SpanProps = {
  className?: string;
  children?: ReactNode;
  node?: unknown;
  /** Set only on a marked markdown link: the target, where the visible
   *  children are the label rather than the path. */
  [PATH_ATTR]?: unknown;
};

/** react-markdown's `span` renderer. Only ever sees the spans
 *  remarkFilePaths marked -- raw HTML never becomes an element in this pane
 *  -- but checks the class anyway rather than assuming that. */
export function PathSpan({ className, children, node: _node, ...rest }: SpanProps) {
  if (!className?.split(/\s+/).includes(FILE_PATH_CLASS)) {
    return <span className={className} {...rest}>{children}</span>;
  }
  // A marked link: the candidate is its target and the label is whatever
  // the author wrote between the brackets, which may be styled and is not
  // necessarily a plain string.
  const target = (rest as Record<string, unknown>)[PATH_ATTR];
  if (typeof target === 'string') {
    const { [PATH_ATTR]: _t, ...plain } = rest as Record<string, unknown>;
    void plain;
    return <PathLink candidate={candidateOf(target)} label={children} />;
  }
  const text = textOf(children);
  if (text === null) return <span className={className} {...rest}>{children}</span>;
  return <PathLink candidate={candidateOf(text)} label={text} />;
}
