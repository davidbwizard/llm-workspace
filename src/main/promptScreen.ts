import type { PromptChoice, ScreenExpect, ScreenRead } from '../core/prompt.ts';

/** Pure screen reader for Quick answers. Spec: docs/superpowers/specs/
 *  2026-09-17-quick-answers-design.md section 8.
 *
 *  Takes the pane text from `capturePane` and an expectation built from the
 *  hook payload, and says whether the screen currently shows that exact
 *  prompt -- never presses a key on a guess. No regex here ever takes user
 *  text (the anchor) as a pattern; anchor checks use `includes`. */

const RULE_LINE = /^─+$/;
const OPTION_LINE = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/;
const TAB_ROW = /^←.*→$/;
const HEADER_LINE = /^[☐☒]\s+\S/;
const HINT_LINE = 'shift+tab to approve with this feedback';
/** Multi-select's own "Submit" row, drawn directly under the last checkbox
 *  once every option has been enumerated (fixtures 34, 35, 36, 37) -- and
 *  sometimes the cursor's own row (38: "❯    Submit"). It carries no
 *  leading digit, so it never matches OPTION_LINE, but it is a control of
 *  its own, not a continuation of the row above it, and must stop a typed
 *  answer's continuation join before it is swallowed into the label. */
const SUBMIT_ROW = /^Submit$/;
const WRAPPED_IN_WORD = /\S[-/]$/;
/** A wrapped question title draws every one of its lines with a left border,
 *  "│ " (U+2502 + space) -- measured today, fixture 98. A short title that
 *  never wraps (fixture 96) carries no border at all, so this is a no-op for
 *  it. Stripped before joining/normalising a title line so both forms
 *  compare equal to the hook's own question text. */
const TITLE_BORDER = /^│\s*/;
function stripBorder(line: string): string {
  return line.replace(TITLE_BORDER, '');
}
/** A multi-line Bash command draws every one of its lines -- wrapped parts
 *  and blank lines too -- with the same "│ " border (measured 2.1.276,
 *  fixtures 62, 63); a one-line command has none (fixture 50). */
function isBordered(line: string): boolean {
  return line.trimStart().startsWith('│');
}
/** Whitespace-insensitive on purpose: tmux reflows long lines at the pane
 *  width (even mid-word) and multi-line commands carry "│" borders. */
function bare(s: string): string {
  return s.replace(/\s+/g, '');
}
/** How much of a cut-off command must be on screen before its tail can
 *  stand for the whole (non-whitespace characters). */
const MIN_VISIBLE_TAIL = 40;
/** The Bash dialog's description line when the hook has none (measured:
 *  events 47761/59737 carry no description; fixtures 50/52 show this). */
const BASH_DEFAULT_DESCRIPTION = 'Run shell command';
const PERMISSION_NO_TEXT_DEFAULT = 'No, and tell Claude what to do differently';
const PLAN_TEXT_DEFAULT = 'Tell Claude what to change';

export function readPromptScreen(capture: string, expect: ScreenExpect): ScreenRead {
  const lines = capture.split('\n');
  if (expect.kind === 'question') return readQuestion(lines, expect.headers, expect.questions);
  return readDialog(lines, expect);
}

// ---- permission / plan --------------------------------------------------

type DialogExpect = Exclude<ScreenExpect, { kind: 'question' }>;
/** `hinted`: the key of the row with the "shift+tab to approve with this
 *  feedback" line under it -- plan's text row, still known once typed
 *  feedback has replaced its label. */
type ParsedDialog = { choices: PromptChoice[]; cursor: string | null; hinted: string | null };

/** Finds the last full-width `─` rule that is followed by at least one
 *  numbered option line, and parses that trailing block. Returns null when
 *  no such rule exists (busy spinner, idle composer, trust prompt, an
 *  answered/collapsed dialog -- anything that is not a live dialog). */
function findDialogBlock(lines: string[]): string[] | null {
  const ruleIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (RULE_LINE.test((lines[i] ?? '').trim())) ruleIndexes.push(i);
  }
  for (let r = ruleIndexes.length - 1; r >= 0; r--) {
    const idx = ruleIndexes[r]!;
    const block = lines.slice(idx + 1);
    if (block.some((l) => OPTION_LINE.test(l))) return block;
  }
  return null;
}

/** A permission dialog taller than the pane (fixture 63): the capture holds
 *  only its visible part, so its rule, header and first command lines are
 *  gone and the pane starts part-way down the bordered command. Taken only
 *  when the very first row is a bordered line and no rule is on screen at
 *  all -- the idle composer always draws two -- and options follow. */
