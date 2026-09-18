import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type MutableRefObject } from 'react';
import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationPage, ConversationTurn } from '../../store/conversation.ts';
import type { MatchQuality } from '../../discovery/match.ts';
import type { Provider } from '../../core/types.ts';
import type { KeysResult } from '../../main/ipc.ts';
import type { StageRefusal } from '../../main/staging.ts';
import { ProviderMark } from './ProviderMark.tsx';
import { REFUSAL_TEXT } from './ReplyPopover.tsx';
import { WorkingStrip } from './WorkingStrip.tsx';
import { WaitingFallback } from './WaitingCard.tsx';
import { PromptCard } from './PromptCard.tsx';
import { useSettings } from '../state/settings.ts';
import { useSessionLive } from '../state/useSessionLive.ts';
import { addPending, pendingFor, dropPending, matchPending, markQueued, tickIdle, NOT_SEEN_AFTER_MS } from '../state/pending.ts';
import './ConversationView.css';

/** Transcript text is untrusted, so markdown rendering is locked down:
 *  - No rehype-raw. react-markdown turns raw HTML into plain text, so it
 *    shows escaped and never becomes an element.
 *  - Links get target=_blank. A click then goes through the main process's
 *    setWindowOpenHandler (src/main/index.ts), which opens only https links in
 *    the browser and denies everything else; will-navigate is blocked there
 *    too. The app window itself never navigates. react-markdown's default
 *    urlTransform already blanks javascript: and other unsafe schemes.
 *  - Images never load (no remote fetch, no tracking pixel). The alt text
 *    stands in for them. */
/** The word "agent" is gone from the meta line (spec §2): the agent is
 *  marked with its provider's own glyph, in the accent colour. The glyph is
 *  aria-hidden (ProviderMark.tsx), so the provider's NAME rides along in a
 *  visually-hidden span -- a screen reader hears "Claude", a reader sees the
 *  mark, and neither hears nor sees the word "agent". */
const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

const COPY_LABEL = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' } as const;

/** One-click copy that reports what actually happened for a moment. A
 *  failed write says "Copy failed" and logs why -- never a false "Copied".
 *  The write is wrapped so a missing clipboard API (which throws rather
 *  than rejecting) lands in the same failure path. */
function CopyButton({ getText, what }: { getText: () => string; what: string }) {
  const [state, setState] = useState<keyof typeof COPY_LABEL>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  // Set on every mount, not just initialised: StrictMode (main.tsx) mounts,
  // unmounts and remounts in dev, and a flag only ever cleared stayed false,
  // so the copy ran but its result was never shown.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);
  const settle = (next: keyof typeof COPY_LABEL) => {
    if (!alive.current) return;
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (alive.current) setState('idle'); }, 2000);
  };
  const copy = () => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(getText()))
      .then(() => settle('copied'), (err: unknown) => {
        console.error('clipboard write failed:', err);
        settle('failed');
      });
  };
  return (
    <button type="button" className="copy-btn" data-state={state} onClick={copy}
      title={COPY_LABEL[state]} aria-label={state === 'idle' ? `Copy ${what}` : COPY_LABEL[state]}>
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"
        strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {state === 'copied' ? <path d="m3.5 8.5 3 3 6-7" />
          : state === 'failed' ? <path d="M8 4.5v4M8 11.2v.1M8 1.8 14.5 13.5h-13z" />
            : <><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 5.5V3.6c0-.9-.7-1.6-1.6-1.6H3.6c-.9 0-1.6.7-1.6 1.6v5.3c0 .9.7 1.6 1.6 1.6h1.9" /></>}
      </svg>
      {state !== 'idle' && <span className="copy-note">{COPY_LABEL[state]}</span>}
    </button>
  );
}

/** A fenced code block with its own Copy button. The text is read from the
 *  rendered <pre> at click time, so what is copied is exactly what shows. */
function CodeBlock(props: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="md-codeblock">
      <pre ref={ref} {...props} />
      <CopyButton what="code" getText={() => ref.current?.textContent ?? ''} />
    </div>
  );
}

/** Which session the Markdown being rendered belongs to, for LinkedImage. */
const SessionIdContext = createContext<string | null>(null);

/** Any URL scheme at all -- a web, data or script URL is never asked for. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** An image a reply links to. A local path (or file: URL) is read and checked
 *  by main, which hands back a data: URL -- this pane's CSP allows no other
 *  way to show a local file, and should not. Web images are never fetched.
 *  Until an image arrives, or if main refuses it, the alt text shows, as it
 *  always did. */
function LinkedImage({ src, alt }: { src?: string; alt?: string }) {
  const sessionId = useContext(SessionIdContext);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const local = !!src && (!HAS_SCHEME.test(src) || /^file:/i.test(src));
  useEffect(() => {
    setDataUrl(null);
    if (!local || !sessionId || !src || !window.fleet?.image) return;
    let current = true;
    window.fleet.image(sessionId, src).then(
      r => { if (current && r.ok) setDataUrl(r.dataUrl); },
      (err: unknown) => console.error('session:image failed:', err),
    );
    return () => { current = false; };
  }, [local, sessionId, src]);
  if (!dataUrl) return <span className="md-image">{alt || 'image'}</span>;
  return <img className="md-thumb" src={dataUrl} alt={alt ?? ''} title={src} />;
}

/** Claude Code's placeholder for an image attached to a prompt. */
const IMAGE_MARKER = /\[Image #\d+\]/;
const IMAGE_MARKERS = /\[Image #\d+\][ \t]*/g;

/** Your message, plus any images you attached to it. Only a message that
 *  carries Claude Code's "[Image #N]" placeholder is looked up -- main reads
 *  the pixels back from the transcript (src/main/attachments.ts). Once they
 *  arrive the placeholders are dropped from the text; if they never do, the
 *  text shows exactly as it always did. The images live in this component's
 *  state, so live refreshes of the list do not read the file again. */
function UserText({ id, text }: { id: number; text: string }) {
  const [images, setImages] = useState<string[]>([]);
  const hinted = IMAGE_MARKER.test(text);
  useEffect(() => {
    setImages([]);
    if (!hinted || !window.fleet?.attachments) return;
    let current = true;
    window.fleet.attachments(id).then(
      r => { if (current && r.ok) setImages(r.images); },
      (err: unknown) => console.error('session:attachments failed:', err),
    );
    return () => { current = false; };
  }, [id, hinted]);
  const shown = images.length ? text.replace(IMAGE_MARKERS, '').trim() : text;
  return (
    <>
      {shown && <p className="turn-text">{shown}</p>}
      {images.length > 0 && (
        <div className="turn-thumbs">
          {images.map((src, i) => <img key={i} src={src} alt={`Attached image ${i + 1}`} />)}
        </div>
      )}
    </>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: ({ src, alt }) => <LinkedImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
};

/** react-markdown's default drops file: URLs; keep them for images only, so
 *  LinkedImage can hand them to main. Everything else is unchanged. */
const urlTransform: UrlTransform = (url, key, node) =>
  key === 'src' && node.tagName === 'img' && /^file:/i.test(url) ? url : defaultUrlTransform(url);

// Exported for PromptCard.tsx (Task 5): a plan's markdown goes through this
// exact renderer (spec §9 -- "the plan renders through the existing
// markdown renderer"), never a second one. PromptCard.tsx importing this
// while this file imports PromptCard.tsx (below, for the prompt card
// itself) makes the two modules mutually referential -- harmless here,
// since both only ever call each other's exports from inside a render, well
// after module evaluation finishes, never at module-top-level.
export function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS} urlTransform={urlTransform}>
      {text}
    </Markdown>
  );
}

