import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import { PromptCard } from '../../src/renderer/components/PromptCard.tsx';
import type { PromptView } from '../../src/core/prompt.ts';

// Brief: .superpowers/sdd/2026-09-17-quick-answers/task-5-brief.md
// Spec: docs/superpowers/specs/2026-09-17-quick-answers-design.md §9-10.
// No jest-dom in this project (grep found none) -- disabled state is read
// with hasAttribute('disabled'), the same pattern ConversationView.test.tsx
// already uses for the composer's Send button.

const questionPrompt: PromptView = {
  id: 'evt-1', kind: 'question', answerable: true, reason: null,
  questions: [
    { question: 'Pick a color', header: 'Color', multiSelect: false,
      options: [{ label: 'Red', description: 'A warm colour' }, { label: 'Blue', description: 'A cool colour' }] },
    { question: 'Pick pets', header: 'Pets', multiSelect: true,
      options: [{ label: 'Cat', description: '' }, { label: 'Dog', description: '' }] },
  ],
};

const permissionPrompt: PromptView = {
  id: 'evt-2', kind: 'permission', answerable: true, reason: null,
  toolName: 'Bash', command: 'touch permission-test.txt',
  description: 'Create an empty file named permission-test.txt',
  choices: [
    { key: '1', label: 'Yes', takesText: false },
    { key: '2', label: 'Yes, and always allow access to probe-folder from this project', takesText: false },
    { key: '3', label: 'No', takesText: true },
  ],
};

const planPrompt: PromptView = {
  id: 'evt-3', kind: 'plan', answerable: true, reason: null,
  plan: '# Plan: Add hello\n\nDo the thing.',
  choices: [
    { key: '1', label: 'Yes, auto-accept edits', takesText: false },
    { key: '2', label: 'Yes, manually approve edits', takesText: false },
    { key: '3', label: 'Tell Claude what to change', takesText: true },
  ],
};

function setFleet(overrides: Record<string, unknown> = {}) {
  (globalThis as never as { window: { fleet: unknown } }).window.fleet = {
    answerPrompt: vi.fn().mockResolvedValue({ status: 'sent' }),
    ...overrides,
  };
  return (globalThis as unknown as { window: { fleet: { answerPrompt: ReturnType<typeof vi.fn> } } }).window.fleet;
}

describe('PromptCard -- questions', () => {
  it('renders a fieldset per question: radios for single-select, checkboxes for multi-select, an Other box on the single-select one and no Other on the multi-select one', () => {
    setFleet();
    render(<PromptCard pid={4821} prompt={questionPrompt} onOpenTerminal={() => {}} />);

    const q1 = within(screen.getByRole('group', { name: 'Pick a color' }));
    expect(q1.getByRole('radio', { name: 'Red' })).toBeTruthy();
    expect(q1.getByRole('radio', { name: 'Blue' })).toBeTruthy();
    expect(q1.getByRole('radio', { name: 'Something else' })).toBeTruthy();

    const q2 = within(screen.getByRole('group', { name: 'Pick pets' }));
    expect(q2.getByRole('checkbox', { name: 'Cat' })).toBeTruthy();
    expect(q2.getByRole('checkbox', { name: 'Dog' })).toBeTruthy();
    expect(q2.queryByRole('checkbox', { name: 'Something else' })).toBeNull();
    expect(q2.queryByRole('radio', { name: 'Something else' })).toBeNull();
    expect(screen.getByText('To type your own answer, use Terminal.')).toBeTruthy();
  });

  it('disables Send answers until every question is answered', () => {
    setFleet();
    render(<PromptCard pid={4821} prompt={questionPrompt} onOpenTerminal={() => {}} />);
    const send = screen.getByRole('button', { name: 'Send answers' });
    expect(send.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
    expect(send.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Cat' }));
    expect(send.hasAttribute('disabled')).toBe(false);
  });

  it('sends the right option indexes for each question when Send answers is clicked', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={questionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' })); // index 1
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dog' })); // index 1 only
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(
      4821, 'evt-1', { kind: 'questions', picks: [{ options: [1] }, { options: [1] }] },
    ));
  });

  it('sends the typed text for a single-select Other pick, with options empty', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={questionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your own answer' }), { target: { value: 'Green' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(
      4821, 'evt-1', { kind: 'questions', picks: [{ options: [], other: 'Green' }, { options: [0] }] },
    ));
  });

  it('sends chat when "Chat about this instead" is clicked, even with nothing answered', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={questionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat about this instead' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(4821, 'evt-1', { kind: 'chat' }));
  });

  // Final review M1.
  it('titles one question "Claude has a question" and several by their count', () => {
    setFleet();
    const one: PromptView = { ...questionPrompt, questions: [questionPrompt.questions![0]!] };
    const { unmount } = render(<PromptCard pid={4821} prompt={one} onOpenTerminal={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Claude has a question' })).toBeTruthy();
    unmount();
    render(<PromptCard pid={4821} prompt={questionPrompt} onOpenTerminal={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Claude has 2 questions' })).toBeTruthy();
  });

  it('renders a question label literally, as text -- never as html', () => {
    setFleet();
    const prompt: PromptView = {
      ...questionPrompt,
      questions: [{ ...questionPrompt.questions![0]!, question: '<b>x</b>' }],
    };
    render(<PromptCard pid={4821} prompt={prompt} onOpenTerminal={() => {}} />);
    expect(screen.getByText('<b>x</b>')).toBeTruthy();
  });
});

describe('PromptCard -- permission', () => {
  it('shows the command and Claude\'s description', () => {
    setFleet();
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    expect(screen.getByText('touch permission-test.txt')).toBeTruthy();
    expect(screen.getByText("Claude's description: Create an empty file named permission-test.txt")).toBeTruthy();
  });

  it('shows one button per choice, with its key', () => {
    setFleet();
    const { container } = render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    // :not(.quiet) excludes the "and tell Claude what to do instead"
    // secondary action, a sibling .btn inside the same .choices block --
    // this test is only about the one-button-per-choice buttons.
    const labels = [...container.querySelectorAll('.choices > .btn:not(.quiet)')].map(b => b.textContent);
    expect(labels).toEqual([
      '1 Yes',
      '2 Yes, and always allow access to probe-folder from this project',
      '3 No',
    ]);
  });

  it('sends a plain choice for the takesText "No" row on a direct click', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '3 No' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(4821, 'evt-2', { kind: 'choice', key: '3' }));
  });

  it('opens a one-line text box from the quiet secondary action, and Send sends choice_text', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'and tell Claude what to do instead' }));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'use npm instead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(
      4821, 'evt-2', { kind: 'choice_text', key: '3', text: 'use npm instead' },
    ));
  });

  it('disables Send to Claude while the text box is empty or over 2000 characters', () => {
    setFleet();
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'and tell Claude what to do instead' }));
    const box = screen.getByRole('textbox');
    const send = screen.getByRole('button', { name: 'Send to Claude' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.change(box, { target: { value: 'ok' } });
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.change(box, { target: { value: 'x'.repeat(2001) } });
    expect(send.hasAttribute('disabled')).toBe(true);
  });

  it('sends a plain choice for a normal, non-takesText button', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1 Yes' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(4821, 'evt-2', { kind: 'choice', key: '1' }));
  });
});