function findCutOffBlock(lines: string[]): string[] | null {
  if (!isBordered(lines[0] ?? '')) return null;
  if (lines.some((l) => RULE_LINE.test(l.trim()))) return null;
  return lines.some((l) => OPTION_LINE.test(l)) ? lines : null;
}

/** The row that takes typed text, found by its label (final review M12),
 *  never by position: a dialog with two or four options must never mark a
 *  Yes row as the one that takes text. Permission: the No row ("No", or
 *  "No, ..." once amended). Plan: "Tell Claude what to change". */
function takesTextLabel(kind: DialogExpect['kind'], label: string): boolean {
  return kind === 'permission' ? /^No\b/.test(label) : label.startsWith('Tell Claude');
}

function parseDialogChoices(block: string[], kind: DialogExpect['kind']): ParsedDialog {
  const choices: PromptChoice[] = [];
  let cursor: string | null = null;
  let hinted: string | null = null;
  let i = 0;
  while (i < block.length) {
    const line = block[i] ?? '';
    const m = OPTION_LINE.exec(line);
    if (!m) { i++; continue; }
    const isCursor = !!m[1];
    const key = m[2]!;
    let label = (m[3] ?? '').trim();
    if (isCursor) cursor = key;
    let j = i + 1;
    while (j < block.length) {
      const next = block[j] ?? '';
      const trimmed = next.trim();
      if (trimmed === '') break;
      if (OPTION_LINE.test(next)) break;
      if (trimmed === HINT_LINE) { hinted = key; j++; break; }
      // A long path wraps at the pane width, often right after a "-" or
      // "/" inside it: no space there (Task 6: "Documents- David-"). A dash
      // or slash standing alone as a word keeps its space.
      label += WRAPPED_IN_WORD.test(label) ? trimmed : ` ${trimmed}`;
      j++;
    }
    choices.push({ key, label, takesText: takesTextLabel(kind, label) });
    i = j;
  }
  return { choices, cursor, hinted };
}

/** The text in the focused row that takes text, at whatever key it sits
 *  (Task 6: a four-option permission dialog has No at 4), or null when the
 *  cursor is on any other row. Permission: the No row only once Tab has
 *  amended it to "No, ...". Plan: the "Tell Claude" row, or the row that
 *  carries the feedback hint (typed feedback replaces its label). */
function computeTextRow(kind: 'permission' | 'plan', { choices, cursor, hinted }: ParsedDialog): string | null {
  if (cursor === null) return null;
  const focused = choices.find((c) => c.key === cursor);
  if (!focused) return null;
  const label = focused.label;
  if (kind === 'permission') {
    if (!focused.takesText || !label.startsWith('No, ')) return null; // not No, or Tab not pressed yet
    return label === PERMISSION_NO_TEXT_DEFAULT ? '' : label;
  }
  if (!focused.takesText && cursor !== hinted) return null;
  return label === PLAN_TEXT_DEFAULT ? '' : label;
}

/** True only when `choices` are numbered exactly 1..n, in that order, with
 *  no gap and no repeat -- a crafted Bash/Write command previewed in the
 *  same block can contain lines shaped like "4. No, and tell Claude what to
 *  do differently" (final review: a reviewer-supplied capture built from
 *  fixture 50 showed parsed keys [4,1,2,3,4]), which would otherwise fake an
 *  extra row ahead of the real ones -- computeTextRow's `find` takes the
 *  FIRST row with the cursor's number, so a repeated key can substitute a
 *  fake row's label for the real one it belongs to. */
function hasSequentialKeys(choices: PromptChoice[]): boolean {
  return choices.every((c, i) => c.key === String(i + 1));
}

/** Screen text compared whitespace-insensitively -- a long command wraps at
 *  the pane width (even mid-word) and a multi-line command spans lines --
 *  with each line's one "│" border dropped first, or it would split a
 *  bordered command where its lines join. */
function unbordered(lines: string[]): string {
  return bare(lines.map((l) => stripBorder(l.trim())).join(''));
}

/** A non-Bash tool with its dialog's top on screen: the anchor (a file
 *  basename or the tool name) must appear in the block. */
function blockHasAnchor(block: string[], anchor: string): boolean {
  return unbordered(block).includes(anchor);
}