/** "Sep 12" -- no year, no weekday. Shown once per day, on the divider above
 *  that day's first turn (see showDate in the render loop). Pinned to
 *  en-US rather than the runtime's default locale so this renders the same
 *  format on every machine (and so tests can assert an exact string). */
function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** e.g. "10:32 AM" -- every row's whole timestamp; the date lives on the day
 *  divider instead. Same en-US pin as formatDate, for the
 *  same reason. */
function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** How close (in px) to the TOP of the scroll container counts as "close
 *  enough to fetch the next page" -- a little slack so the fetch is already
 *  in flight by the time the reader actually reaches the oldest loaded
 *  message, rather than starting only once they hit the top and have to
 *  wait staring at nothing. */
const LOAD_MORE_THRESHOLD_PX = 150;

/** How close to the bottom counts as "still following the conversation".
 *  Inside this, new messages scroll the pane down; outside it, the view
 *  stays where the reader put it and offers Jump to latest instead (spec
 *  §3.2). 80px is roughly one message of slack. */
const STICKY_BOTTOM_PX = 80;

/** Chat order (spec §3.1) puts the OLDEST loaded turn at the TOP, so
 *  reading further back in time means scrolling UP -- and "running low on
 *  loaded history" means nearing the top, which is what this checks. It
 *  used to mean the opposite, because the pane used to render newest-first;
 *  that is the single behaviour change here, not a new function.
 *
 *  Takes only `scrollTop`: the distance from the top IS scrollTop, with no
 *  height arithmetic to do, which is also why the tests for this need no
 *  jsdom geometry stub at all.
 *
 *  Exported as a plain function over plain numbers, rather than inlined
 *  against a live element, because jsdom does not compute real layout. */
export function nearOlderEdge(metrics: { scrollTop: number }, thresholdPx = LOAD_MORE_THRESHOLD_PX): boolean {
  return metrics.scrollTop < thresholdPx;
}

/** Whether the reader is still following the newest end. Same
 *  numbers-not-elements shape as nearOlderEdge, for the same jsdom reason.
 *  A pane with nothing to scroll (scrollHeight <= clientHeight) reads as
 *  at-the-bottom, which is correct: there is no "up" to have scrolled to. */
export function nearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  thresholdPx = STICKY_BOTTOM_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

/** Where scrollTop must land after a PREPEND so the reader's eye does not
 *  move. Content inserted above the viewport pushes everything down by
 *  exactly the height it added, so adding that same delta back cancels it
 *  out. Clamped at 0: a commit that made the pane shorter would otherwise
 *  produce a negative position, which a browser clamps silently and jsdom
 *  stores verbatim -- a difference no test would catch except this one. */
export function restoredScrollTop(
  scrollTopBefore: number, scrollHeightBefore: number, scrollHeightAfter: number,
): number {
  return Math.max(0, scrollTopBefore + (scrollHeightAfter - scrollHeightBefore));
}

/** Identity of the newest turn, including its length. A prepend never
 *  changes it; a brand-new turn does; and so does the last assistant turn
 *  growing as its reply streams, which is exactly what the sticky bottom
 *  needs to follow. */
function lastTurnKey(turns: ConversationTurn[]): string | null {
  const last = turns[turns.length - 1];
  return last ? `${last.id}:${last.text.length}` : null;
}

/** Folds a freshly-fetched NEWEST page into the turns already loaded.
 *
 *  Two rules, and they are different on purpose:
 *  - a turn whose id is already loaded is REPLACED in place, because the
 *    last assistant turn grows as its reply streams and keeps its row id;
 *  - anything genuinely new is appended at the bottom, in the incoming
 *    page's own (oldest-first) order.
 *
 *  Older pages the reader deliberately loaded sit above the newest page and
 *  are simply absent from it -- so they are carried through untouched
 *  rather than being treated as turns the server has forgotten. */
export function mergeNewest(current: ConversationTurn[], incoming: ConversationTurn[]): ConversationTurn[] {
  if (incoming.length === 0) return current;
  const byId = new Map(incoming.map(t => [t.id, t]));
  const merged = current.map(t => byId.get(t.id) ?? t);
  const seen = new Set(current.map(t => t.id));
  for (const t of incoming) if (!seen.has(t.id)) merged.push(t);
  return merged;
}

/** Half-written messages, deliberately OUTSIDE the component.
 *
 *  Outliving the component is the entire purpose, not a side effect. The
 *  box's only offered remedy for a prompt_open refusal is Open Terminal,
 *  and MainPane renders ConversationView as a ternary branch against the
 *  Terminal view -- so taking the UI's own advice unmounts the component
 *  holding what was just typed. Kept in component state alone, answering
 *  the choice and switching back would silently lose the message, which is
 *  a worse outcome than the refusal it was trying to recover from.
 *
 *  Keyed by pid but STAMPED with the session id, and both must match before
 *  a draft is handed back. The pid alone is not an identity: the OS reuses
 *  pid numbers, and an app left running long enough will see a number it
 *  holds a draft for handed to an entirely different process. Restoring on
 *  the number alone would put one session's message in another session's
 *  box, where a single Enter sends it -- the same failure as the shared
 *  tmux buffer, reached by a slower route.
 *
 *  Cleared on a successful send and on nothing else, so a draft still
 *  survives an ordinary session switch. Bounded by the number of distinct
 *  pids typed into in one run of the app, which is small and does not
 *  outlive the window. */
const drafts = new Map<number, { sessionId: string; text: string }>();

/** The draft held for this pid, but only if it was typed in THIS session.
 *
 *  `sessionId` is null whenever the app cannot pin this process to one
 *  transcript -- no session shares its cwd, or several do. There is then no
 *  identity to check a draft against, so no draft is kept: a null would
 *  match the next null at the same pid, which is precisely the case this
 *  exists to prevent. Such sessions simply keep the behaviour they had
 *  before drafts existed, which is a loss of convenience, not a regression,
 *  and far cheaper than delivering a message to the wrong session. */
function draftFor(pid: number | null, sessionId: string | null): string {
  if (pid === null || sessionId === null) return '';
  const held = drafts.get(pid);
  return held?.sessionId === sessionId ? held.text : '';
}

/** Empties the draft store. Exists for test isolation and has no production
 *  caller: because `drafts` is module state rather than component state, it
 *  survives unmount by design, which also means it survives from one test
 *  to the next and would otherwise make tests order-dependent (a test that
 *  types without sending would leave that text in the next test's box). */
export function clearDrafts(): void {
  drafts.clear();
}

/** Mirrors MAX_REPLY_CHARS in src/main/outbound.ts, the actual enforcement
 *  for what a message can send. Redeclared here rather than imported:
 *  src/renderer/** must never import a VALUE out of src/main/** -- doing so
 *  blanks the whole window at runtime with no error any test would catch
 *  (a type-only import would be fine but carries no number to compute
 *  with). This constant only drives what the counter below DISPLAYS;
 *  sanitizeOutbound in outbound.ts remains the sole place the cap is
 *  enforced. tests/renderer/ConversationView.test.tsx pins this equal to
 *  the main process's own constant, so the two cannot drift apart
 *  unnoticed. */
export const MAX_REPLY_CHARS = 4000;

/** What fraction of the cap the counter stays quiet for -- appears once the
 *  length reaches this share of it (90%: 3,600 of the default 4,000). */
const COUNTER_THRESHOLD_FRACTION = 0.9;

