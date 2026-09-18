import { basename } from 'node:path';
import type { SignalEvent } from '../store/signals.ts';
import type {
  Answer, PromptChoice, PromptKind, PromptQuestion, PromptView, ScreenExpect, ScreenRead,
} from '../core/prompt.ts';
import { readPromptScreen } from './promptScreen.ts';
import {
  capturePane, sendKeyName, sendLiteral, paneInMode, cancelCopyMode,
  type KeyName, type TmuxExec, type TmuxResult,
} from './tmux.ts';
import { tmuxNameForPid, resolveLiveTmux } from './sessions.ts';

/** Quick answers, main side. Spec: docs/superpowers/specs/
 *  2026-09-17-quick-answers-design.md sections 5-7 and 11.
 *
 *  buildPromptView turns the open prompt's PermissionRequest hook event
 *  into the card the renderer draws. answerPrompt (session:answer) answers
 *  it with tmux keystrokes.
 *
 *  The renderer is untrusted. It names a pid, a prompt id and a structured
 *  answer, nothing else: main re-derives the open prompt itself, checks
 *  the answer against it, and presses no key until the pane shows that
 *  prompt. Every later step re-reads the pane before its next key, and
 *  every Enter after typed text first confirms the text sits in the
 *  prompt's own text row. */

export type AnswerRefusal =
  | 'invalid_pid' | 'not_tmux' | 'session_gone' | 'stale' | 'invalid' | 'busy'
  | 'unconfirmed' | 'unconfirmed_partial';
export type AnswerResult = { status: 'sent' } | { status: 'refused'; reason: AnswerRefusal };

/** Injected in tests; production passes only `currentPrompt` (registerIpc,
 *  src/main/ipc.ts) and takes the real tmux and timer for the rest. Mirrors
 *  KeysDeps (ipc.ts), except `sleep` is async: a multi-question answer
 *  settles many times, and a blocking wait would freeze the main process
 *  (IPC and pushes) for all of it. */
export type AnswerDeps = {
  /** Every outbound tmux call: keys, typed text, leaving copy-mode. */
  send?: TmuxExec;
  /** Every read: capture-pane and the copy-mode query. */
  capture?: (args: string[]) => TmuxResult;
  sleep?: (ms: number) => Promise<void>;
  /** The open prompt main derives right now (section 5), or null. The
   *  default answers null, which refuses everything as stale. */
  currentPrompt?: (pid: number) => PromptView | null;
  has?: (name: string) => boolean;
};

const PROMPT_CACHE_MAX = 50;
const MAX_TEXT = 2000;
const SETTLE_POLL_MS = 50;
const SETTLE_TIMEOUT_MS = 1500;
const DIGITS: readonly string[] = ['1', '2', '3', '4', '5', '6'];
/** C0, DEL, C1, and the two Unicode line separators. A newline sent by
 *  send-keys would submit early; ESC could start a terminal sequence. */
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

// ---- the prompt view ------------------------------------------------------

/** Screen choices by prompt id (the PermissionRequest's event_id). Only a
 *  SUCCESSFUL read is kept: a failed one is tried again on the next push,
 *  so a briefly unreadable dialog does not stay read-only for its whole
 *  life. Insertion-ordered, so the oldest entry is the first key. */
const choiceCache = new Map<string, PromptChoice[]>();

/** Test hook, same role as clearRegistry (src/main/sessions.ts). */
export function clearPromptCache(): void {
  choiceCache.clear();
}

function rememberChoices(id: string, choices: PromptChoice[]): void {
  choiceCache.delete(id);
  choiceCache.set(id, choices);
  while (choiceCache.size > PROMPT_CACHE_MAX) {
    const oldest = choiceCache.keys().next().value;
    if (oldest === undefined) break;
    choiceCache.delete(oldest);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function kindFor(toolName: string): PromptKind {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'permission';
}

/** Strings only, and only the known fields. Indexes are kept aligned with
 *  the payload (a malformed entry becomes empty text, never a dropped row),
 *  because an option's index is the digit pressed for it. */
function readQuestions(raw: unknown): PromptQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const o = record(q) ?? {};
    const options = Array.isArray(o.options)
      ? o.options.map((opt) => {
        const p = record(opt) ?? {};
        return { label: str(p.label) ?? '', description: str(p.description) ?? '' };
      })
      : [];
    return { question: str(o.question) ?? '', header: str(o.header) ?? '', multiSelect: o.multiSelect === true, options };
  });
}