/** Spaces before a line's first non-space character. A "│" border stops the
 *  count, so a bordered command line's OWN indentation (drawn deeper than
 *  the dialog's chrome) is unaffected by whatever indentation the raw
 *  command text carries after the border -- e.g. fixture 62's Python
 *  "print" line, indented four more spaces by the script itself. */
function indentOf(line: string): number {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

/** A Bash dialog with its top on screen (fixtures 50, 62, 71): the header
 *  ("Bash command"), the command's lines, the description on the line(s)
 *  straight under them, then a blank line. The command region is what lies
 *  between the header and the description, and it must EQUAL the hook's
 *  command -- merely containing it would let a short anchor hit a longer
 *  command, the description or an option label. The description must fill
 *  whole lines of its own, so a command cannot borrow its first words. It
 *  is the hook's, or BASH_DEFAULT_DESCRIPTION when the hook has none; any
 *  other layout fails safe as a mismatch.
 *
 *  Measured 2026-09-18 (fixture 64): a dialog-level Tip line can sit
 *  between the header and the command ("Tip: auto mode handles these
 *  prompts for you..."), and a bordered warning note can sit between the
 *  description and "Do you want to proceed?". Both are drawn at the
 *  HEADER's own indentation (1 space in every fixture); the command and its
 *  description sit one level deeper (3 spaces, bordered or not -- fixtures
 *  50, 52-56, 60, 62, 63, 64). Rather than hard-code either number, the
 *  header's indentation is measured on THIS screen and the command region
 *  is taken as whatever sits deeper than it -- so it keeps working even if
 *  the exact column ever shifts.
 *
 *  The command region is the single run of non-blank, deeper-than-header
 *  lines that starts right after the header (skipping only blank lines and
 *  lines at the header's own indentation) and ends for good at the first
 *  blank line, or the first line back at the header's indentation. Ending
 *  it there -- rather than skipping the offending line and resuming --
 *  means a Tip/warning-style line dropped into the middle of the command
 *  can only ever cut the run short, never split it into a smaller fragment
 *  that a forged, shorter anchor could then match: once the run is cut
 *  short of the real description, the split search below has nothing to
 *  match against and the whole dialog is refused, not just that one line. */
function bashCommandEquals(above: string[], anchor: string, description: string | undefined): boolean {
  const headerIdx = above.findIndex((l) => l.trim() !== '');
  if (headerIdx === -1) return false;
  const headerIndent = indentOf(above[headerIdx] ?? '');

  const run: string[] = [];
  for (let i = headerIdx + 1; i < above.length; i++) {
    const raw = above[i] ?? '';
    const deep = raw.trim() !== '' && indentOf(raw) > headerIndent;
    if (run.length === 0) { if (deep) run.push(raw); continue; } // still before the run starts
    if (!deep) break; // blank, or back at the header's own indentation: run over for good
    run.push(raw);
  }

  const shownDescription = bare(description?.trim() ? description : BASH_DEFAULT_DESCRIPTION);
  for (let split = run.length - 1; split > 0; split--) {
    if (bare(run.slice(split).join('')) === shownDescription && unbordered(run.slice(0, split)) === anchor) return true;
  }
  return false;
}

/** The dialog's top is cut off (findCutOffBlock), so only the command's
 *  last lines show: the bordered run the pane starts with. It must be the
 *  END of the hook command -- the dialog shows the command down to its last
 *  line -- and long enough not to match by accident (MIN_VISIBLE_TAIL, or
 *  the whole anchor when that is shorter). Nothing above it can be checked;
 *  that part is taken on trust from the tail.
 *
 *  Residual risk, accepted: two commands that end in the same 40+ characters
 *  but differ above the fold read as the same. That only matters when the
 *  pane can show a different prompt from the card's -- two PermissionRequests
 *  in one wait -- and the ambiguity guard (hasMultiplePromptEvents, store/
 *  signals.ts) makes those cards read-only, which is what makes this
 *  acceptable. */
function tailMatchesAnchor(above: string[], anchor: string): boolean {
  const run: string[] = [];
  for (const line of above) {
    if (!isBordered(line)) break;
    run.push(stripBorder(line.trim()));
  }
  const visible = bare(run.join(''));
  return visible.length >= Math.min(MIN_VISIBLE_TAIL, anchor.length) && anchor.endsWith(visible);
}

function readDialog(lines: string[], expect: DialogExpect): ScreenRead {
  const ruled = findDialogBlock(lines);
  // Only a permission dialog is read with its top cut off (measured, 63).
  const block = ruled ?? (expect.kind === 'permission' ? findCutOffBlock(lines) : null);
  if (!block) return { match: false, why: 'no_dialog_on_screen' };

  const parsed = parseDialogChoices(block, expect.kind);
  const { choices, cursor } = parsed;
  if (choices.length === 0) return { match: false, why: 'no_options_found' };
  if (!hasSequentialKeys(choices)) return { match: false, why: 'option_numbers_not_sequential' };

  if (expect.kind === 'plan') {
    if (!block.some((l) => l.includes('Would you like to proceed?'))) {
      return { match: false, why: 'not_a_plan_dialog' };
    }
    return { match: true, kind: 'plan', choices, cursor, textRow: computeTextRow('plan', parsed) };
  }

  // permission
  const firstOptionIdx = block.findIndex((l) => OPTION_LINE.test(l));
  const above = firstOptionIdx === -1 ? block : block.slice(0, firstOptionIdx);
  const hasQuestionLine = above.some((l) => l.trim().endsWith('?'));
  if (!hasQuestionLine) return { match: false, why: 'no_question_line_above_options' };
  // All whitespace is removed from the anchor as from the screen. An anchor
  // that is only whitespace would then match anything, so it never matches.
  const anchor = bare(expect.anchor);
  if (anchor === '') return { match: false, why: 'empty_anchor' };
  const found = !ruled ? tailMatchesAnchor(above, anchor)
    : expect.toolName === 'Bash' ? bashCommandEquals(above, anchor, expect.description)
      : blockHasAnchor(block, anchor);
  if (!found) return { match: false, why: 'anchor_not_found' };

  return { match: true, kind: 'permission', choices, cursor, textRow: computeTextRow('permission', parsed) };
}

// ---- questions ------------------------------------------------------------

function findLastTabRowIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TAB_ROW.test((lines[i] ?? '').trim())) return i;
  }
  return -1;
}

