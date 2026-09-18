import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import {
  answerPrompt, buildPromptView, validateAnswer, clearPromptCache, type AnswerDeps,
} from '../../src/main/answer.ts';
import { registerSession, clearRegistry } from '../../src/main/sessions.ts';
import type { TmuxResult } from '../../src/main/tmux.ts';
import type { PromptView } from '../../src/core/prompt.ts';
import type { SignalEvent } from '../../src/store/signals.ts';

// Quick answers design §6-7, §11. Fixtures are the real 2026-09-17
// measurement: hook payloads under events/, pane captures under screens/.

const SCREENS = new URL('../fixtures/quick-answers/screens/', import.meta.url);
const EVENTS = new URL('../fixtures/quick-answers/events/', import.meta.url);

function screen(name: string): string {
  return readFileSync(new URL(`${name}.txt`, SCREENS), 'utf8');
}

function event(file: string, eventId = `ev-${file}`): SignalEvent {
  const payload = JSON.parse(readFileSync(new URL(file, EVENTS), 'utf8')) as Record<string, unknown>;
  return {
    eventId, occurredAt: '2026-09-17T21:39:00.000Z', sessionId: String(payload.session_id),
    promptId: String(payload.prompt_id), toolUseId: null, kind: 'PermissionRequest', payload,
  };
}

const ASK = '1789706218.842-PermissionRequest-89928.json'; // Color (single) + Pets (multi)
const BASH_YES = '1789706414.213-PermissionRequest-47761.json'; // touch perm-probe.txt
const BASH_NO = '1789706452.876-PermissionRequest-59737.json'; // touch perm-probe-no.txt
const WRITE = '1789706505.037-PermissionRequest-74696.json'; // write-probe.txt
const PLAN = '1789706627.132-PermissionRequest-11033.json'; // plan with "hi"

const PID = 4242;
const NAME = 'llmws-claude-t3';

type Call = string[];

/** A fake pane. `capture` answers capture-pane with screens[n], where n is
 *  the number of keys sent so far (capped at the last screen), and answers
 *  the copy-mode query (display-message) with `inMode`. Every outbound call
 *  is recorded, so a refusal test can prove zero keys went out. */
function fakePane(screens: string[], opts: { inMode?: boolean } = {}) {
  const sent: Call[] = [];
  const captures: Call[] = [];
  const send = (args: string[]): TmuxResult => { sent.push(args); return { ok: true, stdout: '' }; };
  const capture = (args: string[]): TmuxResult => {
    captures.push(args);
    if (args[0] === 'display-message') return { ok: true, stdout: opts.inMode ? '1\n' : '0\n' };
    const keys = sent.filter(a => !a.includes('-X')).length;
    return { ok: true, stdout: screens[Math.min(keys, screens.length - 1)] ?? '' };
  };
  /** What reached Claude: the key name, or the literal text for -l. */
  const keys = () => sent.filter(a => !a.includes('-X')).map(a => a[a.length - 1]);
  return { sent, captures, send, capture, keys };
}

function deps(pane: ReturnType<typeof fakePane>, view: PromptView | null, extra: Partial<AnswerDeps> = {}): AnswerDeps {
  return {
    send: pane.send, capture: pane.capture, sleep: async () => {}, has: () => true,
    currentPrompt: () => view, ...extra,
  };
}

/** The view main would build for `file` with the pane showing `first`. */
function viewFor(file: string, first: string): PromptView {
  const view = buildPromptView(event(file), NAME, { capture: () => ({ ok: true, stdout: first }) });
  if (!view.answerable) throw new Error(`fixture view not answerable: ${view.reason}`);
  return view;
}

/** Moves the ❯ cursor between two numbered rows of a dialog screen -- used
 *  only to make the "cursor on 1" and "cursor on 2" frames that precede
 *  fixture 52 (cursor already on 3), which the measurement did not save. */
function moveCursor(text: string, from: string, to: string): string {
  return text
    .replace(new RegExp(`^ ❯ ${from}\\. `, 'm'), `   ${from}. `)
    .replace(new RegExp(`^   ${to}\\. `, 'm'), ` ❯ ${to}. `);
}

/** A hand-built question screen in fixture 10's layout -- used where the
 *  measurement saved no capture (one-question and all-single-select
 *  dialogs). */
function askScreen(tabs: string, question: string, options: string[]): string {
  return [
    tabs, '', question, '',
    ...options.flatMap((o, i) => [`${i === 0 ? '❯' : ' '} ${i + 1}. ${o}`, `     Option ${o}`]),
    `  ${options.length + 1}. Type something.`, '', `  ${options.length + 2}. Chat about this`, '',
  ].join('\n');
}

/** The one-question "Pick one?" prompt (event 1789706748.472). */
function oneQuestionScreen(): string {
  return askScreen('←  ☐ Pick  ✔ Submit  →', 'Pick one?', ['A', 'B', 'C']);
}

afterEach(() => {
  clearRegistry();
  clearPromptCache();
  vi.restoreAllMocks();
});

function registered(): void {
  registerSession(PID, NAME);
}