/** What readPromptScreen must find for this prompt. Permission is anchored
 *  on the Bash command, else the file's basename, else the tool name
 *  (section 8). An empty anchor would match any line, so it gives null:
 *  such a prompt is never read, and never answerable. */
function screenExpect(view: PromptView): ScreenExpect | null {
  if (view.kind === 'question') {
    const qs = view.questions ?? [];
    return { kind: 'question', headers: qs.map(q => q.header), questions: qs.map(q => q.question) };
  }
  if (view.kind === 'plan') return { kind: 'plan' };
  const anchor = view.command || (view.filePath ? basename(view.filePath) : '') || view.toolName || '';
  return anchor ? { kind: 'permission', toolName: view.toolName ?? '', anchor } : null;
}

/** One capture, no retry: this runs inside a push. */
function readChoices(name: string, view: PromptView, capture: AnswerDeps['capture']): PromptChoice[] | null {
  const expect = screenExpect(view);
  if (!expect) return null;
  const cap = capturePane(name, null, capture);
  if (!cap.ok) return null;
  const read = readPromptScreen(cap.stdout, expect);
  if (!read.match || read.kind !== view.kind || !('choices' in read) || read.choices.length === 0) return null;
  return read.choices;
}

/** The card for one PermissionRequest event (section 6). Content always
 *  comes from the hook payload; permission and plan choices come from the
 *  screen, because the hook does not carry them. `tmuxName` is null for a
 *  session the app did not launch, which is shown read-only. */
export function buildPromptView(event: SignalEvent, tmuxName: string | null, deps: AnswerDeps = {}): PromptView {
  // Typed as an object, but it is a parsed hook file: never trusted to be one.
  const p = record(event.payload) ?? {};
  const toolName = str(p.tool_name) ?? '';
  const input = record(p.tool_input) ?? {};
  const view: PromptView = { id: event.eventId, kind: kindFor(toolName), answerable: false, reason: null };

  if (view.kind === 'question') {
    view.questions = readQuestions(input.questions);
  } else if (view.kind === 'plan') {
    const plan = str(input.plan);
    if (plan !== undefined) view.plan = plan;
  } else {
    view.toolName = toolName;
    const command = str(input.command);
    const description = str(input.description);
    const filePath = str(input.file_path);
    if (command !== undefined) view.command = command;
    if (description !== undefined) view.description = description;
    if (filePath !== undefined) view.filePath = filePath;
  }

  if (tmuxName === null) return { ...view, reason: 'not_tmux' };
  // Question choices are the hook's own options; no screen read needed.
  if (view.kind === 'question') return { ...view, answerable: true };

  const cached = choiceCache.get(view.id);
  if (cached) return { ...view, answerable: true, choices: cached.map(c => ({ ...c })) };
  const choices = readChoices(tmuxName, view, deps.capture);
  if (!choices) return { ...view, reason: 'screen_unread' };
  rememberChoices(view.id, choices);
  return { ...view, answerable: true, choices: choices.map(c => ({ ...c })) };
}

// ---- validating the answer ------------------------------------------------

/** 1-2000 characters, one line, no control characters. Trimmed, so
 *  whitespace alone counts as empty -- and so the row compare below is not
 *  thrown by spaces the screen reader trims anyway. */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_TEXT || CONTROL.test(raw)) return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

/** The digit for option index `i` (0-based), if it is one we may press. */
function digitFor(i: number): KeyName | null {
  const key = String(i + 1);
  return DIGITS.includes(key) ? key as KeyName : null;
}

