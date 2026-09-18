import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { readPromptScreen } from '../../src/main/promptScreen.ts';
import type { ScreenExpect } from '../../src/core/prompt.ts';

const FIXTURES = new URL('../fixtures/quick-answers/screens/', import.meta.url);

function screen(name: string): string {
  return readFileSync(new URL(`${name}.txt`, FIXTURES), 'utf8');
}

const ASK_HEADERS = ['Color', 'Pets'];
const ASK_QUESTIONS = ['Which color?', 'Which pets?'];
const askExpect = (headers: string[] = ASK_HEADERS, questions: string[] = ASK_QUESTIONS): ScreenExpect =>
  ({ kind: 'question', headers, questions });
const permExpect = (anchor: string, toolName = 'Bash'): ScreenExpect =>
  ({ kind: 'permission', toolName, anchor });
const planExpect = (): ScreenExpect => ({ kind: 'plan' });

describe('readPromptScreen -- permission dialogs', () => {
  it('matches the Bash dialog on its own command, with the continuation line joined', () => {
    const result = readPromptScreen(screen('50-perm-bash-dialog'), permExpect('touch perm-probe.txt'));
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.cursor).toBe('1');
    expect(result.choices).toEqual([
      { key: '1', label: 'Yes', takesText: false },
      expect.objectContaining({
        key: '2',
        label: expect.stringContaining('and always allow access to'),
        takesText: false,
      }),
      { key: '3', label: 'No', takesText: true },
    ]);
    const opt2 = result.choices[1]!;
    expect(opt2.label.startsWith('Yes, and always allow access to')).toBe(true);
    expect(opt2.label.endsWith('from this project')).toBe(true);
    expect(result.textRow).toBeNull();
  });

  it('rejects the same dialog when the anchor is a different command', () => {
    const result = readPromptScreen(screen('50-perm-bash-dialog'), permExpect('rm -rf x'));
    expect(result.match).toBe(false);
  });

  it('matches the Write dialog, whose option 2 wording differs from Bash', () => {
    const result = readPromptScreen(screen('60-perm-write-dialog'), permExpect('write-probe.txt', 'Write'));
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.cursor).toBe('1');
    expect(result.choices[1]!.label.startsWith('Yes, and switch to accept edits')).toBe(true);
  });

  it('reads the cursor on the plain No row, before Tab -- not yet a text row', () => {
    const result = readPromptScreen(screen('52-perm-bash2-cursor-no'), permExpect('touch perm-probe-no.txt'));
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.cursor).toBe('3');
    expect(result.choices[2]).toEqual({ key: '3', label: 'No', takesText: true });
    expect(result.textRow).toBeNull();
  });

  it('reads cursor 3 and the amended label after Tab on No', () => {
    const result = readPromptScreen(screen('53-perm-bash2-tab-on-no'), permExpect('touch perm-probe-no.txt'));
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.cursor).toBe('3');
    expect(result.choices[2]!.label).toBe('No, and tell Claude what to do differently');
    expect(result.textRow).toBe('');
  });

  it('reads the typed feedback text in the No row', () => {
    const result = readPromptScreen(screen('54-perm-bash2-typed-feedback'), permExpect('touch perm-probe-no.txt'));
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.textRow).toBe('No, Skip it and reply NOPROBE');
  });

  it.each([
    ['71-s2-bash-dialog', 'touch perm-probe-always.txt'],
    ['73-s2-bash-always-noprompt', 'touch perm-probe-always2.txt'],
  ])('matches the second session\'s Bash dialog %s on its own command', (file, anchor) => {
    const result = readPromptScreen(screen(file), permExpect(anchor));
    expect(result.match).toBe(true);
    if (!result.match) throw new Error('expected match');
    expect(result.kind).toBe('permission');
  });

  it('matches the Write dialog that follows plan option 2, when checked as a permission', () => {
    const result = readPromptScreen(screen('84-plan-after-2'), permExpect('plan-probe.txt', 'Write'));
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.choices[1]!.label.startsWith('Yes, and switch to accept edits')).toBe(true);
  });
});