/** A one-question prompt has no tab row: just its header chip on the line
 *  straight under the rule, e.g. " ☐ Next step" (fixture 96). Only looked
 *  for when the hook has exactly one question. */
function findLastHeaderLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i > 0; i--) {
    if (HEADER_LINE.test((lines[i] ?? '').trim()) && RULE_LINE.test((lines[i - 1] ?? '').trim())) return i;
  }
  return -1;
}

function parseTabRow(line: string): { headers: string[]; answered: boolean[] } {
  const inner = line.trim().replace(/^←\s*/, '').replace(/\s*→$/, '');
  const tokens = inner.split(/\s{2,}/).filter((t) => t.length > 0);
  const headers: string[] = [];
  const answered: boolean[] = [];
  for (const tok of tokens) {
    if (tok.startsWith('☐') || tok.startsWith('☒')) {
      headers.push(tok.slice(1).trim());
      answered.push(tok.startsWith('☒'));
    }
    // The ✔ Submit token is not a question header; ignored.
  }
  return { headers, answered };
}

/** The index in `rest`, at or after `from`, of the "Chat about this" option
 *  line -- always the last option of any AskUserQuestion question (measured,
 *  fixtures 96-100) -- or -1 when none is on screen. Used to find the row
 *  right before it: the "Type something" / typed-answer row, the only one
 *  whose continuation lines are ever joined into its label. */
function findChatAboutThisIndex(rest: string[], from: number): number {
  for (let k = from; k < rest.length; k++) {
    const m = OPTION_LINE.exec(rest[k] ?? '');
    if (m && /^Chat about this$/i.test((m[3] ?? '').trim())) return k;
  }
  return -1;
}

function parseReviewAnswers(section: string[]): { question: string; answer: string }[] {
  const answers: { question: string; answer: string }[] = [];
  for (let i = 0; i < section.length; i++) {
    const t = (section[i] ?? '').trim();
    if (!t.startsWith('●')) continue;
    const question = stripBorder(t.slice(1).trim());
    let j = i + 1;
    while (j < section.length && (section[j] ?? '').trim() === '') j++;
    const next = (section[j] ?? '').trim();
    if (next.startsWith('→')) {
      answers.push({ question, answer: next.slice(1).trim() });
      i = j;
    }
  }
  return answers;
}