/** Section 7.2 guard 3: whether `raw` (untrusted, from the renderer) fits
 *  this prompt. Returns a clean copy built only from checked fields, or
 *  null. */
export function validateAnswer(view: PromptView, raw: unknown): Answer | null {
  const a = record(raw);
  if (!a) return null;

  if (a.kind === 'choice' || a.kind === 'choice_text') {
    if (view.kind === 'question' || typeof a.key !== 'string') return null;
    const choice = view.choices?.find(c => c.key === a.key);
    if (!choice || !DIGITS.includes(choice.key)) return null;
    if (a.kind === 'choice') {
      // A plain No (permission option 3, a takesText row) is its digit,
      // which rejects directly (measured, fixture 56). Plan option 3 is
      // only ever feedback, so it needs text.
      return choice.takesText && view.kind !== 'permission' ? null : { kind: 'choice', key: choice.key };
    }
    if (!choice.takesText) return null;
    const text = cleanText(a.text);
    return text === null ? null : { kind: 'choice_text', key: choice.key, text };
  }

  if (a.kind === 'questions') {
    const qs = view.questions ?? [];
    if (view.kind !== 'question' || qs.length === 0) return null;
    if (!Array.isArray(a.picks) || a.picks.length !== qs.length) return null;
    const picks: { options: number[]; other?: string }[] = [];
    for (const [i, q] of qs.entries()) {
      const pick = record(a.picks[i]);
      if (!pick || !Array.isArray(pick.options)) return null;
      const options: unknown[] = pick.options;
      if (!options.every(o => Number.isInteger(o) && (o as number) >= 0 && (o as number) < q.options.length)) return null;
      const indexes = options as number[];
      if (new Set(indexes).size !== indexes.length) return null;
      if (!indexes.every(o => digitFor(o) !== null)) return null;
      let other: string | undefined;
      if (pick.other !== undefined) {
        const text = cleanText(pick.other);
        if (text === null) return null;
        other = text;
      }
      if (q.multiSelect) {
        // The multi-select free-text key sequence was never measured
        // (controller ruling, Task 3): refused here, before any key.
        if (other !== undefined || indexes.length === 0) return null;
        picks.push({ options: [...indexes] });
      } else {
        if (indexes.length + (other === undefined ? 0 : 1) !== 1) return null;
        if (other !== undefined && digitFor(q.options.length) === null) return null;
        picks.push(other === undefined ? { options: [...indexes] } : { options: [], other });
      }
    }
    return { kind: 'questions', picks };
  }

  if (a.kind === 'chat') return view.kind === 'question' ? { kind: 'chat' } : null;
  return null;
}

// ---- answering ------------------------------------------------------------

/** One answer in flight per pid (section 7.2 guard 4). */
const inFlight = new Set<number>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Refusals are logged with the reason and prompt id only -- never the
 *  answer text or the prompt's content (section 11). The prompt id is
 *  renderer input, so an odd one is logged as a placeholder. */
function refuse(pid: unknown, promptId: unknown, reason: AnswerRefusal): AnswerResult {
  console.error('session:answer refused', {
    pid: typeof pid === 'number' && Number.isFinite(pid) ? pid : null,
    promptId: typeof promptId === 'string' && promptId.length <= 64 ? promptId : '[invalid]',
    reason,
  });
  return { status: 'refused', reason };
}

/** Section 7. Never throws: every outcome is a result, and a refusal
 *  presses nothing unless it is `unconfirmed_partial`. */
