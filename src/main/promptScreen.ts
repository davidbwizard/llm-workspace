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
const HINT_LINE = 'shift+tab to approve with this feedback';
const PERMISSION_NO_TEXT_DEFAULT = 'No, and tell Claude what to do differently';
const PLAN_TEXT_DEFAULT = 'Tell Claude what to change';

export function readPromptScreen(capture: string, expect: ScreenExpect): ScreenRead {
  const lines = capture.split('\n');
  if (expect.kind === 'question') return readQuestion(lines, expect.headers);
  return readDialog(lines, expect);
}

// ---- permission / plan --------------------------------------------------

type DialogExpect = Exclude<ScreenExpect, { kind: 'question' }>;
type ParsedDialog = { choices: PromptChoice[]; cursor: string | null };

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

function parseDialogChoices(block: string[]): ParsedDialog {
  const choices: PromptChoice[] = [];
  let cursor: string | null = null;
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
      if (trimmed === HINT_LINE) { j++; break; }
      label += ` ${trimmed}`;
      j++;
    }
    choices.push({ key, label, takesText: key === '3' });
    i = j;
  }
  return { choices, cursor };
}

function computeTextRow(kind: 'permission' | 'plan', choices: PromptChoice[], cursor: string | null): string | null {
  if (cursor !== '3') return null;
  const choice3 = choices.find((c) => c.key === '3');
  if (!choice3) return null;
  const label = choice3.label;
  if (kind === 'permission') {
    if (!label.startsWith('No, ')) return null; // cursor on "No", Tab not pressed yet
    return label === PERMISSION_NO_TEXT_DEFAULT ? '' : label;
  }
  return label === PLAN_TEXT_DEFAULT ? '' : label;
}

function readDialog(lines: string[], expect: DialogExpect): ScreenRead {
  const block = findDialogBlock(lines);
  if (!block) return { match: false, why: 'no_dialog_on_screen' };

  const { choices, cursor } = parseDialogChoices(block);
  if (choices.length === 0) return { match: false, why: 'no_options_found' };

  if (expect.kind === 'plan') {
    if (!block.some((l) => l.includes('Would you like to proceed?'))) {
      return { match: false, why: 'not_a_plan_dialog' };
    }
    return { match: true, kind: 'plan', choices, cursor, textRow: computeTextRow('plan', choices, cursor) };
  }

  // permission
  const firstOptionIdx = block.findIndex((l) => OPTION_LINE.test(l));
  const above = firstOptionIdx === -1 ? block : block.slice(0, firstOptionIdx);
  const hasQuestionLine = above.some((l) => l.trim().endsWith('?'));
  if (!hasQuestionLine) return { match: false, why: 'no_question_line_above_options' };
  if (!block.some((l) => l.includes(expect.anchor))) return { match: false, why: 'anchor_not_found' };

  return { match: true, kind: 'permission', choices, cursor, textRow: computeTextRow('permission', choices, cursor) };
}

// ---- questions ------------------------------------------------------------

function findLastTabRowIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TAB_ROW.test((lines[i] ?? '').trim())) return i;
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

function readQuestion(lines: string[], headers: string[]): ScreenRead {
  const tabRowIdx = findLastTabRowIndex(lines);
  if (tabRowIdx === -1) return { match: false, why: 'no_tab_row_on_screen' };

  const tabRowLine = lines[tabRowIdx] ?? '';
  const { headers: screenHeaders, answered } = parseTabRow(tabRowLine);
  if (screenHeaders.length !== headers.length || !screenHeaders.every((h, i) => h === headers[i])) {
    return { match: false, why: 'headers_mismatch' };
  }

  const rest = lines.slice(tabRowIdx + 1);

  const reviewIdx = rest.findIndex((l) => l.trim() === 'Review your answers');
  if (reviewIdx !== -1) {
    const hasReadyLine = rest.some((l) => l.includes('Ready to submit your answers?'));
    const answers = parseReviewAnswers(rest.slice(reviewIdx));
    if (!hasReadyLine || answers.length === 0) return { match: false, why: 'incomplete_review_screen' };
    return { match: true, kind: 'review', answers };
  }

  let qIdx = 0;
  while (qIdx < rest.length && (rest[qIdx] ?? '').trim() === '') qIdx++;
  const title = (rest[qIdx] ?? '').trim();
  if (qIdx >= rest.length || !title.endsWith('?')) return { match: false, why: 'no_question_title_found' };

  let current = headers.findIndex((h) => title.toLowerCase().includes(h.toLowerCase()));
  if (current === -1) current = 0;

  const options: string[] = [];
  for (let k = qIdx + 1; k < rest.length; k++) {
    const m = OPTION_LINE.exec(rest[k] ?? '');
    if (!m) continue;
    const label = (m[3] ?? '').trim().replace(/^\[[ ✔]\]\s*/, '');
    if (/^Type something\.?$/i.test(label) || /^Chat about this$/i.test(label)) break;
    options.push(label);
  }

  return { match: true, kind: 'question', current, answered, options };
}
