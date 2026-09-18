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
const permExpect = (anchor: string, toolName = 'Bash', description?: string): ScreenExpect =>
  ({ kind: 'permission', toolName, anchor, description });
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
    ['71-s2-bash-dialog', 'touch perm-probe-always.txt', 'Create empty file perm-probe-always.txt'],
    ['73-s2-bash-always-noprompt', 'touch perm-probe-always2.txt', 'Create empty file perm-probe-always2.txt'],
  ])('matches the second session\'s Bash dialog %s on its own command and description', (file, anchor, description) => {
    const result = readPromptScreen(screen(file), permExpect(anchor, 'Bash', description));
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

// Measured 2026-09-18 (Claude Code 2.1.276): a multi-line Bash command is
// drawn with a "│ " border on every line (62); a one-line command has none
// (50). A command taller than the pane pushes the dialog's rule, header and
// first command lines off the top of the capture (63: lines 13-40 visible).
describe('readPromptScreen -- bordered and overflowing multi-line commands', () => {
  const CMD62 = 'python3 - <<EOF\nfor i in range(30):\n'
    + '    print("line", i, "of a deliberately long multi-line command body used to test the permission dialog")\nEOF';
  const CMD63 = Array.from({ length: 40 }, (_, i) => `touch long-probe-file-${i + 1}.txt`).join('\n');
  const DIR = '/private/tmp/claude-502/-Users-user000000000-Documents-David-llm-workspace/05ca161a-0ae7-4978-8680-b333894fe577/scratchpad/p4probe';
  const OPT2 = "Yes, and don't ask again for touch long-probe-file-1.txt, touch long-probe-file-2.txt, touch long-probe-file-3.txt, "
    + `touch long-probe-file-4.txt, and touch long-probe-file-5.txt commands in ${DIR}`;
  const DESC62 = 'Run a Python script that prints 30 lines of test output';
  const bare = (s: string) => s.replace(/\s+/g, '');
  const read = (capture: string, anchor: string, description?: string) => {
    const result = readPromptScreen(capture, permExpect(anchor, 'Bash', description));
    if (!result.match || result.kind !== 'permission') throw new Error(`expected permission match, got ${JSON.stringify(result)}`);
    return result;
  };
  /** Fixture 63 with its first `n` rows scrolled off as well. */
  const cut63 = (n: number) => screen('63-perm-bash-tall-overflow').split('\n').slice(n).join('\n');

  it('62: matches the bordered heredoc on its own command -- Yes, and No (the row that takes text)', () => {
    const result = read(screen('62-perm-bash-multiline-bordered'), CMD62, DESC62);
    expect(result.choices).toEqual([
      { key: '1', label: 'Yes', takesText: false },
      { key: '2', label: 'No', takesText: true },
    ]);
    expect(result.cursor).toBe('1');
    expect(result.textRow).toBeNull();
  });

  it('63: matches the overflowing 40-line command on its visible tail, option 2 joined across its wrapped lines', () => {
    const result = read(screen('63-perm-bash-tall-overflow'), CMD63);
    expect(result.choices.map(c => [c.key, c.takesText])).toEqual([['1', false], ['2', false], ['3', true]]);
    expect(result.choices[0]!.label).toBe('Yes');
    expect(result.choices[2]!.label).toBe('No');
    expect(result.choices[1]!.label.startsWith("Yes, and don't ask again for touch long-probe-file-1.txt, touch")).toBe(true);
    expect(result.choices[1]!.label.endsWith('/scratchpad/p4probe')).toBe(true);
    expect(bare(result.choices[1]!.label)).toBe(bare(OPT2));
    expect(result.cursor).toBe('1');
    expect(result.textRow).toBeNull();
  });

  it('62: rejects a different command in the same bordered dialog', () => {
    expect(readPromptScreen(screen('62-perm-bash-multiline-bordered'), permExpect(CMD62.replace('range(30)', 'range(31)'), 'Bash', DESC62)))
      .toEqual({ match: false, why: 'anchor_not_found' });
  });

  it('62: a fully visible command that is only the END of the hook command is refused -- the top is on screen, so all of it must be', () => {
    expect(readPromptScreen(screen('62-perm-bash-multiline-bordered'), permExpect(`rm -rf ~/important && ${CMD62}`, 'Bash', DESC62)).match)
      .toBe(false);
  });

  it('63: rejects a different 40-line command', () => {
    const other = Array.from({ length: 40 }, (_, i) => `touch other-probe-file-${i + 1}.txt`).join('\n');
    expect(readPromptScreen(screen('63-perm-bash-tall-overflow'), permExpect(other)))
      .toEqual({ match: false, why: 'anchor_not_found' });
  });

  it('63: rejects a hook command that carries more after the visible tail (the tail must be its end)', () => {
    expect(readPromptScreen(screen('63-perm-bash-tall-overflow'), permExpect(`${CMD63}\nrm -rf ~/important`)).match).toBe(false);
  });

  it('63: rejects a hook command that is only a piece of what is visible', () => {
    const lastTwo = 'touch long-probe-file-39.txt\ntouch long-probe-file-40.txt';
    expect(readPromptScreen(screen('63-perm-bash-tall-overflow'), permExpect(lastTwo)).match).toBe(false);
  });

  it('63: rejects a visible tail shorter than the minimum, even though it is in the command', () => {
    const onlyLast = cut63(27);
    expect(onlyLast.split('\n')[0]).toBe('   │ touch long-probe-file-40.txt');
    expect(readPromptScreen(onlyLast, permExpect(CMD63))).toEqual({ match: false, why: 'anchor_not_found' });
  });

  it('63: still matches with fewer rows visible, while the tail is at least the minimum', () => {
    const lastTwo = cut63(26);
    expect(bare(lastTwo.split('\n').slice(0, 2).join('')).replace(/│/g, '').length).toBeGreaterThanOrEqual(40);
    expect(read(lastTwo, CMD63).choices).toHaveLength(3);
  });

  it('63: the overflow read needs the pane to START on a bordered command line', () => {
    const capture = `some other output\n${screen('63-perm-bash-tall-overflow')}`;
    expect(readPromptScreen(capture, permExpect(CMD63))).toEqual({ match: false, why: 'no_dialog_on_screen' });
  });

  it('63: the overflow read needs no rule anywhere on screen (the idle composer always draws two)', () => {
    const capture = `${screen('63-perm-bash-tall-overflow')}\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ? for shortcuts`;
    expect(readPromptScreen(capture, permExpect(CMD63))).toEqual({ match: false, why: 'no_dialog_on_screen' });
  });

  it('63: the overflow read is for permission dialogs only', () => {
    expect(readPromptScreen(screen('63-perm-bash-tall-overflow'), planExpect()).match).toBe(false);
  });

  it('63: still needs the question line and options numbered 1..n', () => {
    const noQuestion = screen('63-perm-bash-tall-overflow').replace(' Do you want to proceed?', ' Do you want to proceed');
    expect(readPromptScreen(noQuestion, permExpect(CMD63))).toEqual({ match: false, why: 'no_question_line_above_options' });
    const gap = screen('63-perm-bash-tall-overflow').replace(/^ {3}3\. No$/m, '   4. No');
    expect(readPromptScreen(gap, permExpect(CMD63))).toEqual({ match: false, why: 'option_numbers_not_sequential' });
  });
});

// Coordinator ruling (2026-09-18): with the whole dialog on screen, the
// hook's command must EQUAL the dialog's command -- not merely appear
// somewhere in the block, where a short anchor could hit a longer command,
// the description, or an option label. The command region runs from under
// the header to the description line: the hook's description, or "Run shell
// command" when the hook has none (measured: events 47761/59737 carry none
// and fixtures 50/52 show that line; 92658/99734 carry one and 71/73 show
// it). These screens are fixture 50 with its command and description lines
// replaced.
describe('readPromptScreen -- the Bash anchor must equal the dialog\'s command', () => {
  const COMMAND_AND_DESC = /^ {3}touch perm-probe\.txt\n {3}Run shell command$/m;
  const dialog50 = (command: string[], description = 'Run shell command') => {
    expect(screen('50-perm-bash-dialog')).toMatch(COMMAND_AND_DESC);
    return screen('50-perm-bash-dialog').replace(COMMAND_AND_DESC, [...command, description].map(l => `   ${l}`).join('\n'));
  };

  it('a card for "touch a" does not match a dialog whose command is "rm -rf ~; touch a"', () => {
    expect(readPromptScreen(dialog50(['touch a']), permExpect('touch a')).match).toBe(true);
    expect(readPromptScreen(dialog50(['rm -rf ~; touch a']), permExpect('touch a')))
      .toEqual({ match: false, why: 'anchor_not_found' });
  });

  it('a card for "ls" does not match a dialog that merely has "tools" in its description', () => {
    const capture = dialog50(['touch perm-probe.txt'], 'Check the tools folder');
    expect(readPromptScreen(capture, permExpect('touch perm-probe.txt', 'Bash', 'Check the tools folder')).match).toBe(true);
    expect(readPromptScreen(capture, permExpect('ls', 'Bash', 'Check the tools folder')))
      .toEqual({ match: false, why: 'anchor_not_found' });
  });

  it('an anchor found only in an option label does not match', () => {
    expect(readPromptScreen(screen('50-perm-bash-dialog'), permExpect('always allow access to')))
      .toEqual({ match: false, why: 'anchor_not_found' });
  });

  it('the description starts on its own line -- a command cannot borrow the start of it', () => {
    // Both read "echo;rm-rf~Print" once whitespace is gone.
    expect(readPromptScreen(dialog50(['echo; rm -rf ~'], 'Print'), permExpect('echo', 'Bash', '; rm -rf ~ Print')).match)
      .toBe(false);
  });

  it('the dialog\'s description must be the hook\'s (71 read without it expects "Run shell command")', () => {
    expect(readPromptScreen(screen('71-s2-bash-dialog'), permExpect('touch perm-probe-always.txt')))
      .toEqual({ match: false, why: 'anchor_not_found' });
    expect(readPromptScreen(screen('71-s2-bash-dialog'),
      permExpect('touch perm-probe-always.txt', 'Bash', 'Create empty file perm-probe-always.txt')).match).toBe(true);
  });

  it('a description wrapped onto a second line still matches', () => {
    const capture = screen('71-s2-bash-dialog').replace('   Create empty file perm-probe-always.txt', '   Create empty file\n   perm-probe-always.txt');
    expect(capture).not.toBe(screen('71-s2-bash-dialog'));
    expect(readPromptScreen(capture,
      permExpect('touch perm-probe-always.txt', 'Bash', 'Create empty file perm-probe-always.txt')).match).toBe(true);
  });

  it.each([
    ['50-perm-bash-dialog', 'touch perm-probe.txt'],
    ['52-perm-bash2-cursor-no', 'touch perm-probe-no.txt'],
    ['53-perm-bash2-tab-on-no', 'touch perm-probe-no.txt'],
    ['54-perm-bash2-typed-feedback', 'touch perm-probe-no.txt'],
    ['57-perm-bash4-edited-dialog', 'touch perm-probe.txt'],
    ['58-perm-bash4-edited-tab-on-no', 'touch perm-probe.txt'],
  ])('%s still matches its own command', (file, anchor) => {
    expect(readPromptScreen(screen(file), permExpect(anchor)).match).toBe(true);
  });

  it('the Write dialog (60) still matches on the file basename', () => {
    expect(readPromptScreen(screen('60-perm-write-dialog'), permExpect('write-probe.txt', 'Write')).match).toBe(true);
  });
});

// Final review: a reviewer-supplied capture showed that a crafted Bash
// command's own previewed text can contain lines shaped like dialog options
// -- "# Proceed?" and "4. No, and tell Claude what to do differently" --
// ahead of the real numbered options, so parseDialogChoices parses a FAKE
// row at key 4 before the real four-option dialog (No at key 4, same shape
// as fixture 57), giving parsed keys [4,1,2,3,4]. computeTextRow's `find`
// takes the FIRST row with a given key, so on the real dialog it would read
// the fake row's label in place of the true No row's. The dialog read must
// refuse any block whose numbers are not exactly 1..n in order with no
// repeats. Built from fixture 50 by the same string-replacement convention
// `withCommand` above uses: the command line gains the fake preview lines,
// and option 3 ("No") is split into a real option 3 and a real "No" at 4.
describe('readPromptScreen -- refuses option numbers that are not exactly 1..n in order', () => {
  const crafted = screen('50-perm-bash-dialog')
    .replace(/^ {3}touch perm-probe\.txt$/m, [
      '   touch perm-probe.txt',
      '   # Proceed?',
      '   4. No, and tell Claude what to do differently',
      '',
    ].join('\n'))
    .replace(/^ {3}3\. No$/m, '   3. Yes, always allow this command\n   4. No');

  it('parses the crafted capture as keys [4,1,2,3,4] and refuses it', () => {
    // Sanity check on the fix itself would hide the shape being tested, so
    // this asserts only the outcome the fix must produce.
    expect(readPromptScreen(crafted, permExpect('touch perm-probe.txt')))
      .toEqual({ match: false, why: 'option_numbers_not_sequential' });
  });

  it('still matches the unmodified fixture 50 dialog (no regression)', () => {
    expect(readPromptScreen(screen('50-perm-bash-dialog'), permExpect('touch perm-probe.txt')).match).toBe(true);
  });
});

// Task 6 (by eye): a long path in an option wraps at the pane width, often
// right after a "-" or "/"; joining with a space showed "Documents- David-".
// These screens are fixture 50 with its option-2 path wrapped differently.
describe('readPromptScreen -- wrapped option labels', () => {
  const PATH = '/private/tmp/claude-502/-Users-user000000000-Documents-David-llm-workspace/05ca161a-0ae7-4978-8680-b333894fe577/scratchpad/p4probe';
  const label2 = (capture: string) => {
    const result = readPromptScreen(capture, permExpect('touch perm-probe.txt'));
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    return result.choices[1]!.label;
  };
  const rewrap = (at: string) => {
    const capture = screen('50-perm-bash-dialog').replace(at, `${at}\n     `);
    expect(capture).not.toBe(screen('50-perm-bash-dialog'));
    return capture;
  };

  it('fixture 50 as captured: the space after "to" stays', () => {
    expect(label2(screen('50-perm-bash-dialog'))).toBe(`Yes, and always allow access to ${PATH} from this project`);
  });

  it('adds no space when the wrapped part ends with "-"', () => {
    expect(label2(rewrap('-Documents-'))).toBe(`Yes, and always allow access to ${PATH} from this project`);
  });

  it('adds no space when the wrapped part ends with "/"', () => {
    expect(label2(rewrap('/tmp/claude-502/'))).toBe(`Yes, and always allow access to ${PATH} from this project`);
  });

  it('keeps the space after a dash or slash that stands alone as a word', () => {
    const capture = screen('50-perm-bash-dialog').replace(
      /^ {3}2\. Yes, and always allow access to$/m, '   2. Yes, and always allow access to a -');
    expect(label2(capture)).toBe(`Yes, and always allow access to a - ${PATH} from this project`);
  });
});

// Final review M12: the text-taking row is found by its label, not by
// being option 3 -- a dialog with a different number of options must never
// mark a Yes row as the one that takes text.
describe('readPromptScreen -- takesText follows the label', () => {
  const dialog = (options: string[], question = 'Do you want to proceed?') => [
    '────────────────────────────────────────',
    ' Bash command',
    '',
    '   touch perm-probe.txt',
    '   Run shell command',
    '',
    ` ${question}`,
    ...options.map((o, i) => `${i === 0 ? ' ❯' : '  '} ${i + 1}. ${o}`),
    '',
    ' Esc to cancel',
  ].join('\n');

  it('a two-option permission dialog: the No row takes text, the Yes row does not', () => {
    const result = readPromptScreen(dialog(['Yes', 'No']), permExpect('touch perm-probe.txt'));
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.choices.map(c => [c.key, c.takesText])).toEqual([['1', false], ['2', true]]);
  });

  it('a four-option permission dialog: only the No row takes text, not the third Yes', () => {
    const result = readPromptScreen(dialog([
      'Yes', 'Yes, allow all edits during this session', "Yes, and don't ask again for touch", 'No',
    ]), permExpect('touch perm-probe.txt'));
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    expect(result.choices.map(c => c.takesText)).toEqual([false, false, false, true]);
  });

  it('a four-option plan dialog: only the Tell Claude row takes text', () => {
    const result = readPromptScreen(dialog([
      'Yes, and auto-accept edits', 'Yes, and bypass permissions', 'Yes, manually approve edits', 'Tell Claude what to change',
    ], 'Would you like to proceed?'), planExpect());
    if (!result.match || result.kind !== 'plan') throw new Error('expected plan match');
    expect(result.choices.map(c => c.takesText)).toEqual([false, false, false, true]);
  });
});

// Task 6 (by eye): David's permission dialog has four options, with "No"
// at 4, so the text row is read wherever the takesText row is focused, not
// only at key 3. 57/58 are fixture 50 hand-edited: the auto-mode line
// inserted as option 3, No moved to 4 (58: cursor on 4, after Tab).
describe('readPromptScreen -- the text row at any key', () => {
  const bash4 = () => screen('57-perm-bash4-edited-dialog');
  const tab4 = () => screen('58-perm-bash4-edited-tab-on-no');
  const read = (capture: string) => {
    const result = readPromptScreen(capture, permExpect('touch perm-probe.txt'));
    if (!result.match || result.kind !== 'permission') throw new Error('expected permission match');
    return result;
  };
  const moveCursorTo = (capture: string, to: string) =>
    capture.replace(/^ ❯ 1\. /m, '   1. ').replace(new RegExp(`^   ${to}\\. `, 'm'), ` ❯ ${to}. `);

  it('reads four choices, only No (key 4) taking text, with no text row on key 1', () => {
    const result = read(bash4());
    expect(result.choices.map(c => [c.key, c.takesText])).toEqual([['1', false], ['2', false], ['3', false], ['4', true]]);
    expect(result.choices[2]!.label).toBe('Yes, and switch to auto mode · auto mode handles these prompts for you');
    expect(result.cursor).toBe('1');
    expect(result.textRow).toBeNull();
  });

  it('no text row with the cursor on the auto-mode row (key 3), nor on a plain No before Tab', () => {
    expect(read(moveCursorTo(bash4(), '3'))).toMatchObject({ cursor: '3', textRow: null });
    expect(read(moveCursorTo(bash4(), '4'))).toMatchObject({ cursor: '4', textRow: null });
  });

  it('reads an empty text row after Tab on No at key 4, and the typed text after that', () => {
    expect(read(tab4())).toMatchObject({ cursor: '4', textRow: '' });
    const typed = tab4().replace('4. No, and tell Claude what to do differently', '4. No, Skip it and reply NOPROBE');
    expect(read(typed)).toMatchObject({ cursor: '4', textRow: 'No, Skip it and reply NOPROBE' });
  });

  // Plan's typed feedback replaces the row's label, so its row is also known
  // by the "shift+tab to approve with this feedback" line under it.
  it('reads a plan text row at key 4, empty and typed', () => {
    const at4 = (capture: string) => capture.replace(
      /^( {3}2\. Yes, manually approve edits\n)( ❯| {2}) 3\. /m, '$1   3. Yes, and bypass permissions\n$2 4. ');
    const empty = at4(screen('81-plan-key3'));
    const typed = at4(screen('82-plan-typed-feedback'));
    expect(empty).not.toBe(screen('81-plan-key3'));
    expect(typed).not.toBe(screen('82-plan-typed-feedback'));
    expect(readPromptScreen(empty, planExpect())).toMatchObject({ match: true, cursor: '4', textRow: '' });
    expect(readPromptScreen(typed, planExpect()))
      .toMatchObject({ match: true, cursor: '4', textRow: 'Change the word to PLANFEEDBACK instead of hi' });
    const onYes = empty.replace(' ❯ 4. ', '   4. ').replace('   3. Yes, and bypass', ' ❯ 3. Yes, and bypass');
    expect(readPromptScreen(onYes, planExpect())).toMatchObject({ match: true, cursor: '3', textRow: null });
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

  // Final review M4: both sides are whitespace-normalised before the exact
  // match -- the hook's text can carry a newline or a double space that the
  // screen shows collapsed, and the screen can carry a run the hook lacks.
  it('matches a question whose hook text has a newline and a double space the screen does not', () => {
    const capture = [
      '←  ☐ Auth  ☐ Region  ✔ Submit  →',
      '',
      'Which login provider',
      'should we use?',
      '',
      '❯ 1. Google',
      '  2. GitHub',
      '  3. Type something.',
      '',
    ].join('\n');
    const result = readPromptScreen(
      capture,
      askExpect(['Auth', 'Region'], ['Which login provider\nshould we  use?', 'Which region?']),
    );
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
  });

  it('matches a question whose screen line has a whitespace run the hook text does not', () => {
    const capture = screen('10-ask-q1').replace(/^Which color\?$/m, 'Which   color?');
    expect(capture).toContain('\nWhich   color?\n');
    const result = readPromptScreen(capture, askExpect());
    expect(result.match).toBe(true);
  });

  it('16-ask-left-back still finds current 0 by matching the question text', () => {
    const result = readPromptScreen(screen('16-ask-left-back'), askExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
  });
});

// Task 6 (by eye): a single single-select question shows no tab row at
// all -- only its header chip under the rule (" ☐ Next step"), then the
// question, the options, "Type something.", a rule and "Chat about this".
// A digit answers it at once, with no review screen (97).
describe('readPromptScreen -- one-question layout (header line, no tab row)', () => {
  const ONE_Q = 'Should I create qa-7.txt with the current timestamp now?';
  const oneExpect = (header = 'Next step', question = ONE_Q): ScreenExpect =>
    ({ kind: 'question', headers: [header], questions: [question] });

  it('matches 96 on its header line, with the options and nothing answered', () => {
    const result = readPromptScreen(screen('96-ask-one-question'), oneExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
    expect(result.answered).toEqual([false]);
    expect(result.options).toEqual(['Yes, create it', 'No, stop here', 'Plan it first']);
    expect(result.headerOnly).toBe(true);
  });

  it('marks a tab-row read as not header-only', () => {
    const result = readPromptScreen(screen('10-ask-q1'), askExpect());
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.headerOnly).toBeUndefined();
  });

  it('rejects 96 when the header differs from the hook header', () => {
    expect(readPromptScreen(screen('96-ask-one-question'), oneExpect('Next steps'))).toEqual(
      { match: false, why: 'headers_mismatch' });
  });

  it('rejects 96 when the question text differs', () => {
    expect(readPromptScreen(screen('96-ask-one-question'), oneExpect('Next step', 'Should I create qa-8.txt now?')).match)
      .toBe(false);
  });

  it('rejects 96 for a two-question expectation: the header line alone is only ever one question', () => {
    const result = readPromptScreen(screen('96-ask-one-question'),
      askExpect(['Next step', 'Other'], [ONE_Q, 'Which other?']));
    expect(result).toEqual({ match: false, why: 'no_tab_row_on_screen' });
  });

  it('does not take a header-like line that is not directly under a rule', () => {
    const capture = screen('96-ask-one-question').replace(/^─+\n( ☐ Next step)$/m, '\n$1');
    expect(capture).not.toBe(screen('96-ask-one-question'));
    expect(readPromptScreen(capture, oneExpect())).toEqual({ match: false, why: 'no_tab_row_on_screen' });
  });

  it('reads 97 (after key 2) as the dialog gone -- the same "why" the answer path counts as gone', () => {
    expect(readPromptScreen(screen('97-ask-one-after-key2'), oneExpect()))
      .toEqual({ match: false, why: 'no_tab_row_on_screen' });
  });

  it('a multi-question screen never matches a one-question expectation', () => {
    expect(readPromptScreen(screen('10-ask-q1'), oneExpect('Color', 'Which color?'))).toEqual(
      { match: false, why: 'headers_mismatch' });
  });
});

// Measured today: a long one-question title wraps, and Claude Code draws
// each wrapped line with a left border prefix "│ " (fixture 98). Short
// titles (96) have no border at all -- both forms must match.
describe('readPromptScreen -- wrapped question title with a border prefix', () => {
  const WRAPPED_Q = "Test question: please try answering this one from the app's card first (any option), "
    + 'then answer here in the terminal if it says Couldn\'t confirm. Which should I do after this fix?';
  const wrappedExpect = (question = WRAPPED_Q): ScreenExpect =>
    ({ kind: 'question', headers: ['Next'], questions: [question] });

  it('matches 98 with current 0 and the options from the payload', () => {
    const result = readPromptScreen(screen('98-ask-one-wrapped-title'), wrappedExpect());
    expect(result.match).toBe(true);
    if (!result.match || result.kind !== 'question') throw new Error('expected question match');
    expect(result.current).toBe(0);
    expect(result.answered).toEqual([false]);
    expect(result.options).toEqual(['Preview-question fix', 'Context chip', 'Both, in that order']);
    expect(result.headerOnly).toBe(true);
  });

  it('a title with a "│" line whose text differs still gives match:false', () => {
    const result = readPromptScreen(
      screen('98-ask-one-wrapped-title'),
      wrappedExpect('Test question: this is not the text on screen at all?'),
    );
    expect(result.match).toBe(false);
  });

  it('fixture 96 (a short, unbordered title) still matches', () => {
    const result = readPromptScreen(
      screen('96-ask-one-question'),
      { kind: 'question', headers: ['Next step'], questions: ['Should I create qa-7.txt with the current timestamp now?'] },
    );
    expect(result.match).toBe(true);
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

  // The one-question form is looser than the tab row (a single header
  // line), so it is proven against the same screens, plus 97.
  it.each([...rejectEverywhere, '97-ask-one-after-key2', '10-ask-q1'])(
    '%s matches no one-question expectation', (file) => {
      const capture = screen(file);
      expect(readPromptScreen(capture, askExpect(['Color'], ['Which color?'])).match).toBe(false);
      expect(readPromptScreen(capture, askExpect(['Next step'], ['Should I create qa-7.txt with the current timestamp now?'])).match)
        .toBe(false);
    });
});