function readQuestion(lines: string[], headers: string[], questions: string[]): ScreenRead {
  const tabRowIdx = findLastTabRowIndex(lines);
  // The header-line form, only for a one-question hook, and only when it is
  // the lower of the two on screen. "no_tab_row_on_screen" still means the
  // dialog is gone for both forms (answer.ts's isGone).
  const headerIdx = headers.length === 1 ? findLastHeaderLineIndex(lines) : -1;
  if (tabRowIdx === -1 && headerIdx === -1) return { match: false, why: 'no_tab_row_on_screen' };
  const headerOnly = headerIdx > tabRowIdx;
  const rowIdx = headerOnly ? headerIdx : tabRowIdx;

  const rowLine = lines[rowIdx] ?? '';
  const { headers: screenHeaders, answered } = headerOnly
    ? { headers: [rowLine.trim().slice(1).trim()], answered: [rowLine.trim().startsWith('☒')] }
    : parseTabRow(rowLine);
  if (screenHeaders.length !== headers.length || !screenHeaders.every((h, i) => h === headers[i])) {
    return { match: false, why: 'headers_mismatch' };
  }

  const rest = lines.slice(rowIdx + 1);

  const reviewIdx = rest.findIndex((l) => l.trim() === 'Review your answers');
  if (reviewIdx !== -1) {
    const hasReadyLine = rest.some((l) => l.includes('Ready to submit your answers?'));
    const answers = parseReviewAnswers(rest.slice(reviewIdx));
    if (!hasReadyLine || answers.length === 0) return { match: false, why: 'incomplete_review_screen' };
    return { match: true, kind: 'review', answers };
  }

  // The question's title can wrap onto more than one line; join with a
  // single space, then match it against the hook's question texts with
  // whitespace runs collapsed on both sides (final review M4) -- the hook's
  // text can carry a newline or a double space the screen shows as one.
  // Headers are short chips (e.g. "Auth method") that usually do not
  // appear in the question text, so they cannot be used to find `current`.
  let qIdx = 0;
  while (qIdx < rest.length && (rest[qIdx] ?? '').trim() === '') qIdx++;
  const titleParts: string[] = [];
  let afterTitleIdx = qIdx;
  while (afterTitleIdx < rest.length) {
    const raw = rest[afterTitleIdx] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '' || OPTION_LINE.test(raw)) break;
    titleParts.push(stripBorder(trimmed));
    afterTitleIdx++;
  }
  const title = titleParts.join(' ').trim();
  // No "must end in ?" rule: real questions often end in ")" or "." (measured
  // 2026-09-18). The title must still EQUAL a hook question text below.
  if (titleParts.length === 0 || title === '') return { match: false, why: 'no_question_title_found' };

  const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();
  const current = questions.findIndex((q) => collapse(q) === collapse(title));
  if (current === -1) return { match: false, why: 'question_text_mismatch' };

  // The row right before "Chat about this" is always "Type something." --
  // or, once the user has typed into it, the typed text itself. A long
  // answer wraps at the pane width (measured 2026-09-18, fixture 100): its
  // continuation lines carry no leading digit, so the plain per-line loop
  // below would otherwise read only the first screen line of it. Found by
  // position, not by content (the label no longer reads "Type something."
  // once text replaces it), so an option's own description line (e.g.
  // "First implementation approach" under "1. Alpha", fixture 99) is never
  // mistaken for it: that line sits above this row, not below it.
  const chatIdx = findChatAboutThisIndex(rest, afterTitleIdx);
  let typedRowIdx = -1;
  for (let k = chatIdx - 1; k >= afterTitleIdx; k--) {
    if (OPTION_LINE.test(rest[k] ?? '')) { typedRowIdx = k; break; }
  }

  const options: string[] = [];
  for (let k = afterTitleIdx; k < rest.length; k++) {
    const m = OPTION_LINE.exec(rest[k] ?? '');
    if (!m) continue;
    let label = (m[3] ?? '').trim().replace(/^\[[ ✔]\]\s*/, '');
    if (/^Chat about this$/i.test(label)) break;
    if (/^Type something\.?$/i.test(label)) break;
    if (k === typedRowIdx) {
      // Join this row's continuation lines with a single space, stopping at
      // the next option row, a blank line, a rule, or (multi-select) the
      // "Submit" row -- never at a different row's own continuation, since
      // this only ever runs for the one row right before "Chat about this".
      for (let j = k + 1; j < chatIdx; j++) {
        const next = rest[j] ?? '';
        const trimmed = next.trim();
        if (trimmed === '' || RULE_LINE.test(trimmed) || SUBMIT_ROW.test(trimmed) || OPTION_LINE.test(next)) break;
        label += ` ${trimmed}`;
      }
    }
    options.push(label);
  }

  return headerOnly
    ? { match: true, kind: 'question', current, answered, options, headerOnly: true }
    : { match: true, kind: 'question', current, answered, options };
}