// Controller ruling (Task 3 fix round): long commands wrap at the pane
// width, and multi-line commands span lines, so the anchor is matched with
// all whitespace removed from both sides. These screens are fixture 50 with
// only its command line replaced.
describe('readPromptScreen -- permission anchor ignores whitespace', () => {
  const withCommand = (lines: string[]): string =>
    screen('50-perm-bash-dialog').replace(/^ {3}touch perm-probe\.txt$/m, lines.map(l => `   ${l}`).join('\n'));

  const LONG = 'npm run build -- --filter=@acme/some-really-long-package-name && npm test -- --coverage --reporter=verbose';
  const wrapped = withCommand([
    'npm run build -- --filter=@acme/some-really-long-package-name && npm test -- --cov',
    'erage --reporter=verbose',
  ]);

  it('matches a long command wrapped across two lines, even mid-word', () => {
    const result = readPromptScreen(wrapped, permExpect(LONG));
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.choices.map(c => c.key)).toEqual(['1', '2', '3']);
  });

  it('matches a multi-line command (a newline in tool_input.command)', () => {
    const capture = withCommand(['cd /tmp/work &&', '  make all']);
    expect(readPromptScreen(capture, permExpect('cd /tmp/work &&\n  make all')).match).toBe(true);
  });

  it('still rejects a different command', () => {
    expect(readPromptScreen(wrapped, permExpect('npm run build -- --filter=@acme/other && npm test')).match).toBe(false);
    expect(readPromptScreen(withCommand(['cd /tmp/work &&', '  make all']), permExpect('cd /tmp/work && make clean')).match)
      .toBe(false);
  });

  it('never matches on an anchor that is only whitespace', () => {
    expect(readPromptScreen(wrapped, permExpect('  \n\t ')).match).toBe(false);
  });
});

describe('readPromptScreen -- plan dialogs', () => {
  it.each(['80-plan-dialog', '90-plan2-dialog'])('matches %s: three choices, option 3 takes text', (file) => {
    const result = readPromptScreen(screen(file), planExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'plan') throw new Error('expected plan match');
    expect(result.choices).toHaveLength(3);
    expect(result.choices[2]!.takesText).toBe(true);
    expect(result.choices[0]!.takesText).toBe(false);
    expect(result.choices[1]!.takesText).toBe(false);
  });

  it('reads cursor 3 with an empty text row before typing', () => {
    const result = readPromptScreen(screen('81-plan-key3'), planExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'plan') throw new Error('expected plan match');
    expect(result.cursor).toBe('3');
    expect(result.choices[2]!.label).toBe('Tell Claude what to change');
    expect(result.textRow).toBe('');
  });

  it('reads the typed plan feedback text', () => {
    const result = readPromptScreen(screen('82-plan-typed-feedback'), planExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'plan') throw new Error('expected plan match');
    expect(result.textRow).toBe('Change the word to PLANFEEDBACK instead of hi');
  });

  it('matches the second plan-feedback round (83-plan-v2-dialog)', () => {
    const result = readPromptScreen(screen('83-plan-v2-dialog'), planExpect());
    expect(result.match).toBe(true);
    if (!result.match) throw new Error('expected match');
    expect(result.kind).toBe('plan');
  });

  it('rejects the plan dialog when checked against a permission expectation', () => {
    const result = readPromptScreen(screen('80-plan-dialog'), permExpect('touch perm-probe-always2.txt'));
    expect(result.match).toBe(false);
  });

  it('rejects 84 (a Write permission dialog) when checked against a plan expectation', () => {
    const result = readPromptScreen(screen('84-plan-after-2'), planExpect());
    expect(result.match).toBe(false);
  });
});

