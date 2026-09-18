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
const WRAPPED_IN_WORD = /\S[-/]$/;
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

function readDialog(lines: string[], expect: DialogExpect): ScreenRead {
  const block = findDialogBlock(lines);
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
  // Whitespace-insensitive: a long command wraps at the pane width (even
  // mid-word) and a multi-line command spans lines, so all whitespace is
  // removed from both sides before the plain `includes`. An anchor that is
  // only whitespace would then match anything, so it never matches.
  const anchor = expect.anchor.replace(/\s+/g, '');
  if (anchor === '') return { match: false, why: 'empty_anchor' };
  if (!block.join('').replace(/\s+/g, '').includes(anchor)) return { match: false, why: 'anchor_not_found' };

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

function parseReviewAnswers(section: string[]): { question: string; answer: string }[] {
  const answers: { question: string; answer: string }[] = [];
  for (let i = 0; i < section.length; i++) {
    const t = (section[i] ?? '').trim();
    if (!t.startsWith('●')) continue;
    const question = t.slice(1).trim();
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
    titleParts.push(trimmed);
    afterTitleIdx++;
  }
  const title = titleParts.join(' ').trim();
  if (titleParts.length === 0 || !title.endsWith('?')) return { match: false, why: 'no_question_title_found' };

  const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();
  const current = questions.findIndex((q) => collapse(q) === collapse(title));
  if (current === -1) return { match: false, why: 'question_text_mismatch' };

  const options: string[] = [];
  for (let k = afterTitleIdx; k < rest.length; k++) {
    const m = OPTION_LINE.exec(rest[k] ?? '');
    if (!m) continue;
    const label = (m[3] ?? '').trim().replace(/^\[[ ✔]\]\s*/, '');
    if (/^Type something\.?$/i.test(label) || /^Chat about this$/i.test(label)) break;
    options.push(label);
  }

  return headerOnly
    ? { match: true, kind: 'question', current, answered, options, headerOnly: true }
    : { match: true, kind: 'question', current, answered, options };
}