export async function answerPrompt(
  pid: unknown, promptId: unknown, answer: unknown, deps: AnswerDeps = {},
): Promise<AnswerResult> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return refuse(pid, promptId, 'invalid_pid');

  // Same not_tmux/session_gone split as sendKeysFor (ipc.ts).
  if (tmuxNameForPid(pid) === null) return refuse(pid, promptId, 'not_tmux');
  const name = resolveLiveTmux(pid, { has: deps.has });
  if (name === null) return refuse(pid, promptId, 'session_gone');

  let view: PromptView | null;
  try {
    view = (deps.currentPrompt ?? (() => null))(pid);
  } catch (err) {
    console.error('session:answer could not derive the open prompt:', err instanceof Error ? err.message : 'unknown error');
    return refuse(pid, promptId, 'stale');
  }
  if (!view || typeof promptId !== 'string' || view.id !== promptId) return refuse(pid, promptId, 'stale');
  if (!view.answerable) return refuse(pid, promptId, view.reason === 'not_tmux' ? 'not_tmux' : 'unconfirmed');

  const clean = validateAnswer(view, answer);
  if (!clean) return refuse(pid, promptId, 'invalid');

  if (inFlight.has(pid)) return refuse(pid, promptId, 'busy');
  const run = new Run(name, view, deps);
  try {
    // Taken inside the try, so the finally below always releases it.
    inFlight.add(pid);
    const reason = await run.deliver(clean);
    return reason === null ? { status: 'sent' } : refuse(pid, promptId, reason);
  } catch (err) {
    // Only this module's own guards throw (a name or key outside the
    // allowlist), with fixed messages -- never tmux output, which can echo
    // the typed text back.
    console.error('session:answer failed:', err instanceof Error ? err.message : 'unknown error');
    return refuse(pid, promptId, run.pressed ? 'unconfirmed_partial' : 'unconfirmed');
  } finally {
    inFlight.delete(pid);
  }
}

type Shot = { raw: string; read: ScreenRead };
type QuestionRead = Extract<ScreenRead, { kind: 'question' }>;
type DialogRead = Extract<ScreenRead, { kind: 'permission' | 'plan' }>;
type ReviewRead = Extract<ScreenRead, { kind: 'review' }>;

/** Collapses whitespace runs and trims: the screen reader trims rows and
 *  joins wrapped lines with one space, so text is compared the same way. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A revisited single-select option keeps a trailing " ✔" on screen
 *  (fixture 16-ask-left-back); it is not part of the label. */
function sameOptions(screen: string[], q: PromptQuestion): boolean {
  return screen.length === q.options.length
    && screen.every((label, i) => label.replace(/\s*✔$/, '') === q.options[i]!.label);
}

function sameChoices(a: PromptChoice[], b: PromptChoice[]): boolean {
  return a.length === b.length
    && a.every((c, i) => c.key === b[i]!.key && c.label === b[i]!.label && c.takesText === b[i]!.takesText);
}

function isQuestion(s: Shot): s is { raw: string; read: QuestionRead } {
  return s.read.match && s.read.kind === 'question';
}

function isReview(s: Shot): s is { raw: string; read: ReviewRead } {
  return s.read.match && s.read.kind === 'review';
}

/** The question dialog has left the screen (no tab row at all). */
function isGone(s: Shot): boolean {
  return !s.read.match && s.read.why === 'no_tab_row_on_screen';
}

/** One answer's delivery. `pressed` records whether any key has reached
 *  Claude, which decides unconfirmed vs unconfirmed_partial. */
class Run {
  pressed = false;
  private readonly name: string;
  private readonly view: PromptView;
  private readonly deps: AnswerDeps;
  private readonly expect: ScreenExpect | null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(name: string, view: PromptView, deps: AnswerDeps) {
    this.name = name;
    this.view = view;
    this.deps = deps;
    this.expect = screenExpect(view);
    this.sleep = deps.sleep ?? defaultSleep;
  }

  private fail(): AnswerRefusal {
    return this.pressed ? 'unconfirmed_partial' : 'unconfirmed';
  }

  private look(): Shot | null {
    if (!this.expect) return null;
    const cap = capturePane(this.name, null, this.deps.capture);
    if (!cap.ok) return null;
    return { raw: cap.stdout, read: readPromptScreen(cap.stdout, this.expect) };
  }

  /** Polls every 50 ms, up to 1.5 s, until `ok` holds. A failed capture
   *  ends it at once: a pane that cannot be read cannot be confirmed. */
  private async settle(ok: (s: Shot) => boolean): Promise<Shot | null> {
    for (let waited = 0; ; waited += SETTLE_POLL_MS) {
      const shot = this.look();
      if (!shot) return null;
      if (ok(shot)) return shot;
      if (waited >= SETTLE_TIMEOUT_MS) return null;
      await this.sleep(SETTLE_POLL_MS);
    }
  }