describe('readPromptScreen -- questions', () => {
  it('matches the first question with both headers unanswered', () => {
    const result = readPromptScreen(screen('10-ask-q1'), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
    expect(result.answered).toEqual([false, false]);
    expect(result.options).toEqual(['Red', 'Green', 'Blue']);
  });

  it('rejects 10-ask-q1 when the requested headers do not match the screen', () => {
    const result = readPromptScreen(screen('10-ask-q1'), askExpect(['Color', 'Food']));
    expect(result.match).toBe(false);
  });

  it('advances current to 1 after answering the first question', () => {
    const result = readPromptScreen(screen('11-ask-after-key2'), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(1);
    expect(result.answered).toEqual([true, false]);
  });

  it.each([
    ['12-ask-multi-after-1', [true, true]],
    ['13-ask-multi-after-3', [true, true]],
    ['14-ask-multi-down-space', [true, true]],
    ['15-ask-multi-2-untoggle', [true, true]],
  ])('matches mid multi-select screen %s (ruled a live question, not "after")', (file, answered) => {
    const result = readPromptScreen(screen(file), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(1);
    expect(result.answered).toEqual(answered);
  });

  it('matches 16-ask-left-back: Left goes back and keeps the earlier answer', () => {
    const result = readPromptScreen(screen('16-ask-left-back'), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
    expect(result.answered).toEqual([true, true]);
  });

  it.each(['17-ask-q1-blue-enter', '18-ask-multi-enter-on-cat'])(
    'matches %s as a live mid-dialog question screen',
    (file) => {
      const result = readPromptScreen(screen(file), askExpect());
      expect(result.match).toBe(true);
      if (!result.match) throw new Error('expected match');
      expect(result.kind).toBe('question');
    },
  );

  it('reads the review screen with the submitted answers', () => {
    const result = readPromptScreen(screen('19-ask-review'), askExpect());
    expect(result.match).toBe(true);
    if (!result.match) throw new Error('expected match');
    // Must be told apart from a live question screen, never reported as 'question'.
    expect(result.kind).toBe('review');
    if (result.kind !== 'review') throw new Error('expected review');
    expect(result.answers).toEqual([
      { question: 'Which color?', answer: 'Blue' },
      { question: 'Which pets?', answer: 'Fish, Cat' },
    ]);
  });

  it('reads the second round review screen, including the typed text', () => {
    const result = readPromptScreen(screen('39-ask2-review'), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'review') throw new Error('expected review match');
    expect(result.answers).toEqual([
      { question: 'Which color?', answer: 'Teal probe' },
      { question: 'Which pets?', answer: 'Dog, Parrot probe' },
    ]);
  });

  it.each([
    ['30-ask2-q1', 0],
    ['31-ask2-key4', 0],
    ['32-ask2-typed', 0],
    ['33-ask2-q2', 1],
    ['34-ask2-multi-key4', 1],
    ['35-ask2-multi-cursor-on-4', 1],
    ['36-ask2-multi-typed', 1],
    ['37-ask2-right-from-text', 1],
    ['38-ask2-tab-from-text', 1],
  ])('matches the second AskUserQuestion round, screen %s', (file, current) => {
    const result = readPromptScreen(screen(file), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(current);
  });

  it('finds current by the question text, not the header word -- headers are short chips that usually do not appear in the question', () => {
    // A hand-built capture: header "Auth" never appears in its own question
    // text at all, unlike the fixtures above (where "color"/"pets" happen to
    // echo their headers). The old header-word heuristic would have failed
    // here; matching the exact question text must not.
    const capture = [
      '←  ☐ Auth  ☐ Region  ✔ Submit  →',
      '',
      'Which login provider should we use?',
      '',
      '❯ 1. Google',
      '  2. GitHub',
      '  3. Type something.',
      '  4. Chat about this',
      '',
    ].join('\n');
    const result = readPromptScreen(
      capture,
      askExpect(['Auth', 'Region'], ['Which login provider should we use?', 'Which region?']),
    );
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
    expect(result.answered).toEqual([false, false]);
    expect(result.options).toEqual(['Google', 'GitHub']);
  });

  it('rejects when the screen\'s question text does not match any of the expected questions', () => {
    const result = readPromptScreen(
      screen('10-ask-q1'),
      askExpect(ASK_HEADERS, ['Which colour?', 'Which pets?']), // "colour" -- deliberately not what's on screen
    );
    expect(result.match).toBe(false);
  });

  it('16-ask-left-back still finds current 0 by matching the question text', () => {
    const result = readPromptScreen(screen('16-ask-left-back'), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
  });
});

describe('readPromptScreen -- negatives that prove the reader tells outcomes apart', () => {
  // Every one of these screens shows something other than the expected live
  // prompt: a trust dialog, an idle composer, a busy spinner, an answered
  // screen, or a screen from a different prompt entirely. None of them
  // should ever produce match: true, for any of the three prompt kinds.
  const rejectEverywhere = [
    '00-trust', '01-trust-after-2', '02-trust-after-down', '03-after-trust',
    '20-ask-after-submit', '40-ask2-after-submit', '41-ask3-key5-chat',
    '51-perm-bash-after-1', '55-perm-bash2-after-no', '56-perm-bash3-key3',
    '61-perm-write-after-2', '70-s2-start', '72-s2-bash-after-2',
    '74-s2-bash-esc', '75-s2-btab1-footer', '76-s2-btab2-footer',
    '91-plan2-after-1', '95-ask-esc',
  ];

  it.each(rejectEverywhere)('%s matches nothing -- not a question, permission, or plan', (file) => {
    const capture = screen(file);
    expect(readPromptScreen(capture, askExpect()).match).toBe(false);
    expect(readPromptScreen(capture, permExpect('touch perm-probe.txt')).match).toBe(false);
    expect(readPromptScreen(capture, planExpect()).match).toBe(false);
  });
});