describe('buildPromptView', () => {
  it('builds a question view from the hook payload alone, without reading the screen', () => {
    const capture = vi.fn();
    const view = buildPromptView(event(ASK, 'e1'), NAME, { capture });
    expect(capture).not.toHaveBeenCalled();
    expect(view).toMatchObject({ id: 'e1', kind: 'question', answerable: true, reason: null });
    expect(view.questions).toEqual([
      {
        question: 'Which color?', header: 'Color', multiSelect: false,
        options: [
          { label: 'Red', description: 'A warm, bold primary color' },
          { label: 'Green', description: 'A cool, natural secondary color' },
          { label: 'Blue', description: 'A calming, cool primary color' },
        ],
      },
      expect.objectContaining({ question: 'Which pets?', header: 'Pets', multiSelect: true }),
    ]);
    expect(view.choices).toBeUndefined();
  });

  it('builds a Bash permission view: content from the hook, choices from the screen', () => {
    const view = buildPromptView(event(BASH_YES, 'e2'), NAME, { capture: () => ({ ok: true, stdout: screen('50-perm-bash-dialog') }) });
    expect(view).toMatchObject({
      id: 'e2', kind: 'permission', answerable: true, reason: null, toolName: 'Bash', command: 'touch perm-probe.txt',
    });
    expect(view.choices?.map(c => c.key)).toEqual(['1', '2', '3']);
    expect(view.choices?.[2]).toEqual({ key: '3', label: 'No', takesText: true });
  });

  it('builds a Write permission view anchored on the file basename', () => {
    const view = buildPromptView(event(WRITE), NAME, { capture: () => ({ ok: true, stdout: screen('60-perm-write-dialog') }) });
    expect(view).toMatchObject({ kind: 'permission', answerable: true, toolName: 'Write' });
    expect(view.filePath).toMatch(/\/write-probe\.txt$/);
    expect(view.choices?.[1]?.label).toMatch(/^Yes, and switch to accept edits/);
  });

  it('builds a plan view with the plan markdown and the screen choices', () => {
    const view = buildPromptView(event(PLAN), NAME, { capture: () => ({ ok: true, stdout: screen('80-plan-dialog') }) });
    expect(view).toMatchObject({ kind: 'plan', answerable: true });
    expect(view.plan).toMatch(/^# Context/);
    expect(view.choices?.map(c => c.takesText)).toEqual([false, false, true]);
  });

  it('copies strings only from tool_input and drops anything else', () => {
    const ev = event(BASH_YES);
    ev.payload = { tool_name: 'Bash', tool_input: { command: 42, description: { html: '<b>' }, file_path: ['x'] } };
    const view = buildPromptView(ev, null, {});
    expect(view.command).toBeUndefined();
    expect(view.description).toBeUndefined();
    expect(view.filePath).toBeUndefined();
    expect(view.toolName).toBe('Bash');
  });

  it('is read-only with not_tmux for a session the app did not launch, and reads no screen', () => {
    const capture = vi.fn();
    const view = buildPromptView(event(BASH_YES), null, { capture });
    expect(view).toMatchObject({ answerable: false, reason: 'not_tmux', command: 'touch perm-probe.txt' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('is read-only with screen_unread when the capture does not show the dialog, and tries again next time', () => {
    const ev = event(BASH_YES, 'e-retry');
    const bad = vi.fn(() => ({ ok: true as const, stdout: screen('51-perm-bash-after-1') }));
    expect(buildPromptView(ev, NAME, { capture: bad })).toMatchObject({ answerable: false, reason: 'screen_unread' });
    expect(bad).toHaveBeenCalledTimes(1); // one capture per build, no retry loop inside a push

    const good = vi.fn(() => ({ ok: true as const, stdout: screen('50-perm-bash-dialog') }));
    expect(buildPromptView(ev, NAME, { capture: good })).toMatchObject({ answerable: true });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('caches a successful read by event id, so later builds read no screen', () => {
    const ev = event(BASH_YES, 'e-cache');
    buildPromptView(ev, NAME, { capture: () => ({ ok: true, stdout: screen('50-perm-bash-dialog') }) });
    const later = vi.fn(() => ({ ok: true as const, stdout: screen('51-perm-bash-after-1') }));
    const view = buildPromptView(ev, NAME, { capture: later });
    expect(later).not.toHaveBeenCalled();
    expect(view.choices?.map(c => c.key)).toEqual(['1', '2', '3']);
  });

  it('caps the cache at 50 prompts, dropping the oldest', () => {
    const dialog = () => ({ ok: true as const, stdout: screen('50-perm-bash-dialog') });
    for (let i = 0; i < 51; i++) buildPromptView(event(BASH_YES, `cap-${i}`), NAME, { capture: dialog });
    const again = vi.fn(dialog);
    buildPromptView(event(BASH_YES, 'cap-50'), NAME, { capture: again });
    expect(again).not.toHaveBeenCalled();
    buildPromptView(event(BASH_YES, 'cap-0'), NAME, { capture: again });
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('does not throw on a payload that is not an object', () => {
    const ev = event(BASH_YES);
    (ev as { payload: unknown }).payload = null;
    const view = buildPromptView(ev, NAME, { capture: () => ({ ok: true, stdout: screen('50-perm-bash-dialog') }) });
    expect(view).toMatchObject({ kind: 'permission', answerable: false, reason: 'screen_unread', toolName: '' });
  });

  it('reads a long Bash command that wraps across lines on screen', () => {
    const ev = event(BASH_YES);
    const long = 'npm run build -- --filter=@acme/some-really-long-package-name && npm test -- --coverage --reporter=verbose';
    ev.payload = { tool_name: 'Bash', tool_input: { command: long } };
    const capture = screen('50-perm-bash-dialog').replace(/^ {3}touch perm-probe\.txt$/m,
      '   npm run build -- --filter=@acme/some-really-long-package-name && npm test -- --cov\n   erage --reporter=verbose');
    const view = buildPromptView(ev, NAME, { capture: () => ({ ok: true, stdout: capture }) });
    expect(view).toMatchObject({ answerable: true, command: long });
  });

  it('never treats an empty anchor as a match', () => {
    const ev = event(BASH_YES);
    ev.payload = { tool_name: '', tool_input: {} };
    const view = buildPromptView(ev, NAME, { capture: () => ({ ok: true, stdout: screen('50-perm-bash-dialog') }) });
    expect(view).toMatchObject({ answerable: false, reason: 'screen_unread' });
  });
});

describe('answerPrompt guards -- each refusal presses nothing', () => {
  const bashView = () => viewFor(BASH_YES, screen('50-perm-bash-dialog'));
  // Every refusal logs by design; muted so the run's output stays clean.
  // Restored by the file-level vi.restoreAllMocks().
  let errors: MockInstance;
  beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}); });

  async function refusedWith(
    view: PromptView | null, pid: unknown, promptId: unknown, answer: unknown, reason: string,
    screens = [screen('50-perm-bash-dialog')], extra: Partial<AnswerDeps> = {},
  ) {
    const pane = fakePane(screens);
    const result = await answerPrompt(pid, promptId, answer, deps(pane, view, extra));
    expect(result).toEqual({ status: 'refused', reason });
    expect(pane.sent).toEqual([]);
    return pane;
  }

  it.each([0, -1, 1.5, '4242', null, undefined, Number.NaN])('invalid_pid for %s', async (pid) => {
    const view = bashView();
    await refusedWith(view, pid, view.id, { kind: 'choice', key: '1' }, 'invalid_pid');
  });

  it('not_tmux for a pid the app never registered', async () => {
    const view = bashView();
    await refusedWith(view, PID, view.id, { kind: 'choice', key: '1' }, 'not_tmux');
  });

  it('session_gone when the registered tmux session no longer exists', async () => {
    registered();
    const view = bashView();
    await refusedWith(view, PID, view.id, { kind: 'choice', key: '1' }, 'session_gone', undefined, { has: () => false });
  });

  it('stale when the prompt id is not the one main re-derives', async () => {
    registered();
    const view = bashView();
    await refusedWith(view, PID, 'some-older-prompt', { kind: 'choice', key: '1' }, 'stale');
    await refusedWith(view, PID, 42, { kind: 'choice', key: '1' }, 'stale');
  });

  it('stale when no prompt is open any more', async () => {
    registered();
    await refusedWith(null, PID, 'ev-x', { kind: 'choice', key: '1' }, 'stale');
  });

  it('unconfirmed when the open prompt could not be read from the screen', async () => {
    registered();
    const view: PromptView = { id: 'e-unread', kind: 'permission', answerable: false, reason: 'screen_unread', command: 'x' };
    await refusedWith(view, PID, 'e-unread', { kind: 'choice', key: '1' }, 'unconfirmed');
  });

  describe('invalid', () => {
    const tooLong = 'a'.repeat(2001);
    it.each([
      ['a key not among the choices', { kind: 'choice', key: '4' }],
      ['a key name instead of a digit', { kind: 'choice', key: 'Enter' }],
      ['choice_text on a key that takes no text', { kind: 'choice_text', key: '1', text: 'hi' }],
      ['text with a newline', { kind: 'choice_text', key: '3', text: 'first\nsecond' }],
      ['text with a carriage return', { kind: 'choice_text', key: '3', text: 'first\rsecond' }],
      ['text with an escape', { kind: 'choice_text', key: '3', text: 'bad\x1b[201~' }],
      ['empty text', { kind: 'choice_text', key: '3', text: '' }],
      ['whitespace-only text', { kind: 'choice_text', key: '3', text: '   ' }],
      ['2001 characters of text', { kind: 'choice_text', key: '3', text: tooLong }],
      ['text that is not a string', { kind: 'choice_text', key: '3', text: 7 }],
      ['question picks on a permission prompt', { kind: 'questions', picks: [{ options: [0] }] }],
      ['chat on a permission prompt', { kind: 'chat' }],
      ['an unknown kind', { kind: 'allow_all' }],
      ['not an object', 'yes'],
      ['null', null],
    ])('%s', async (_label, answer) => {
      registered();
      const view = bashView();
      await refusedWith(view, PID, view.id, answer, 'invalid');
    });

    const askView = () => viewFor(ASK, screen('10-ask-q1'));
    it.each([
      ['a single-select question with two picks', [{ options: [0, 1] }, { options: [0] }]],
      ['a single-select question with an option and other', [{ options: [0], other: 'x' }, { options: [0] }]],
      ['a single-select question with nothing picked', [{ options: [] }, { options: [0] }]],
      ['an index out of range', [{ options: [3] }, { options: [0] }]],
      ['a negative index', [{ options: [-1] }, { options: [0] }]],
      ['a fractional index', [{ options: [0.5] }, { options: [0] }]],
      ['a multi-select question with nothing picked', [{ options: [0] }, { options: [] }]],
      ['a multi-select question with the same option twice', [{ options: [0] }, { options: [1, 1] }]],
      // Ruling B: the multi-select free-text key sequence was never
      // measured, so it is refused before any key rather than guessed.
      ['a multi-select question carrying other', [{ options: [0] }, { options: [1], other: 'Parrot' }]],
      ['fewer picks than questions', [{ options: [0] }]],
      ['more picks than questions', [{ options: [0] }, { options: [0] }, { options: [0] }]],
      ['other with a newline', [{ options: [], other: 'a\nb' }, { options: [0] }]],
      ['a pick that is not an object', ['0', { options: [0] }]],
    ])('%s', async (_label, picks) => {
      registered();
      const view = askView();
      await refusedWith(view, PID, view.id, { kind: 'questions', picks }, 'invalid', [screen('10-ask-q1')]);
    });

    // Controller ruling: a plain No is allowed on a permission prompt (see
    // the sequence below), but plan option 3 is only ever feedback text.
    it('choice on the plan\'s takesText key', async () => {
      registered();
      const view = viewFor(PLAN, screen('80-plan-dialog'));
      await refusedWith(view, PID, view.id, { kind: 'choice', key: '3' }, 'invalid', [screen('80-plan-dialog')]);
    });

    it('choice on a question prompt', async () => {
      registered();
      const view = askView();
      await refusedWith(view, PID, view.id, { kind: 'choice', key: '1' }, 'invalid', [screen('10-ask-q1')]);
    });

    // Task 6: text is allowed on the takesText row at any key, but never
    // on another row -- here the four-option dialog's auto-mode row, key 3.
    it('choice_text on a four-option dialog\'s auto-mode row (key 3)', async () => {
      registered();
      const view = viewFor(BASH_YES, screen('57-perm-bash4-edited-dialog'));
      await refusedWith(view, PID, view.id, { kind: 'choice_text', key: '3', text: 'use npm instead' }, 'invalid',
        [screen('57-perm-bash4-edited-dialog')]);
    });
  });

  it('busy while an answer for the same pid is still in flight', async () => {
    registered();
    const view = viewFor(ASK, screen('10-ask-q1'));
    // The pane never moves past the first question, so the first call sits
    // in its settle wait -- on a sleep that has not resolved yet.
    const pane = fakePane([screen('10-ask-q1')]);
    let release: () => void = () => {};
    const sleep = vi.fn(() => new Promise<void>(r => { release = r; }));
    const answer = { kind: 'questions', picks: [{ options: [2] }, { options: [0] }] };
    const first = answerPrompt(PID, view.id, answer, deps(pane, view, { sleep }));
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    const sentBefore = pane.sent.length;

    const second = await answerPrompt(PID, view.id, answer, deps(pane, view));
    expect(second).toEqual({ status: 'refused', reason: 'busy' });
    expect(pane.sent.length).toBe(sentBefore);

    // Let the first call run out; it gives up without pressing more.
    sleep.mockImplementation(async () => {});
    release();
    expect(await first).toEqual({ status: 'refused', reason: 'unconfirmed_partial' });

    // Once it has finished, the pid is free again (cleared in finally).
    const pane2 = fakePane([screen('50-perm-bash-dialog'), screen('51-perm-bash-after-1')]);
    const bash = viewFor(BASH_YES, screen('50-perm-bash-dialog'));
    expect(await answerPrompt(PID, bash.id, { kind: 'choice', key: '1' }, deps(pane2, bash))).toEqual({ status: 'sent' });
  });

  it('unconfirmed when the capture does not show the prompt', async () => {
    registered();
    const view = bashView();
    await refusedWith(view, PID, view.id, { kind: 'choice', key: '1' }, 'unconfirmed', [screen('51-perm-bash-after-1')]);
  });

  it('unconfirmed when the screen shows a different command', async () => {
    registered();
    const view = bashView();
    await refusedWith(view, PID, view.id, { kind: 'choice', key: '1' }, 'unconfirmed', [screen('52-perm-bash2-cursor-no')]);
  });

  it('unconfirmed when the screen choices differ from the cached ones', async () => {
    registered();
    const view = bashView();
    const changed = { ...view, choices: view.choices!.map(c => (c.key === '2' ? { ...c, label: 'Yes, always' } : c)) };
    await refusedWith(changed, PID, view.id, { kind: 'choice', key: '1' }, 'unconfirmed');
  });

  it('unconfirmed for a question answer when the dialog is not on its first, unanswered question', async () => {
    registered();
    const view = viewFor(ASK, screen('10-ask-q1'));
    await refusedWith(view, PID, view.id, { kind: 'questions', picks: [{ options: [2] }, { options: [0] }] },
      'unconfirmed', [screen('11-ask-after-key2')]);
  });

  it('unconfirmed for a question answer when the screen shows the review instead', async () => {
    registered();
    const view = viewFor(ASK, screen('10-ask-q1'));
    await refusedWith(view, PID, view.id, { kind: 'questions', picks: [{ options: [2] }, { options: [0] }] },
      'unconfirmed', [screen('19-ask-review')]);
  });

  it('logs the reason and prompt id, never the answer text', async () => {
    registered();
    const view = bashView();
    await refusedWith(view, PID, view.id, { kind: 'choice_text', key: '3', text: 'secret\nplan' }, 'invalid');
    expect(errors).toHaveBeenCalledWith('session:answer refused', { pid: PID, promptId: view.id, reason: 'invalid' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
  });
});

describe('answerPrompt key sequences, against a fake pane replaying fixture screens', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('Bash choice 1 sends exactly the digit', async () => {
    registered();
    const view = viewFor(BASH_YES, screen('50-perm-bash-dialog'));
    const pane = fakePane([screen('50-perm-bash-dialog'), screen('51-perm-bash-after-1')]);
    expect(await answerPrompt(PID, view.id, { kind: 'choice', key: '1' }, deps(pane, view))).toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['1']);
    expect(pane.sent[0]).toEqual(['send-keys', '-t', `=${NAME}:`, '1']);
  });

  // Controller ruling: a plain No is digit 3, which rejects directly
  // (measured: fixture 56-perm-bash3-key3, "Interrupted").
  it('Bash plain No sends exactly the digit 3', async () => {
    registered();
    const view = viewFor(BASH_YES, screen('50-perm-bash-dialog'));
    const pane = fakePane([screen('50-perm-bash-dialog'), screen('56-perm-bash3-key3')]);
    expect(await answerPrompt(PID, view.id, { kind: 'choice', key: '3' }, deps(pane, view))).toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['3']);
  });

  // Final review M2: the pane was resized after the prompt was read, so a
  // long choice label now wraps at a different point (mid-path). The
  // choices are the same; only where the reader joined lines differs.
  it('Bash choice 1 still sends when a long choice label re-wrapped since it was read', async () => {
    registered();
    const view = viewFor(BASH_YES, screen('50-perm-bash-dialog'));
    const rewrapped = screen('50-perm-bash-dialog').replace('claude-502/-Users', 'claude-502/\n      -Users');
    const pane = fakePane([rewrapped, screen('51-perm-bash-after-1')]);
    expect(await answerPrompt(PID, view.id, { kind: 'choice', key: '1' }, deps(pane, view))).toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['1']);
  });

  it('leaves copy-mode before checking the screen and pressing', async () => {
    registered();
    const view = viewFor(BASH_YES, screen('50-perm-bash-dialog'));
    const pane = fakePane([screen('50-perm-bash-dialog'), screen('51-perm-bash-after-1')], { inMode: true });
    expect(await answerPrompt(PID, view.id, { kind: 'choice', key: '1' }, deps(pane, view))).toEqual({ status: 'sent' });
    expect(pane.sent).toEqual([
      ['send-keys', '-t', `=${NAME}:`, '-X', 'cancel'],
      ['send-keys', '-t', `=${NAME}:`, '1'],
    ]);
  });

  it('Bash No with text: Down until the cursor is on 3, Tab, the text, then Enter once the row shows it', async () => {
    registered();
    const onNo = screen('52-perm-bash2-cursor-no');
    const on1 = moveCursor(onNo, '3', '1');
    const on2 = moveCursor(onNo, '3', '2');
    const view = viewFor(BASH_NO, on1);
    const pane = fakePane([on1, on2, onNo, screen('53-perm-bash2-tab-on-no'),
      screen('54-perm-bash2-typed-feedback'), screen('55-perm-bash2-after-no')]);
    const result = await answerPrompt(PID, view.id,
      { kind: 'choice_text', key: '3', text: 'Skip it and reply NOPROBE' }, deps(pane, view));
    expect(result).toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['Down', 'Down', 'Tab', 'Skip it and reply NOPROBE', 'Enter']);
    // Typed text goes only through send-keys -l, after "--" so a leading
    // "-" can never be read as a tmux option.
    expect(pane.sent[3]).toEqual(['send-keys', '-t', `=${NAME}:`, '-l', '--', 'Skip it and reply NOPROBE']);
  });

  // Hardening: if the row Down lands on already reads as an open text row
  // (textRow !== null) BEFORE this delivery has pressed Tab at all -- stale
  // state from an earlier attempt, or any other reason the screen already
  // shows "No, ..." -- pressing Tab and trusting the later empty-row match
  // would prove nothing (that match could just be re-observing the same
  // stale state, not something THIS Tab press caused). The fix stops right
  // there: no Tab, nothing typed.
  it('Bash No with text: refuses to press Tab when the row already reads as open (stale/faked state)', async () => {
    registered();
    const onNo = screen('52-perm-bash2-cursor-no');
    const on1 = moveCursor(onNo, '3', '1');
    const on2 = moveCursor(onNo, '3', '2');
    // Cursor lands on 3 already reading "No, and tell Claude what to do
    // differently" -- the amended/open label -- with no Tab pressed yet.
    const alreadyOpenAt3 = screen('53-perm-bash2-tab-on-no');
    const view = viewFor(BASH_NO, on1);
    const pane = fakePane([on1, on2, alreadyOpenAt3]);
    const result = await answerPrompt(PID, view.id,
      { kind: 'choice_text', key: '3', text: 'Skip it and reply NOPROBE' }, deps(pane, view));
    expect(result).toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
    expect(pane.keys()).toEqual(['Down', 'Down']);
  });

  // Task 6 (by eye): David's dialog has four options with No at 4. 57/58
  // are fixture 50 hand-edited (auto-mode row at 3, No at 4).
  describe('text on the takesText row at any key', () => {
    const bash4 = () => screen('57-perm-bash4-edited-dialog');
    const tab4 = () => screen('58-perm-bash4-edited-tab-on-no');
    const typed4 = (text: string) => tab4().replace('4. No, and tell Claude what to do differently', `4. No, ${text}`);
    const frames = () => [bash4(), moveCursor(bash4(), '1', '2'), moveCursor(bash4(), '1', '3'), moveCursor(bash4(), '1', '4')];

    it('No at key 4 with text: Down until the cursor is on 4, Tab, the text, then Enter once the row shows it', async () => {
      registered();
      const view = viewFor(BASH_YES, bash4());
      expect(view.choices?.map(c => [c.key, c.takesText])).toEqual([['1', false], ['2', false], ['3', false], ['4', true]]);
      const text = 'Skip it and reply NOPROBE';
      const pane = fakePane([...frames(), tab4(), typed4(text), screen('55-perm-bash2-after-no')]);
      expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '4', text }, deps(pane, view)))
        .toEqual({ status: 'sent' });
      expect(pane.keys()).toEqual(['Down', 'Down', 'Down', 'Tab', text, 'Enter']);
    });

    it('no Enter when the key-4 row shows different text', async () => {
      registered();
      const view = viewFor(BASH_YES, bash4());
      const pane = fakePane([...frames(), tab4(), typed4('Something else')]);
      expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '4', text: 'Skip it' }, deps(pane, view)))
        .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
      expect(pane.keys()).toEqual(['Down', 'Down', 'Down', 'Tab', 'Skip it']);
    });

    it('no text when Tab does not open the text row on key 4', async () => {
      registered();
      const view = viewFor(BASH_YES, bash4());
      const onNo = moveCursor(bash4(), '1', '4');
      const pane = fakePane([...frames(), onNo]);
      expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '4', text: 'Skip it' }, deps(pane, view)))
        .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
      expect(pane.keys()).toEqual(['Down', 'Down', 'Down', 'Tab']);
    });

    it('no Tab when a Down does not land where the screen says', async () => {
      registered();
      const view = viewFor(BASH_YES, bash4());
      // The cursor never moves off 1.
      const pane = fakePane([bash4()]);
      expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '4', text: 'Skip it' }, deps(pane, view)))
        .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
      expect(pane.keys()).toEqual(['Down']);
    });

    it('plain No at key 4 is its digit', async () => {
      registered();
      const view = viewFor(BASH_YES, bash4());
      const pane = fakePane([bash4(), screen('56-perm-bash3-key3')]);
      expect(await answerPrompt(PID, view.id, { kind: 'choice', key: '4' }, deps(pane, view))).toEqual({ status: 'sent' });
      expect(pane.keys()).toEqual(['4']);
    });

    it('plan feedback at key 4: 4, the text, then Enter once the row shows it', async () => {
      registered();
      // Inserts one extra Yes row at 3 and renumbers "Tell Claude" to 4.
      const at4 = (capture: string) => capture.replace(
        /^( {3}2\. Yes, manually approve edits\n)( ❯| {2}) 3\. /m, '$1   3. Yes, and bypass permissions\n$2 4. ');
      const dialog = at4(screen('80-plan-dialog'));
      const view = viewFor(PLAN, dialog);
      expect(view.choices?.map(c => [c.key, c.takesText])).toEqual([['1', false], ['2', false], ['3', false], ['4', true]]);
      const text = 'Change the word to PLANFEEDBACK instead of hi';
      const pane = fakePane([dialog, at4(screen('81-plan-key3')), at4(screen('82-plan-typed-feedback')), screen('83-plan-v2-dialog')]);
      expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '4', text }, deps(pane, view)))
        .toEqual({ status: 'sent' });
      expect(pane.keys()).toEqual(['4', text, 'Enter']);
    });
  });

  it('Plan feedback: 3, the text, then Enter once the row shows it', async () => {
    registered();
    const view = viewFor(PLAN, screen('80-plan-dialog'));
    const text = 'Change the word to PLANFEEDBACK instead of hi';
    const pane = fakePane([screen('80-plan-dialog'), screen('81-plan-key3'),
      screen('82-plan-typed-feedback'), screen('83-plan-v2-dialog')]);
    expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '3', text }, deps(pane, view)))
      .toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['3', text, 'Enter']);
  });

  it('Plan feedback: no Enter when the row is still empty, and the result is unconfirmed_partial', async () => {
    registered();
    const view = viewFor(PLAN, screen('80-plan-dialog'));
    const pane = fakePane([screen('80-plan-dialog'), screen('81-plan-key3'), screen('81-plan-key3')]);
    expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '3', text: 'Change the word' }, deps(pane, view)))
      .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
    expect(pane.keys()).toEqual(['3', 'Change the word']);
  });

  it('Bash No with text: no Enter when the row shows different text', async () => {
    registered();
    const onNo = screen('52-perm-bash2-cursor-no');
    const view = viewFor(BASH_NO, onNo);
    const pane = fakePane([onNo, screen('53-perm-bash2-tab-on-no'), screen('54-perm-bash2-typed-feedback')]);
    expect(await answerPrompt(PID, view.id, { kind: 'choice_text', key: '3', text: 'Something else' }, deps(pane, view)))
      .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
    expect(pane.keys()).toEqual(['Tab', 'Something else']);
  });

  it('Questions: 3, 3, 1, Right, then 1 only after the review matches', async () => {
    registered();
    const view = viewFor(ASK, screen('10-ask-q1'));
    const pane = fakePane([
      screen('10-ask-q1'), // Color current
      screen('11-ask-after-key2'), // Color answered, Pets current, nothing ticked
      screen('18-ask-multi-enter-on-cat'), // Fish ticked
      screen('13-ask-multi-after-3'), // Cat and Fish ticked
      screen('19-ask-review'), // Blue / Fish, Cat
      screen('20-ask-after-submit'),
    ]);
    const answer = { kind: 'questions', picks: [{ options: [2] }, { options: [2, 0] }] };
    expect(await answerPrompt(PID, view.id, answer, deps(pane, view))).toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['3', '3', '1', 'Right', '1']);
  });

  it('Questions: a review that differs from the card stops before the final 1', async () => {
    registered();
    const view = viewFor(ASK, screen('10-ask-q1'));
    const pane = fakePane([
      screen('10-ask-q1'), screen('11-ask-after-key2'), screen('18-ask-multi-enter-on-cat'),
      screen('13-ask-multi-after-3'),
      screen('39-ask2-review'), // Teal probe / Dog, Parrot probe -- not what the card sent
    ]);
    const answer = { kind: 'questions', picks: [{ options: [2] }, { options: [2, 0] }] };
    expect(await answerPrompt(PID, view.id, answer, deps(pane, view)))
      .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
    expect(pane.keys()).toEqual(['3', '3', '1', 'Right']);
  });

  it('Questions: single-select other is n+1, the text, then Enter once the row shows it', async () => {
    registered();
    const view = viewFor(ASK, screen('30-ask2-q1'));
    // After Dog alone is ticked: fixture 34 with "Type something" unticked
    // (the measurement ticked both). The review likewise shows Dog alone.
    const dogOnly = screen('34-ask2-multi-key4').replace('4. [✔] Type something', '4. [ ] Type something');
    const review = screen('39-ask2-review').replace('→ Dog, Parrot probe', '→ Dog');
    const pane = fakePane([
      screen('30-ask2-q1'), screen('31-ask2-key4'), screen('32-ask2-typed'), screen('33-ask2-q2'),
      dogOnly, review, screen('40-ask2-after-submit'),
    ]);
    const answer = { kind: 'questions', picks: [{ options: [], other: 'Teal probe' }, { options: [1] }] };
    expect(await answerPrompt(PID, view.id, answer, deps(pane, view))).toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['4', 'Teal probe', 'Enter', '2', 'Right', '1']);
  });

  it('Questions: no Enter after other when the row does not show the text', async () => {
    registered();
    const view = viewFor(ASK, screen('30-ask2-q1'));
    const pane = fakePane([screen('30-ask2-q1'), screen('31-ask2-key4'), screen('31-ask2-key4')]);
    const answer = { kind: 'questions', picks: [{ options: [], other: 'Teal probe' }, { options: [1] }] };
    expect(await answerPrompt(PID, view.id, answer, deps(pane, view)))
      .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
    expect(pane.keys()).toEqual(['4', 'Teal probe']);
  });

  it('Questions: a last single-select digit that closes the dialog counts as sent', async () => {
    registered();
    const pick = oneQuestionScreen();
    const view = viewFor('1789706748.472-PermissionRequest-48367.json', pick);
    const pane = fakePane([pick, screen('20-ask-after-submit')]);
    expect(await answerPrompt(PID, view.id, { kind: 'questions', picks: [{ options: [1] }] }, deps(pane, view)))
      .toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['2']);
  });

  it('Questions: a one-question dialog that closes for only one read is not counted as sent', async () => {
    registered();
    const pick = oneQuestionScreen();
    const view = viewFor('1789706748.472-PermissionRequest-48367.json', pick);
    // After the key: one read with the dialog gone, then the question again.
    const sent: string[][] = [];
    const afterKey = [screen('20-ask-after-submit'), pick];
    const capture = (args: string[]): TmuxResult => {
      if (args[0] === 'display-message') return { ok: true, stdout: '0\n' };
      if (sent.length === 0) return { ok: true, stdout: pick };
      return { ok: true, stdout: (afterKey.length > 1 ? afterKey.shift() : afterKey[0])! };
    };
    const send = (args: string[]): TmuxResult => { sent.push(args); return { ok: true, stdout: '' }; };
    const result = await answerPrompt(PID, view.id, { kind: 'questions', picks: [{ options: [1] }] },
      { send, capture, sleep: async () => {}, has: () => true, currentPrompt: () => view });
    expect(result).toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
    expect(sent.map(a => a[a.length - 1])).toEqual(['2']);
  });

  it('Questions: with two questions, a last pick that closes the dialog is unconfirmed_partial, not sent', async () => {
    registered();
    const ev = event(ASK, 'two-single');
    ev.payload = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'First one?', header: 'One', multiSelect: false,
            options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] },
          { question: 'Second one?', header: 'Two', multiSelect: false,
            options: [{ label: 'C', description: 'c' }, { label: 'D', description: 'd' }] },
        ],
      },
    };
    const q1 = askScreen('←  ☐ One  ☐ Two  ✔ Submit  →', 'First one?', ['A', 'B']);
    const q2 = askScreen('←  ☒ One  ☐ Two  ✔ Submit  →', 'Second one?', ['C', 'D']);
    const view = buildPromptView(ev, NAME, {});
    const pane = fakePane([q1, q2, screen('20-ask-after-submit')]);
    const result = await answerPrompt(PID, view.id, { kind: 'questions', picks: [{ options: [0] }, { options: [1] }] },
      deps(pane, view));
    expect(result).toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
    expect(pane.keys()).toEqual(['1', '2']);
  });

  // Task 6 (by eye): the measured one-question layout -- a header line, no
  // tab row -- where a digit answers at once and the dialog closes (97).
  describe('one question, measured layout (96 then 97)', () => {
    const oneQ = () => screen('96-ask-one-question');
    const gone = () => screen('97-ask-one-after-key2');
    function oneView(multiSelect = false): PromptView {
      const ev = event(ASK, 'one-q');
      const input = JSON.parse(readFileSync(new URL('one-question-tool_input.json', EVENTS), 'utf8')) as {
        questions: Record<string, unknown>[];
      };
      if (multiSelect) input.questions[0]!.multiSelect = true;
      ev.payload = { tool_name: 'AskUserQuestion', tool_input: input };
      return buildPromptView(ev, NAME, {});
    }
    /** 96 with the cursor on "Type something." and, once typed, the text in that row. */
    const onOther = (typed?: string) => oneQ()
      .replace('❯ 1. Yes, create it', '  1. Yes, create it')
      .replace('  4. Type something.', `❯ 4. ${typed ?? 'Type something.'}`);

    it('a digit answers it, and two reads with the dialog gone count as sent', async () => {
      registered();
      const view = oneView();
      const pane = fakePane([oneQ(), gone()]);
      expect(await answerPrompt(PID, view.id, { kind: 'questions', picks: [{ options: [1] }] }, deps(pane, view)))
        .toEqual({ status: 'sent' });
      expect(pane.keys()).toEqual(['2']);
    });

    it('one read with the dialog gone, then the question again, is not sent', async () => {
      registered();
      const view = oneView();
      const sent: string[][] = [];
      const afterKey = [gone(), oneQ()];
      const capture = (args: string[]): TmuxResult => {
        if (args[0] === 'display-message') return { ok: true, stdout: '0\n' };
        if (sent.length === 0) return { ok: true, stdout: oneQ() };
        return { ok: true, stdout: (afterKey.length > 1 ? afterKey.shift() : afterKey[0])! };
      };
      const send = (args: string[]): TmuxResult => { sent.push(args); return { ok: true, stdout: '' }; };
      const result = await answerPrompt(PID, view.id, { kind: 'questions', picks: [{ options: [1] }] },
        { send, capture, sleep: async () => {}, has: () => true, currentPrompt: () => view });
      expect(result).toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
      expect(sent.map(a => a[a.length - 1])).toEqual(['2']);
    });

    it('other: n+1, the text, Enter once the row shows it, then gone counts as sent', async () => {
      registered();
      const view = oneView();
      const pane = fakePane([oneQ(), onOther(), onOther('Only on Fridays'), gone()]);
      const answer = { kind: 'questions', picks: [{ options: [], other: 'Only on Fridays' }] };
      expect(await answerPrompt(PID, view.id, answer, deps(pane, view))).toEqual({ status: 'sent' });
      expect(pane.keys()).toEqual(['4', 'Only on Fridays', 'Enter']);
    });

    it('other: no Enter when the row does not show the text', async () => {
      registered();
      const view = oneView();
      const pane = fakePane([oneQ(), onOther(), onOther('Only on Mondays')]);
      const answer = { kind: 'questions', picks: [{ options: [], other: 'Only on Fridays' }] };
      expect(await answerPrompt(PID, view.id, answer, deps(pane, view)))
        .toEqual({ status: 'refused', reason: 'unconfirmed_partial' });
      expect(pane.keys()).toEqual(['4', 'Only on Fridays']);
    });

    it('Chat about this is digit 5 on the header-line layout too', async () => {
      registered();
      const view = oneView();
      const pane = fakePane([oneQ(), gone()]);
      expect(await answerPrompt(PID, view.id, { kind: 'chat' }, deps(pane, view))).toEqual({ status: 'sent' });
      expect(pane.keys()).toEqual(['5']);
    });

    // A one-question multi-select has not been measured; its toggles and
    // Right were only ever seen under a tab row. On the header-line layout
    // it is refused before any key rather than guessed.
    it('a multi-select question on the header-line layout is refused before any key', async () => {
      registered();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const view = oneView(true);
      const pane = fakePane([oneQ(), gone()]);
      expect(await answerPrompt(PID, view.id, { kind: 'questions', picks: [{ options: [0] }] }, deps(pane, view)))
        .toEqual({ status: 'refused', reason: 'unconfirmed' });
      expect(pane.sent).toEqual([]);
    });
  });

  it('Chat about this is digit n+2 of the current question', async () => {
    registered();
    const view = viewFor(ASK, screen('10-ask-q1'));
    const pane = fakePane([screen('10-ask-q1'), screen('41-ask3-key5-chat')]);
    expect(await answerPrompt(PID, view.id, { kind: 'chat' }, deps(pane, view))).toEqual({ status: 'sent' });
    expect(pane.keys()).toEqual(['5']);
  });
});

describe('validateAnswer', () => {
  it('returns a clean copy with the text trimmed, and drops unknown fields', () => {
    const view = viewFor(PLAN, screen('80-plan-dialog'));
    expect(validateAnswer(view, { kind: 'choice_text', key: '3', text: '  keep it short  ', extra: 1 }))
      .toEqual({ kind: 'choice_text', key: '3', text: 'keep it short' });
  });

  it('accepts exactly 2000 characters of text', () => {
    const view = viewFor(PLAN, screen('80-plan-dialog'));
    expect(validateAnswer(view, { kind: 'choice_text', key: '3', text: 'a'.repeat(2000) })).not.toBeNull();
  });
});
