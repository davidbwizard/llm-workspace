import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CodexPromptCard } from '../../src/renderer/components/CodexPromptCard.tsx';
import type { CodexPrompt } from '../../src/core/codexPrompt.ts';

const command: CodexPrompt = {
  key: 'number:42', kind: 'command', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1',
  reason: 'Run tests', command: 'npm test', cwd: '/repo', details: null, questions: null,
  decisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
};

describe('CodexPromptCard', () => {
  it('shows the command and sends only the selected decision', async () => {
    const answerCodexPrompt = vi.fn().mockResolvedValue({ status: 'sent' });
    (globalThis as any).window.fleet = { answerCodexPrompt };
    render(<CodexPromptCard pid={4821} prompt={command} onOpenTerminal={() => {}} />);
    expect(screen.getByText('npm test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(answerCodexPrompt).toHaveBeenCalledWith(4821, 'number:42', 'accept'));
    expect(screen.getByRole('button', { name: 'Allow for session' }).hasAttribute('disabled')).toBe(true);
    delete (globalThis as any).window.fleet;
  });

  it('requires every question before sending the answer map', async () => {
    const answerCodexPrompt = vi.fn().mockResolvedValue({ status: 'sent' });
    (globalThis as any).window.fleet = { answerCodexPrompt };
    const prompt: CodexPrompt = { ...command, kind: 'questions', command: null, cwd: null,
      questions: [
        { id: 'scope', header: 'Scope', question: 'Which?', isSecret: false, isOther: false,
          options: [{ label: 'One', description: 'One file' }] },
        { id: 'reason', header: 'Reason', question: 'Why?', isSecret: false, isOther: true, options: null },
      ] };
    render(<CodexPromptCard pid={4821} prompt={prompt} onOpenTerminal={() => {}} />);
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'One' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'Needed' } });
    fireEvent.click(send);
    await waitFor(() => expect(answerCodexPrompt).toHaveBeenCalledWith(4821, 'number:42',
      { scope: 'One', reason: 'Needed' }));
    delete (globalThis as any).window.fleet;
  });
});