/** What the message box's length counter should show, or null to render
 *  nothing (spec: quiet while the message is comfortably short, below 90%
 *  of `max`). Reads as a budget ("400 left"), not a used-count -- a budget
 *  is what a person needs to know at the moment they're approaching a cap.
 *  `warn` turns true from the cap onward (0 left and beyond), which is what
 *  selects the app's existing warning colour (--signal) in
 *  ConversationView.css -- never --critical, which OpenSessionCard.css's
 *  own comment on its unread dot reserves for "waiting on you" alone.
 *
 *  Past the cap this reports how much to CUT ("1,000 over"), never a
 *  clamped "0 left": someone who pasted 5,000 characters needs to know the
 *  size of the problem, not just that there is one. This function only
 *  decides what the counter SAYS; sanitizeOutbound (src/main/outbound.ts)
 *  is unaffected either way and remains what actually refuses a send. */
export function messageCounter(length: number, max: number = MAX_REPLY_CHARS):
  { label: string; warn: boolean } | null {
  if (length < Math.floor(max * COUNTER_THRESHOLD_FRACTION)) return null;
  const remaining = max - length;
  return remaining < 0
    ? { label: `${(-remaining).toLocaleString()} over`, warn: true }
    : { label: `${remaining.toLocaleString()} left`, warn: remaining === 0 };
}

/** The message box under the conversation (spec §3.4). Never hidden, only
 *  ever disabled with a reason: a box that vanishes reads as a missing
 *  feature, a disabled one reads as a state (spec §7.1, David's own
 *  ruling).
 *
 *  Sends through the same session:keys channel the rail's popover uses, so
 *  every guard part 1 established still applies -- including the one that
 *  matters most: this box does not answer choices. A typed reply to a
 *  picker is ignored and Enter selects whatever option is highlighted
 *  (measured 2026-09-15, "blue" recorded as "Red"), so a prompt_open
 *  refusal offers the Terminal view instead of a retry. */
/** Sent as images; any other file goes as a file the agent reads. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Mirrors MAX_ATTACHMENTS in src/main/attachments.ts, which main enforces
 *  at send time (a drift test pins the two together). */
export const MAX_ATTACH = 20;
type AttachKind = 'image' | 'file';
const STAGE_TEXT: Record<StageRefusal, (name: string, kind: AttachKind) => string> = {
  invalid: n => `${n} could not be attached.`,
  failed: n => `${n} could not be attached.`,
  not_image: n => `${n} is not a PNG, JPEG, GIF or WebP image.`,
  // Mirrors MAX_IMAGE_BYTES and MAX_FILE_BYTES in src/main.
  too_large: (n, kind) => `${n} is larger than ${kind === 'image' ? 10 : 25} MB.`,
};

function readFile(file: File, as: 'dataUrl'): Promise<string>;
function readFile(file: File, as: 'bytes'): Promise<ArrayBuffer>;
function readFile(file: File, as: 'dataUrl' | 'bytes'): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    if (as === 'dataUrl') reader.readAsDataURL(file); else reader.readAsArrayBuffer(file);
  });
}

type Attachment = { id: string; name: string; kind: AttachKind; thumb: string | null };