  private press(key: KeyName): boolean {
    const r = sendKeyName(this.name, key, this.deps.send);
    // A failed send may still have reached the pane; count it as pressed.
    this.pressed = true;
    if (!r.ok) console.error('session:answer key send failed:', { key });
    return r.ok;
  }

  /** Typed text, single line, through send-keys -l only. The tmux error is
   *  not logged: it can carry the argv, which holds the text. */
  private type(text: string): boolean {
    const r = sendLiteral(this.name, text, this.deps.send);
    this.pressed = true;
    if (!r.ok) console.error('session:answer text send failed');
    return r.ok;
  }

  /** Section 7.2 guard 5, the same way sendKeysFor does it: a pane in
   *  copy-mode routes send-keys to copy-mode's key table instead of Claude. */
  private leaveCopyMode(): boolean {
    const mode = paneInMode(this.name, this.deps.capture);
    if (!mode.ok || mode.stdout.trim() !== '1') return true;
    const left = cancelCopyMode(this.name, this.deps.send);
    if (!left.ok) console.error('session:answer could not leave copy-mode');
    return left.ok;
  }

  async deliver(answer: Answer): Promise<AnswerRefusal | null> {
    if (!this.leaveCopyMode()) return 'session_gone';
    // Guard 6: no key until the pane shows this prompt.
    const first = this.look();
    if (!first) return 'unconfirmed';
    if (answer.kind === 'choice' || answer.kind === 'choice_text') return this.dialog(first, answer);
    if (answer.kind === 'chat') return this.chat(first);
    return this.questions(first, answer.picks);
  }

  private isDialog(s: Shot): s is { raw: string; read: DialogRead } {
    return s.read.match && s.read.kind === this.view.kind;
  }

  private async dialog(
    first: Shot, answer: Extract<Answer, { kind: 'choice' | 'choice_text' }>,
  ): Promise<AnswerRefusal | null> {
    if (!this.isDialog(first) || !sameChoices(first.read.choices, this.view.choices ?? [])) return 'unconfirmed';
    const key = answer.key as KeyName;
    if (answer.kind === 'choice') return this.press(key) ? null : this.fail();

    const text = answer.text;
    const onRow = (s: Shot, row: string) =>
      this.isDialog(s) && s.read.cursor === key && s.read.textRow !== null && norm(s.read.textRow) === norm(row);

    if (this.view.kind === 'plan') {
      // Plan option 3: the digit focuses the text row.
      if (!this.press(key)) return this.fail();
      if (!await this.settle(s => onRow(s, ''))) return this.fail();
    } else {
      // Permission No + text: the digit would answer No at once, so move
      // the cursor with Down, verified on screen each time, then Tab.
      let cur: Shot = first;
      for (let downs = 0; (cur.read as DialogRead).cursor !== key; downs++) {
        if (downs >= (this.view.choices ?? []).length) return this.fail();
        const before = (cur.read as DialogRead).cursor;
        if (!this.press('Down')) return this.fail();
        const next = await this.settle(s => this.isDialog(s) && s.read.cursor !== before);
        if (!next) return this.fail();
        cur = next;
      }
      if (!this.press('Tab')) return this.fail();
      if (!await this.settle(s => onRow(s, ''))) return this.fail();
    }

    if (!this.type(text)) return this.fail();
    // The permission row reads "No, <text>"; the plan row is the text.
    const row = this.view.kind === 'permission' ? `No, ${text}` : text;
    if (!await this.settle(s => onRow(s, row))) return this.fail();
    return this.press('Enter') ? null : this.fail();
  }

  private chat(first: Shot): AnswerRefusal | null {
    const qs = this.view.questions ?? [];
    if (!isQuestion(first)) return 'unconfirmed';
    const q = qs[first.read.current];
    if (!q || !sameOptions(first.read.options, q)) return 'unconfirmed';
    // "Chat about this" is digit n+2 of the current question.
    const key = digitFor(q.options.length + 1);
    if (!key) return 'unconfirmed';
    return this.press(key) ? null : this.fail();
  }