describe('PromptCard -- plan', () => {
  it('renders the plan through the existing markdown renderer', () => {
    setFleet();
    render(<PromptCard pid={4821} prompt={planPrompt} onOpenTerminal={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Plan: Add hello' })).toBeTruthy();
    expect(screen.getByText('Do the thing.')).toBeTruthy();
  });

  it('opens the feedback box for option 3 (the takesText choice), and Send sends choice_text', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={planPrompt} onOpenTerminal={() => {}} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '3 Tell Claude what to change' }));
    const box = screen.getByRole('textbox', { name: 'What should change?' });
    fireEvent.change(box, { target: { value: 'skip step 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(
      4821, 'evt-3', { kind: 'choice_text', key: '3', text: 'skip step 2' },
    ));
  });

  it('sends a plain choice for a non-takesText plan option', async () => {
    const fleet = setFleet();
    render(<PromptCard pid={4821} prompt={planPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1 Yes, auto-accept edits' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledWith(4821, 'evt-3', { kind: 'choice', key: '1' }));
  });
});

describe('PromptCard -- not answerable', () => {
  it('shows content, the reason, and Open Terminal, with no choice buttons (not_tmux)', () => {
    setFleet();
    const onOpenTerminal = vi.fn();
    const prompt: PromptView = { ...permissionPrompt, answerable: false, reason: 'not_tmux', choices: undefined };
    const { container } = render(<PromptCard pid={4821} prompt={prompt} onOpenTerminal={onOpenTerminal} />);
    expect(screen.getByText('touch permission-test.txt')).toBeTruthy();
    expect(container.querySelectorAll('.choices').length).toBe(0);
    expect(screen.getByText(/isn't running in the app's terminal/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    expect(onOpenTerminal).toHaveBeenCalled();
  });

  it('shows the screen_unread reason when choices could not be read from the screen', () => {
    setFleet();
    const prompt: PromptView = { ...permissionPrompt, answerable: false, reason: 'screen_unread', choices: undefined };
    render(<PromptCard pid={4821} prompt={prompt} onOpenTerminal={() => {}} />);
    expect(screen.getByText(/couldn't read claude's choices/i)).toBeTruthy();
  });
});

describe('PromptCard -- results', () => {
  it('shows Sending… right after a successful send', async () => {
    setFleet({ answerPrompt: vi.fn().mockResolvedValue({ status: 'sent' }) });
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1 Yes' }));
    await waitFor(() => expect(screen.getByText('Sending…')).toBeTruthy());
  });

  it('shows "Couldn\'t confirm -- answer in Terminal" for an unconfirmed refusal', async () => {
    setFleet({ answerPrompt: vi.fn().mockResolvedValue({ status: 'refused', reason: 'unconfirmed' }) });
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1 Yes' }));
    await waitFor(() => expect(screen.getByText("Couldn't confirm -- answer in Terminal")).toBeTruthy());
  });

  it('shows "Answers may be partly entered -- finish in Terminal" for unconfirmed_partial', async () => {
    setFleet({ answerPrompt: vi.fn().mockResolvedValue({ status: 'refused', reason: 'unconfirmed_partial' }) });
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1 Yes' }));
    await waitFor(() => expect(screen.getByText('Answers may be partly entered -- finish in Terminal')).toBeTruthy());
  });

  it('shows no error for a stale refusal -- the next payload replaces the card', async () => {
    const fleet = setFleet({ answerPrompt: vi.fn().mockResolvedValue({ status: 'refused', reason: 'stale' }) });
    render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '1 Yes' }));
    await waitFor(() => expect(fleet.answerPrompt).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("shows \"Claude didn't take the answer\" if the same prompt is still shown 3s after sending", async () => {
    vi.useFakeTimers();
    try {
      setFleet({ answerPrompt: vi.fn().mockResolvedValue({ status: 'sent' }) });
      render(<PromptCard pid={4821} prompt={permissionPrompt} onOpenTerminal={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '1 Yes' }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText('Sending…')).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(screen.getByText("Claude didn't take the answer -- open Terminal")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