function MessageBox({ pid, sessionId, tmux, provider, waiting, onOpenTerminal, attachRef, onPendingChange, onPendingSent }: {
  pid: number | null;
  /** Which recorded session this pid is, used ONLY to prove a stored draft
   *  belongs to the session now on screen. Null when the app cannot tell,
   *  which means no draft is kept -- see draftFor above. */
  sessionId: string | null;
  tmux: boolean;
  /** Whose prompt to name in the placeholder while `waiting` is true --
   *  Task 11's card names the provider rather than assuming Claude, and
   *  this box's own placeholder must say the same thing. */
  provider: Provider;
  /** True while the open session's agent is showing a choice (WaitingCard
   *  is on screen). Folded into the same disabling this box already had
   *  for "no live process" / "not tmux-backed", rather than a second,
   *  competing disabled state -- the reasoning for why is the same either
   *  way: nothing typed here can reach the agent right now. The typed text
   *  itself is never touched -- only `disabled` and the placeholder change,
   *  so answering in the Terminal and coming back finds it exactly as it
   *  was left. */
  waiting: boolean;
  onOpenTerminal: () => void;
  /** Set while this box can take an image, for the pane's drop handler. */
  attachRef?: MutableRefObject<((files: File[]) => void) | null>;
  /** Notified after every mutation of the pid's pending-message store
   *  (src/renderer/state/pending.ts) this box makes -- a send going up
   *  optimistically, its queued flag settling, or its entry coming back
   *  down on a refusal. That store is a plain module-level Map, not React
   *  state, so ConversationView (the turn list's owner, not this box) has
   *  no other way to learn a mutation happened and re-render the pending
   *  entries it renders below page.turns. */
  onPendingChange: () => void;
  /** Notified ONLY by the optimistic add, never by the other mutations
   *  onPendingChange above also covers -- ConversationView uses this to
   *  scroll to the newest message on the person's own send, and firing it
   *  from markQueued settling, a match dropping the entry, or the idle-tick
   *  interval would scroll the reader away from wherever they had
   *  deliberately scrolled, for no reason connected to anything they did. */
  onPendingSent: () => void;
}) {
  // Seeded from the draft store, so a remount (Open Terminal and back, or a
  // session switch) restores what was typed rather than starting blank.
  // ConversationView keys this component by pid, so the initialiser re-runs
  // for the right session whenever the pid changes.
  const [text, setText] = useState(() => draftFor(pid, sessionId));
  const [message, setMessage] = useState<string | null>(null);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  /** Whether the previous render was mid-send, so the effect below can tell
   *  the send-settled transition from every other reason it runs. */
  const wasSendingRef = useRef(false);

  const counter = messageCounter(text.length);
  /** Strictly past the cap -- not merely at it, which still sends fine.
   *  Drives only the one-time screen-reader announcement below; the
   *  visible counter's warning styling uses counter.warn instead, which
   *  also covers exactly-at-the-cap. */
  const isOverCap = text.length > MAX_REPLY_CHARS;
  const wasOverCapRef = useRef(false);
  const [overAnnouncement, setOverAnnouncement] = useState('');

  /** Announces exactly once, on the transition into being over the cap --
   *  never on every keystroke, which would make the visible counter
   *  unusable with a screen reader, and never merely for reaching the cap
   *  exactly, which still sends fine. The sentence is fixed rather than
   *  carrying the live "over by" count: that count keeps changing as
   *  someone keeps typing, and re-announcing it on every change would be
   *  exactly the noise this exists to avoid. A sighted person still sees
   *  the live number in the ordinary, non-live counter below. Clearing it
   *  once back under the cap lets the same announcement fire again on a
   *  second overshoot. */
  useEffect(() => {
    if (isOverCap && !wasOverCapRef.current) {
      setOverAnnouncement(`Message is over the ${MAX_REPLY_CHARS.toLocaleString()} character limit.`);
    } else if (!isOverCap) {
      setOverAnnouncement('');
    }
    wasOverCapRef.current = isOverCap;
  }, [isOverCap]);

  /** Put the caret back after a send settles. Disabling the textarea while
   *  the send is in flight makes the browser blur it, and re-enabling does
   *  not restore focus -- so without this, a chat box drops the caret on
   *  every message and the person has to click back in before typing the
   *  next one.
   *
   *  An EFFECT, not a call after setSending(false): React batches the state
   *  updates in send()'s continuation, so at that point `disabled` is still
   *  true in the DOM and focus() would be dropped. This runs after the
   *  commit that cleared it.
   *
   *  Guarded on the true -> false transition specifically. Focusing whenever
   *  this effect ran would steal the caret every time a session is opened. */
  useEffect(() => {
    if (wasSendingRef.current && !sending) boxRef.current?.focus();
    wasSendingRef.current = sending;
  }, [sending]);

  const disabledReason = pid === null
    ? 'This session is not running.'
    : !tmux ? REFUSAL_TEXT.not_tmux : null;

  // Folds `waiting` into the one thing every disabled state here already
  // meant: nothing typed can reach the agent right now. disabledReason
  // alone still governs the message shown BELOW the box (the "not running" /
  // "not tmux-backed" line) and the ordinary placeholder fallback -- ranked
  // ahead of `waiting` deliberately, since a session that is not even
  // running is a more fundamental reason than a prompt it cannot possibly
  // be showing.
  const inputDisabled = disabledReason !== null || waiting || sending;
  const placeholder = disabledReason ?? (waiting
    ? `Answer ${PROVIDER_NAME[provider]}'s prompt above to keep typing`
    : 'Message this session');

  // Attachments for the next send. Main holds the bytes (staged by id,
  // src/main/staging.ts); this keeps only the id, a name, the kind and, for
  // an image, a thumbnail.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const canAttach = !inputDisabled;

  async function addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const kind: AttachKind = IMAGE_TYPES.has(file.type) ? 'image' : 'file';
      const name = file.name || (kind === 'image' ? 'Pasted image' : 'Pasted file');
      try {
        const bytes = await readFile(file, 'bytes');
        const r = kind === 'image'
          ? await window.fleet?.stageImage(bytes)
          : await window.fleet?.stageFile(bytes, name);
        if (!r) { setMessage('Could not reach the app.'); continue; }
        if (!r.ok) { setMessage(STAGE_TEXT[r.reason](name, kind)); continue; }
        const thumb = kind === 'image' ? await readFile(file, 'dataUrl') : null;
        let full = false;
        setAttachments(a => {
          if (a.length >= MAX_ATTACH) { full = true; return a; }
          return [...a, { id: r.id, name, kind, thumb }];
        });
        if (full) setMessage(`At most ${MAX_ATTACH} attachments can go in one message.`);
      } catch (err) {
        console.error('Attaching a file failed:', err);
        setMessage(STAGE_TEXT.failed(name, kind));
      }
    }
  }

  // Lets the whole conversation pane accept a dropped file (see the drop
  // handlers on .convwrap), only while this box can send.
  useEffect(() => {
    if (!attachRef) return;
    attachRef.current = canAttach ? files => { void addFiles(files); } : null;
    return () => { attachRef.current = null; };
  });

  async function send(): Promise<void> {
    if (pid === null || (text.trim() === '' && attachments.length === 0) || sending) return;
    setSending(true);
    setMessage(null);
    setChoiceOpen(false);
    // Shown in the conversation the instant Enter is pressed, rather than
    // waiting on the agent's own log to pick it up -- which can lag behind
    // by the fleet sweep's full 5s, longer still if the agent is mid-turn.
    // The draft is dropped here too: it is no longer a draft, it is either
    // in flight to the session or about to be restored below if that fails.
    const key = addPending(pid, { text, attachments, sentAt: Date.now(), queued: false, sessionId });
    setText('');
    setAttachments([]);
    drafts.delete(pid);
    onPendingChange();
    onPendingSent();
    // Puts the box back exactly as it was before the optimistic clear
    // above on a failed send -- the DRAFT store too, not just the visible
    // text, since that clear deleted it as well. Without restoring it
    // here, a prompt_open refusal's own remedy would break it: Open
    // Terminal unmounts this component (MainPane's ternary, see the
    // `drafts` doc comment above), and only the draft store, never
    // component state, survives that.
    const restoreDraft = () => {
      setText(text);
      setAttachments(attachments);
      if (sessionId !== null) drafts.set(pid, { sessionId, text });
    };
    try {
      const attach = {
        images: attachments.filter(a => a.kind === 'image').map(a => a.id),
        files: attachments.filter(a => a.kind === 'file').map(a => a.id),
      };
      const r: KeysResult | undefined = attachments.length
        ? await window.fleet?.sendKeys(pid, text, attach)
        : await window.fleet?.sendKeys(pid, text);
      if (r?.status === 'sent') {
        // The entry itself already went up above, optimistically -- all
        // that is left to settle is its queued label, if any, until the
        // turn-list effect in ConversationView matches it against the log.
        markQueued(pid, key, r.queued);
        onPendingChange();
        return;
      }
      // Nothing reached the session, so the conversation must not keep a
      // message claiming otherwise: the entry comes back down, and the
      // text and its attachments come back exactly as they were typed, for
      // the person to fix (answer the choice, reattach) and press Enter
      // again -- the same restore a refusal has always done here, just
      // undoing the optimistic clear above as well now.
      dropPending(pid, key);
      onPendingChange();
      restoreDraft();
      setMessage(r ? REFUSAL_TEXT[r.reason] : 'Could not reach the app.');
      setChoiceOpen(r?.status === 'refused' && r.reason === 'prompt_open');
    } catch (err) {
      // A rejected sendKeys means the message did NOT go out, and the one
      // thing that must never happen is the conversation looking like it
      // did. Same restore as a returned refusal above, plus the log: never
      // silent, and never a pending entry left claiming a message arrived
      // that in fact never left this box.
      dropPending(pid, key);
      onPendingChange();
      restoreDraft();
      console.error('Conversation message send failed:', err);
      setMessage('Could not reach the app.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="convbox">
      {attachments.length > 0 && (
        <div className="convchips">
          {attachments.map(a => (
            <div className="convchip" key={a.id}>
              {a.thumb
                ? <img src={a.thumb} alt="" />
                : (
                  <svg className="convchip-file" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
                    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" />
                  </svg>
                )}
              <span>{a.name}</span>
              <button type="button" aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments(x => x.filter(y => y.id !== a.id))}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="convrow">
      <button type="button" className="convattach" aria-label="Attach files" title="Attach images or files"
        disabled={!canAttach} onClick={() => fileRef.current?.click()}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1" />
        </svg>
      </button>
      <input ref={fileRef} type="file" multiple hidden
        onChange={e => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void addFiles(files);
        }} />
      <textarea
        ref={boxRef}
        className="convinput"
        aria-label="Message this session"
        rows={2}
        value={text}
        disabled={inputDisabled}
        placeholder={placeholder}
        onChange={e => {
          setText(e.target.value);
          // Stamped with the session id, so this draft can only ever be
          // handed back to the session it was typed in. Not stored at all
          // when that id is unknown -- there would be nothing to check.
          if (pid !== null && sessionId !== null) drafts.set(pid, { sessionId, text: e.target.value });
        }}
        // Enter sends, with no confirmation, however long the message
        // (spec §7.2). Shift+Enter is the line break, which is what makes
        // a multi-line message typeable at all.
        onKeyDown={e => {
          if (e.key !== 'Enter' || e.shiftKey) return;
          e.preventDefault();
          void send();
        }}
        // A file or image on the clipboard attaches rather than pasting
        // nothing; plain text pastes as it always did.
        onPaste={e => {
          const files = [...(e.clipboardData?.files ?? [])];
          if (files.length === 0 || !canAttach) return;
          e.preventDefault();
          void addFiles(files);
        }}
      />
      {/* The composer's own send affordance (Conversation Pane Mockup's
          `.composer .send`), alongside the existing Enter-to-send (spec
          §7.2, unchanged). Disabled by the exact same `inputDisabled` as
          the textarea above -- while the agent is waiting, or this session
          cannot be typed into at all, there is nothing for either path to
          do. */}
      <button type="button" className="convsubmit" disabled={inputDisabled} onClick={() => void send()}>
        Send
      </button>
      </div>
      {counter && (
        <p className={`convcount${counter.warn ? ' convcount-warn' : ''}`}>{counter.label}</p>
      )}
      {/* Always mounted, even empty: a live region a screen reader only
          learns about once it already has content is unreliable across
          screen readers, unlike the counter above (which renders nothing
          at all below the threshold, by design). Visually hidden via
          ConversationView.css's .convannounce, never `display:none`, which
          would also drop it from the accessibility tree. */}
      <p className="convannounce" role="status">{overAnnouncement}</p>
      {disabledReason !== null && <p className="convmsg">{disabledReason}</p>}
      {message !== null && (
        <p className="convmsg" role="status">
          {message}
          {choiceOpen && tmux && (
            <button type="button" className="convsend" onClick={onOpenTerminal}>Open Terminal</button>
          )}
        </p>
      )}
    </div>
  );
}

/** The clean half of the toggle: what was said, not how it was rendered.
 *  This is the only view a non-tmux session can have, and it is still a real
 *  upgrade on the card -- the card shows one line.
 *
 *  sessionId is `string | null`, not `string` -- OpenSession.sessionId
 *  (src/fleet/state.ts) is null whenever the open process's cwd matches no
 *  transcript session, or matches several ambiguously. On a real workspace
 *  with many sessions sharing a directory, ambiguous is the COMMON case, not
 *  an edge case. Rendering the empty-conversation message for that would be
 *  a lie: "no conversation recorded" claims the session said nothing, when
 *  the truth is we don't know which session this process even is. Same "say
 *  nothing rather than guess" rule as OpenSessionCard's lastProse.
 *
 *  `match` (OpenSession.match) says WHY sessionId is null, and the three
 *  cases are genuinely different claims, not one message with a variable
 *  slotted in: 'ambiguous' means several RECORDED sessions share this
 *  process's cwd (contention against history, never "open sessions" --
 *  a user can hit this with exactly one session open); 'unknown' means no
 *  transcript has matched at all, which is also what a session looks like
 *  in the moment right after it launches, before its first events are
 *  written and ingested; and no match info at all (match omitted) falls
 *  back to a neutral message rather than asserting either specific claim. */
export function ConversationView({ sessionId, match, provider, events, pid, tmux, onOpenTerminal }: {
  sessionId: string | null;
  match?: MatchQuality;
  /** Which CLI this session is, so the agent's meta line carries that
   *  provider's own mark. MainPane always knows it (OpenSession.provider
   *  comes straight from the pgrep that found the process). */
  provider: Provider;
  /** The matched session's monotonic event count, straight off the
   *  fleet:update push MainPane already receives. Null when this process
   *  matches no session uniquely -- there is nothing to refresh then. */
  events: number | null;
  /** The live process behind this pane, or null when the selected pid has
   *  left the fleet. Null is what disables the box with "This session is
   *  not running." rather than removing it. */
  pid: number | null;
  /** Whether that process is tmux-backed. Only a tmux-backed session can be
   *  typed into at all (src/main/ipc.ts's sendKeysFor refuses not_tmux). */
  tmux: boolean;
  /** Switches the pane to the Terminal view -- the only way to answer a
   *  choice, which this box deliberately cannot do. */
  onOpenTerminal: () => void;
}) {
  const settings = useSettings();
  // Task 7 (2026-09-17-live-conversation-feedback): main can now push this
  // pid's live state within ~250ms (src/main/sessionLive.ts's
  // watchSessionFor/notifySessionChanged) instead of leaving the pane to
  // the 5s fleet sweep alone. Folded into the refresh effect below as a
  // second source for `events`, not a replacement for the prop -- the push
  // is what gets a reply on screen at watcher speed, and the fleet-sweep
  // prop is still what recovers if the push channel never started (no
  // bridge, or main's fs.watch failed) or a payload was dropped for
  // arriving mid session-switch (see useSessionLive's own doc comment).
  const live = useSessionLive(pid);
  // Task 5 (quick-answers): whether the app's own hooks are installed --
  // read fresh from main (window.fleet.hooksGet), never inferred from
  // `live.prompt` being null, so a hooked-up session that simply has
  // nothing open right now is not told to go turn a switch on that is
  // already on. Only WaitingCard's fallback line needs this (a real
  // PromptCard means hooks are plainly on already), so the fetch is keyed
  // on the exact transition into showing that fallback, not on every
  // activity change -- there is no benefit to re-reading it, say, on every
  // working<->idle flip. null until the first read answers (Task 6):
  // WaitingFallback shows its neutral reading frame while it is unknown,
  // rather than a fallback card that may be wrong. No bridge means off.
  const showsWaitingFallback = live?.activity === 'waiting' && live.prompt === null;
  const [hooksOn, setHooksOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!showsWaitingFallback) return;
    const api = window.fleet;
    if (!api?.hooksGet) { setHooksOn(false); return; }
    let alive = true;
    void api.hooksGet().then(
      r => { if (alive) setHooksOn(r.installed); },
      err => console.error('hooks:get failed:', err),
    );
    return () => { alive = false; };
  }, [showsWaitingFallback]);
  // Forces a re-render so the pending entries rendered below page.turns --
  // a plain module-level store (src/renderer/state/pending.ts), not React
  // state, so a pending send survives a session switch the same way a
  // draft does -- pick up a mutation (a new send, a match against the log,
  // an idle tick) the moment it happens. The value itself is read once,
  // below, by the scroll-on-send effect; every OTHER reader of this state
  // (same pattern as WorkingStrip's own retick) only needs the setter.
  const [pendingVersion, retickPending] = useState(0);
  // Set by MessageBox's onPendingSent, immediately before the retick that
  // follows it, and consumed by the scroll-on-send layout effect below --
  // same one-shot, read-then-clear shape as pendingRestoreRef further down.
  // A ref, not state: it must be read in the same commit that a `pendingVersion`
  // bump renders, with nothing to trigger a render of its own (retickPending
  // already does that).
  const pendingSentRef = useRef(false);
  const [page, setPage] = useState<ConversationPage | null>(null);
  // The message box registers here while it can take an image; the pane's
  // drop handler forwards dropped files to it.
  const attachRef = useRef<((files: File[]) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  /** True once the mount fetch (below) has rejected. This is the one call
   *  site whose failure the reader must be told about: page stays null on
   *  rejection, and the render's page===null branch reads that as still
   *  loading -- a lie once nothing is loading and nothing ever will. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** True once new content has landed at the bottom while the reader was
   *  scrolled away from it -- the Jump to latest button's whole condition
   *  (spec §3.2). Cleared by reaching the bottom, by the button itself, and
   *  by switching session. */
  const [missedLatest, setMissedLatest] = useState(false);
  // A ref, not just the `loadingMore` state, guards the actual fetch:
  // scroll fires far faster than React re-renders commit, so a handler
  // that only checked state could read a stale "not loading" on two scroll
  // events back to back and fire two fetches. A ref is read and written
  // synchronously, with no render in between, so it is the guard that
  // actually holds under a real burst of scroll events, not just in a
  // test that calls the handler once.
  const loadingMoreRef = useRef(false);
  /** The most recently committed sessionId, kept current by the mount
   *  effect below. loadMore's fetch closes over the sessionId it was
   *  issued for; comparing that against this ref at resolve time is what
   *  stops a stale older-page fetch -- for a session the reader has since
   *  left -- from landing on whatever session is open now. Mirrors the
   *  mount effect's own `alive` flag, but as a ref rather than a closure
   *  variable, because loadMore runs outside that effect and needs to
   *  check WHICH session is current, not merely whether one is alive.
   *
   *  KNOWN LIMITATION -- does not hold across a SESSION BOUNCE: s1 -> s2 ->
   *  back to s1 while a loadMore fetch issued for s1 is still in flight
   *  makes this ref read 's1' again by the time that fetch resolves, so the
   *  stale-fetch guard passes and the old page lands anyway. It is worse
   *  than "an old page lands": the layout effect below checks
   *  pendingRestoreRef before landedRef, so this arms a stale restore, and
   *  the returning s1 pane never reaches the bottom and never sets
   *  landedRef. Clearing pendingRestoreRef on session switch (the mount
   *  effect below already does this) does not help, because the bounce
   *  re-arms it afterward. Scheduled for Part 3: a monotonic fetch-epoch
   *  ref, incremented in the mount effect, captured by loadMore's closure
   *  and compared at resolve in place of this session-id comparison. */
  const sessionIdRef = useRef<string | null>(sessionId);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Set by loadMore immediately before a prepend commits, consumed by the
   *  layout effect below. A ref rather than state because it must be read
   *  in the same commit that wrote it, with no render in between. */
  const pendingRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  /** Whether the reader was at the bottom at the last scroll event. Read in
   *  a layout effect, so it must be a ref, not state. */
  const stickyRef = useRef(true);
  /** Has this session's pane been scrolled to the bottom yet. */
  const landedRef = useRef(false);
  /** The last turn's identity AND length, so a reply that grows in place as
   *  it streams counts as new content just as a brand-new turn does. */
  const lastTurnKeyRef = useRef<string | null>(null);
  /** The events count this pane has already fetched for. Starts unset per
   *  session so the very first value is recorded, not acted on: the mount
   *  fetch has already covered it. */
  const seenEventsRef = useRef<number | null>(null);
  /** Turn ids matchPending has already matched to a pending entry, across
   *  every call for this session -- see matchPending's own doc comment
   *  (src/renderer/state/pending.ts) for why this must survive between
   *  separate runs of the effect below rather than being a local inside it.
   *  Reset alongside the other per-session refs on a genuine session switch;
   *  never on a mere page change, or it would defeat its own purpose. */
  const matchedTurnsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    sessionIdRef.current = sessionId;
    if (sessionId === null) return; // nothing to fetch -- see the doc comment above.
    let alive = true;
    setPage(null);
    setLoadFailed(false);
    setMissedLatest(false);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    pendingRestoreRef.current = null;
    stickyRef.current = true;
    landedRef.current = false;
    lastTurnKeyRef.current = null;
    seenEventsRef.current = null;
    matchedTurnsRef.current = new Set();
    void window.fleet?.conversation(sessionId).then(p => {
      if (alive) setPage(p);
    }).catch(err => {
      // Logged unconditionally -- an old fetch failing is real information
      // even once the reader has moved on and it can no longer act on the
      // screen. Only the state change below is scoped to `alive`, so a
      // slow rejection for a session the reader has since left cannot put
      // the NEW session's pane into an error state.
      console.error('Conversation mount fetch failed:', err);
      if (alive) setLoadFailed(true);
    });
    return () => { alive = false; };
  }, [sessionId]);

  /** Live updates (spec §3.3). No conversation TEXT is pushed -- only a
   *  per-session monotonic event count, from two sources now: the `events`
   *  prop (fleet:update's open-session cards, on the 5s sweep) and `live`
   *  (Task 7, above, on main's push). When either moves further than what
   *  this pane has already fetched for, fetch the NEWEST page (no cursor)
   *  and merge; pages the reader loaded above stay put, and so does the
   *  cursor they are paging from, which must not be replaced by the newest
   *  page's own or the next "load older" would walk history the reader
   *  already has. */
  useEffect(() => {
    // Whichever of the two sources has moved further -- see the doc
    // comment on `live` above for why this is a fold, not a substitution.
    // null only when BOTH are null: the fleet sweep never gave this pid a
    // unique match and no live push has arrived either, which is exactly
    // when there is nothing to refresh against.
    const combined = events === null ? live?.events ?? null
      : live === null ? events
        : Math.max(events, live.events);
    if (sessionId === null || combined === null) return;
    if (seenEventsRef.current === null) { seenEventsRef.current = combined; return; }
    if (seenEventsRef.current === combined) return;
    seenEventsRef.current = combined;
    let alive = true;
    void window.fleet?.conversation(sessionId).then(next => {
      if (!alive) return;
      setPage(current => current === null
        ? current
        : { turns: mergeNewest(current.turns, next.turns), nextCursor: current.nextCursor });
    }).catch(err => {
      // A failed background refresh must never destroy content the reader
      // is looking at -- no error UI, no clearing the pane, and no retry
      // timer or seenEventsRef rollback: seenEventsRef was already updated
      // above, before the fetch, so if the session goes idle immediately
      // after this failure the pane stays stale until the next events
      // change. That is accepted, not a bug to engineer around. Logged
      // unconditionally, with no `alive` check: this catch never touches
      // state, so there is nothing here to scope to this effect
      // invocation -- and a refresh failing is real information even for a
      // session the reader has since left, same reasoning as the mount
      // fetch's catch above.
      console.error('Conversation refresh fetch failed:', err);
    });
    return () => { alive = false; };
  }, [sessionId, events, live]);

  // Drops a pending entry the instant the agent's OWN log actually has the
  // message, so the person is never shown their own message twice -- once
  // optimistically, once for real. Runs whenever the turns list changes
  // (mount, a load-more prepend, or either refresh effect above), which is
  // exactly when a newly-landed turn could match one still pending.
  useEffect(() => {
    if (pid === null || page === null) return;
    const matched = matchPending(pendingFor(pid, sessionId), page.turns, matchedTurnsRef.current);
    if (matched.length === 0) return;
    for (const key of matched) dropPending(pid, key);
    retickPending(t => t + 1);
  }, [pid, page]);

  // Counts how long each of this pid's pending entries has gone unmatched,
  // but ONLY while the session is genuinely idle: counting while the agent
  // is working, or while no live push has arrived at all (activity null),
  // would warn about a message that is simply waiting its turn, never one
  // that actually failed to arrive. tickIdle advances EVERY pending entry
  // at this pid, which is deliberate (its own doc comment in pending.ts): a
  // second message stuck behind a first one must warn too.
  //
  // The pendingFor check below is not an optimisation on top of the idle
  // check -- it is load-bearing: retickPending bumps state on every firing,
  // which re-renders the whole pane (nothing here is memoized, and
  // react-markdown re-parses every assistant turn on each render), and an
  // idle session with nothing pending is this component's RESTING state, so
  // without this the pane would pay that cost once a second forever for no
  // reason connected to anything on screen.
  useEffect(() => {
    if (pid === null) return;
    const id = setInterval(() => {
      if (live?.activity !== 'idle' || pendingFor(pid, sessionId).length === 0) return;
      tickIdle(pid, 1000);
      retickPending(t => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [pid, sessionId, live?.activity]);

  /** Scroll bookkeeping for CONTENT changes -- new turns landing, or an
   *  older page prepended -- keyed on `page` alone, in a LAYOUT effect so it
   *  runs before the browser paints: landing at the bottom or restoring a
   *  prepend in a plain effect would show one frame at the wrong offset
   *  first.
   *
   *  jsdom computes no layout, so none of the arithmetic here is asserted
   *  through the DOM -- nearBottom and restoredScrollTop above carry the
   *  tests, and this effect is the (deliberately dull) wiring between them
   *  and a real element.
   *
   *  KNOWN LIMITATION -- this effect does NOT own all scroll bookkeeping:
   *  it fires only on a content change ([page]) and never on a REFLOW.
   *  Changing settings.textSize or settings.messageStyle (read below, where
   *  --conv-size and data-style are set on the scroller) re-flows every
   *  rendered message without re-running this effect at all, so a reader
   *  parked at the newest message can be scrolled off it with no Jump to
   *  latest offered. Adding those settings to THIS effect's dependency
   *  array is a NO-OP, not a fix: the body would still run against the same
   *  `page`, `pending` would still be null, `landedRef.current` is already
   *  true, and lastTurnKey(page.turns) is unchanged, so grewAtBottom is
   *  false and the effect returns having done nothing -- someone will try
   *  exactly that, see no change, and may leave dead dependencies behind.
   *
   *  The real fix is a SEPARATE useLayoutEffect keyed on
   *  [settings.textSize, settings.messageStyle] that sets
   *  el.scrollTop = el.scrollHeight ONLY when stickyRef.current is true --
   *  about five lines. It must be a layout effect so it runs before paint,
   *  and the stickyRef guard is essential: unguarded, it would yank a
   *  reader who had deliberately scrolled up, which is a worse bug than the
   *  one it fixes.
   *
   *  This is deliberately left unfixed pending the user's own eyes-on of
   *  the rendered pane, not overlooked. */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null || page === null) return;

    const pending = pendingRestoreRef.current;
    if (pending !== null) {
      pendingRestoreRef.current = null;
      el.scrollTop = restoredScrollTop(pending.scrollTop, pending.scrollHeight, el.scrollHeight);
      return;
    }

    if (!landedRef.current) {
      landedRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastTurnKeyRef.current = lastTurnKey(page.turns);
      return;
    }

    const key = lastTurnKey(page.turns);
    const grewAtBottom = key !== null && key !== lastTurnKeyRef.current;
    lastTurnKeyRef.current = key;
    if (!grewAtBottom) return;
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
    else setMissedLatest(true);
  }, [page]);

  // A message the person just sent scrolls the pane to its own newest
  // content, the same jump jumpToLatest performs -- but UNCONDITIONALLY,
  // never gated by stickyRef the way an arriving AGENT turn is above (the
  // KNOWN LIMITATION note on that effect is explicit about why that guard
  // exists: yanking a reader who deliberately scrolled up is worse than the
  // bug it would fix). Sending is always a deliberate action by the same
  // person reading the pane, so there is no such reader-scrolled-up case to
  // guard against here -- only the opposite risk, spec 4.1 step 1: showing
  // them their own message with no sign at all that it landed, if they
  // happened to be scrolled up at the moment they pressed Enter.
  //
  // Gated on pendingSentRef, which ONLY the optimistic ADD sets (see
  // MessageBox's onPendingSent below) -- markQueued settling, a match
  // dropping the entry, and the idle-tick interval all also bump
  // pendingVersion (onPendingChange/retickPending, above), and re-scrolling
  // on any of those would yank the reader away from wherever they had
  // deliberately scrolled, for no reason connected to anything they did.
  useLayoutEffect(() => {
    if (!pendingSentRef.current) return;
    pendingSentRef.current = false;
    const el = scrollerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    stickyRef.current = true;
    setMissedLatest(false);
  }, [pendingVersion]);

  const turns = page?.turns ?? [];
  const nextCursor = page?.nextCursor ?? null;

  // Fetches the next OLDER page and PREPENDS it, because chat order puts
  // the oldest loaded turn at the top, so continuing the timeline further
  // back means adding on there. A prepend moves every already-rendered
  // message down by the height it added, which is the classic scroll jump
  // -- pendingRestoreRef records the pre-commit geometry so the layout
  // effect above can cancel it out exactly.
  function loadMore() {
    if (sessionId === null || nextCursor === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void window.fleet?.conversation(sessionId, nextCursor).then(next => {
      // Stale: the reader left this session before the fetch resolved.
      // Without this check, a slow older-page fetch for the OLD session
      // can resolve after the NEW session's own page has already landed
      // and prepend the old session's turns onto it.
      if (sessionIdRef.current !== sessionId) return;
      const el = scrollerRef.current;
      if (el !== null) pendingRestoreRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      setPage(current => current === null
        ? current
        : { turns: [...next.turns, ...current.turns], nextCursor: next.nextCursor });
    }).catch(err => {
      // The pane still holds every turn it had; only the older page is
      // missing. No error UI, no clearing the pane, and no disabling
      // further attempts -- the .finally() below already clears
      // loadingMoreRef, so scrolling near the top again re-fires loadMore
      // and this self-heals on the reader's next scroll. Logged
      // unconditionally, unlike the `.then()` above: this catch never
      // touches state, so the sessionIdRef staleness check that guards the
      // `.then()` does not apply here.
      console.error('Conversation load-more fetch failed:', err);
    }).finally(() => {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    });
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const atBottom = nearBottom(e.currentTarget);
    stickyRef.current = atBottom;
    if (atBottom) setMissedLatest(false);
    if (nearOlderEdge(e.currentTarget)) loadMore();
  }

  function jumpToLatest() {
    const el = scrollerRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    stickyRef.current = true;
    setMissedLatest(false);
  }

  // One shape in every state (spec §7.1's reasoning, applied to the whole
  // pane): the scroller is always there, and what varies is what is inside
  // it. The three "we cannot identify this session" messages, the loading
  // state and the empty state used to be whole-component early returns --
  // which would have meant the message box below vanishing in exactly the
  // states a person most wants to see it.
  function note(text: string) {
    return <p className="convnote">{text}</p>;
  }
  let body: React.ReactNode;
  if (sessionId === null) {
    body = match === 'ambiguous'
      ? note(`This working directory has several recorded sessions, so the app can't tell which transcript belongs to this process.`)
      : match === 'unknown'
        ? note(`No transcript has been found for this process yet -- which is also what a session looks like right after it launches, before its first events are written and ingested.`)
        : note(`This process's transcript can't be identified.`);
  } else if (loadFailed) {
    body = note(`This session's conversation could not be loaded. Reopening the session will try again.`);
  } else if (page === null) {
    body = note('Loading…');
  } else if (page.turns.length === 0 && (pid === null || pendingFor(pid, sessionId).length === 0)) {
    // The one exception to "empty means say so": a message just sent, still
    // waiting on the agent's log to catch up, is not nothing -- "no
    // conversation recorded" would be sitting right above the very message
    // that contradicts it. A pending entry, when there is one, earns the
    // convstack branch below instead of this note.
    body = note('No conversation recorded for this session.');
  }

  let prevDate = '';
  return (
    <div className="convwrap"
      // Drop an image or file anywhere on the conversation to attach it, as in the
      // mockup. Only while the message box can send (attachRef is set);
      // anything else is left alone -- main blocks navigation regardless.
      onDragOver={e => {
        if (!e.dataTransfer?.types?.includes('Files') || !attachRef.current) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={e => {
        setDragging(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length === 0 || !attachRef.current) return;
        e.preventDefault();
        attachRef.current(files);
      }}
    >
      {dragging && (
        <div className="convdrop">
          <p>Drop to attach<small>Images are attached; other files are given to the session by path</small></p>
        </div>
      )}
      <div
        className="conv"
        // The one size the pane is built from (spec §3.5): every
        // message-level rule in ConversationView.css is expressed relative
        // to it, so meta lines and code blocks move with the body text
        // rather than staying behind at a fixed px.
        style={{ ['--conv-size' as string]: `${settings.textSize}px` } as React.CSSProperties}
        data-style={settings.messageStyle}
        ref={scrollerRef}
        onScroll={handleScroll}
      >
        {body ?? (
          // Chat order puts the oldest loaded turn at the top, so both
          // history markers sit ABOVE turns.map: the older page a
          // loading-more spinner announces prepends at the top, and the
          // end-of-history line describes the top edge of what's loaded.
          // Only this stack -- not the notes branch above -- gets
          // margin-top:auto (ConversationView.css), which is what pins a
          // conversation shorter than the pane to the bottom.
          <div className="convstack">
            <SessionIdContext.Provider value={sessionId}>
            {loadingMore && <p className="conv-loading-more">Loading more…</p>}
            {!loadingMore && nextCursor === null && turns.length > 0 && (
              // A genuine end-of-history fact, not an apology -- unlike the
              // old truncation notice this replaces, nothing here is hidden;
              // older turns just have not been fetched yet, and now there
              // are none left.
              <p className="conv-end">Beginning of this session's recorded conversation.</p>
            )}
            {turns.map(t => {
              const date = formatDate(t.ts);
              const showDate = date !== prevDate;
              prevDate = date;
              return (
                <Fragment key={t.id}>
                {showDate && (
                  // The day, on its own rule above that day's first turn
                  // (Conversation Pane Mockup), so each turn's meta line
                  // carries only the time.
                  <div className="conv-day" role="separator" aria-label={date}>{date}</div>
                )}
                <article className={`turn ${t.role}`}>
                  <div className="meta">
                    {t.role === 'user'
                      ? <span className="who">you</span>
                      : (
                        <span className="who">
                          <ProviderMark provider={provider} size={13} />
                          <span className="wholabel">{PROVIDER_NAME[provider]}</span>
                        </span>
                      )}
                    <span className="when">{formatTime(t.ts)}</span>
                  </div>
                  {t.role === 'user'
                    ? <UserText id={t.id} text={t.text} />
                    : (
                      <div className="turn-body">
                        {/* A reply Claude Code saved only as a thinking
                            summary (parse.ts's note-flagged prose event)
                            renders through the exact same markdown path as
                            any other reply, at the same spot in the
                            timeline -- only .note (ConversationView.css)
                            sets it apart, muted and italic. */}
                        <div className={`turn-text md${t.note ? ' note' : ''}`}><MarkdownText text={t.text} /></div>
                      </div>
                    )}
                  {t.role !== 'user' && (
                    <div className="turn-actions"><CopyButton what="reply" getText={() => t.text} /></div>
                  )}
                </article>
                </Fragment>
              );
            })}
            {/* Pending sends (Task 9), after every loaded turn -- they are
                always the newest thing in the pane. Reuses the same
                article/meta/turn-text markup as a landed user turn, so a
                pending message looks identical to one that has already
                arrived, per the mockup David chose over a "Sending..."
                label. Gone the instant the matchPending effect above finds
                it in the log; until then it carries at most one label:
                Queued while Codex is busy, or -- once genuinely idle for
                NOT_SEEN_AFTER_MS -- a warning with the one real remedy this
                box has, the Terminal. Claude's queued flag is simply false
                whenever its status file cannot be read, so no Queued label
                is an intentional, honest silence, not a missing state. */}
            {pid !== null && pendingFor(pid, sessionId).map(p => {
              const warn = p.idleMs >= NOT_SEEN_AFTER_MS;
              return (
                <article className="turn user pending" key={p.key}>
                  <div className="meta">
                    <span className="who">you</span>
                    <span className="when">{formatTime(new Date(p.sentAt).toISOString())}</span>
                  </div>
                  {p.text && <p className="turn-text">{p.text}</p>}
                  {p.attachments.length > 0 && (
                    // A separate class from the composer's own .convchip
                    // (ConversationView.css) on purpose: this chip is not
                    // editable (no remove button), and reusing .convchip
                    // would make a pending entry's chip count toward the
                    // composer's own chip count in anything that queries
                    // for it, which is exactly the mix-up this avoids.
                    <div className="turn-chips">
                      {p.attachments.map(a => (
                        <div className="turn-chip" key={a.id}>
                          {a.thumb
                            ? <img src={a.thumb} alt="" />
                            : (
                              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
                                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" />
                              </svg>
                            )}
                          <span>{a.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {warn ? (
                    <div className="turn-state warn">
                      <span>Not seen by {PROVIDER_NAME[provider]}</span>
                      <button type="button" className="convsend" onClick={onOpenTerminal}>Open Terminal</button>
                    </div>
                  ) : p.queued && <div className="turn-state">Queued</div>}
                </article>
              );
            })}
            </SessionIdContext.Provider>
          </div>
        )}
      </div>
      {missedLatest && (
        <button type="button" className="convjump" onClick={jumpToLatest}>Jump to latest</button>
      )}
      {/* Between the scroller and the composer, never both at once: `live`
          reports one `activity` at a time. The strip moved here from Task
          10, which built the component and its own tests standalone --
          this is its one render site, and ConversationView.tsx is the only
          file Task 11 has open, which is why the two tasks stayed
          sequential. `pid !== null` is checked on top of the activity
          check, not folded into `live` itself: `live` already goes null
          whenever `pid` does (useSessionLive's own doc comment), but this
          keeps the strip from ever depending on that happening to be true. */}
      {live?.activity === 'working' && pid !== null && (
        <WorkingStrip provider={provider} since={live.since} />
      )}
      {/* Task 5: PromptCard whenever main found an open prompt to show,
          keyed by the prompt's own id so a new prompt (a different id)
          mounts a fresh card -- resetting every local answer/text-box
          state rather than carrying stale picks over, and giving the
          "didn't take the answer" 3s check (PromptCard.tsx) a component
          instance whose lifetime IS exactly this one prompt's.
          WaitingFallback (a 2 s reading frame, then WaitingCard) covers
          everything else; it mounts per waiting-without-prompt stretch,
          which starts its timer, and is keyed by pid so a session switch
          restarts it. `pid !== null` mirrors
          WorkingStrip's own guard just above -- `live` is only ever
          non-null for a pid useSessionLive was actually asked to watch. */}
      {live?.activity === 'waiting' && pid !== null && (
        live.prompt
          ? <PromptCard key={live.prompt.id} pid={pid} prompt={live.prompt} onOpenTerminal={onOpenTerminal} />
          : <WaitingFallback key={`waiting-${pid}`} provider={provider} hooksOn={hooksOn} onOpenTerminal={onOpenTerminal} />
      )}
      {/* Keyed by pid so switching session remounts the box: its draft,
          any standing refusal and the choice prompt all belong to the
          session that produced them, and none should carry over to the
          next one. */}
      <MessageBox key={pid ?? 'none'} pid={pid} sessionId={sessionId} tmux={tmux} provider={provider}
        waiting={live?.activity === 'waiting'}
        onOpenTerminal={onOpenTerminal} attachRef={attachRef}
        onPendingChange={() => retickPending(t => t + 1)}
        onPendingSent={() => { pendingSentRef.current = true; }} />
    </div>
  );
}