  private async questions(
    first: Shot, picks: { options: number[]; other?: string }[],
  ): Promise<AnswerRefusal | null> {
    const qs = this.view.questions ?? [];
    // Start only from a fresh dialog: first question current, none answered.
    if (!isQuestion(first) || first.read.current !== 0 || first.read.answered.some(Boolean)) return 'unconfirmed';

    let cur: Shot = first;
    for (const [i, q] of qs.entries()) {
      const pick = picks[i]!;
      const last = i === qs.length - 1;
      if (!isQuestion(cur) || cur.read.current !== i || !sameOptions(cur.read.options, q)) return this.fail();
      const onThis = (s: Shot) => isQuestion(s) && s.read.current === i;

      let next: Shot | null;
      if (!q.multiSelect) {
        if (pick.other === undefined) {
          // A digit picks and advances.
          if (!this.press(digitFor(pick.options[0]!)!)) return this.fail();
        } else {
          // Free text: digit n+1 only focuses the row; type; Enter once
          // the row shows exactly the text.
          const before = cur.raw;
          if (!this.press(digitFor(q.options.length)!)) return this.fail();
          if (!await this.settle(s => onThis(s) && s.raw !== before)) return this.fail();
          if (!this.type(pick.other)) return this.fail();
          const text = pick.other;
          const typed = await this.settle(s => onThis(s)
            && (s.read as QuestionRead).options.length === q.options.length + 1
            && norm((s.read as QuestionRead).options[q.options.length]!) === norm(text));
          if (!typed) return this.fail();
          if (!this.press('Enter')) return this.fail();
        }
        // A one-question prompt may close without a review screen. Only
        // there, and only when two reads in a row find the dialog gone, is
        // that taken as answered: one odd capture is not an answer.
        let goneReads = 0;
        next = await this.settle((s) => {
          goneReads = isGone(s) ? goneReads + 1 : 0;
          return this.advanced(s, i, last) || (qs.length === 1 && goneReads >= 2);
        });
      } else {
        // Each digit toggles and the cursor stays; Right advances.
        for (const option of pick.options) {
          const before = cur.raw;
          if (!this.press(digitFor(option)!)) return this.fail();
          const toggled = await this.settle(s => onThis(s) && s.raw !== before);
          if (!toggled) return this.fail();
          cur = toggled;
        }
        if (!this.press('Right')) return this.fail();
        next = await this.settle(s => this.advanced(s, i, last));
      }
      if (!next) return this.fail();
      cur = next;
    }

    // Reachable only through the one-question rule above: the dialog
    // closed on the pick itself.
    if (isGone(cur)) return null;
    // Only a review that matches the card, line for line, is submitted.
    if (!isReview(cur) || !this.reviewMatches(cur.read, picks)) return this.fail();
    return this.press('1') ? null : this.fail();
  }

  /** Question i is done: the next one is current and the tab row shows i
   *  answered -- or, after the last, the review. */
  private advanced(s: Shot, i: number, last: boolean): boolean {
    if (!last) return isQuestion(s) && s.read.current === i + 1 && s.read.answered[i] === true;
    return isReview(s);
  }

  /** Every question paired with the answer the card sent: the label, the
   *  typed text, or the picked labels in the order they were toggled,
   *  joined with ", " (fixture 19: Fish then Cat reads "Fish, Cat"). */
  private reviewMatches(review: ReviewRead, picks: { options: number[]; other?: string }[]): boolean {
    const qs = this.view.questions ?? [];
    if (review.answers.length !== qs.length) return false;
    return qs.every((q, i) => {
      const pick = picks[i]!;
      const expected = pick.other ?? pick.options.map(o => q.options[o]!.label).join(', ');
      const got = review.answers[i]!;
      return got.question === q.question && norm(got.answer) === norm(expected);
    });
  }
}
