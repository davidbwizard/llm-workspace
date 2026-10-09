import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CodexPromptCard } from '../../src/renderer/components/CodexPromptCard.tsx';
import { viewCodexRequest } from '../../src/main/codexAppServer.ts';
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
  it('renders required typed MCP fields and submits typed values without unoffered session approval', async () => {
    const answerCodexPrompt = vi.fn().mockResolvedValue({ status: 'sent' });
    (globalThis as any).window.fleet = { answerCodexPrompt };
    const prompt = viewCodexRequest({ id: 5, method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread-1', turnId: null, serverName: 'forms', mode: 'form', message: 'Configure', _meta: null,
      requestedSchema: { type: 'object', properties: {
        name: { type: 'string', title: 'Name', minLength: 2, writeOnly: true },
        count: { type: 'integer', title: 'Count', minimum: 1 },
        enabled: { type: 'boolean', title: 'Enabled' },
        scope: { type: 'string', title: 'Scope', enum: ['one', 'all'] },
      }, required: ['name', 'count', 'enabled', 'scope'] },
    } }, 'thread-1')!;
    render(<CodexPromptCard pid={4821} prompt={prompt} onOpenTerminal={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull();
    const submit = screen.getByRole('button', { name: 'Send answers' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    const name = screen.getByLabelText('Name');
    expect(name.getAttribute('type')).toBe('password');
    fireEvent.change(name, { target: { value: 'Alice' } });
    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Enabled'), { target: { value: 'false' } });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'one' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(answerCodexPrompt).toHaveBeenCalledWith(4821, prompt.key,
      { action: 'accept', content: { name: 'Alice', count: 2, enabled: false, scope: 'one' } }));
    delete (globalThis as any).window.fleet;
  });

  it('shows truthful native fallback with only the Terminal action', () => {
    const open = vi.fn();
    render(<CodexPromptCard pid={4821} prompt={{ ...command, kind: 'fallback',
      fallback: 'Complete this verification in the native Codex client. Open Terminal to continue.' }} onOpenTerminal={open} />);
    expect(screen.getByText(/Complete this verification/)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    expect(open).toHaveBeenCalledOnce();
  });

  it('shows only offered opaque command actions and sends their identifier', async () => {
    const answerCodexPrompt = vi.fn().mockResolvedValue({ status: 'sent' });
    (globalThis as any).window.fleet = { answerCodexPrompt };
    render(<CodexPromptCard pid={4821} prompt={{ ...command, decisions: [], actions: [
      { id: 'offered:1', label: 'Allow commands starting with npm test' }, { id: 'cancel', label: 'Cancel turn' },
    ] }} onOpenTerminal={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow commands starting with npm test' }));
    await waitFor(() => expect(answerCodexPrompt).toHaveBeenCalledWith(4821, 'number:42', 'offered:1'));
    delete (globalThis as any).window.fleet;
  });

  it('handles secret nonblocking questions whose IDs are reserved object property names', async () => {
    const answerCodexPrompt = vi.fn().mockResolvedValue({ status: 'sent' });
    (globalThis as any).window.fleet = { answerCodexPrompt };
    render(<CodexPromptCard pid={4821} prompt={{ ...command, kind: 'questions', isBlocking: false,
      questions: [{ id: 'constructor', header: 'Secret', question: 'Enter the value',
        isSecret: true, isOther: false, options: null }] }} onOpenTerminal={() => {}} />);
    expect(screen.getByText('Codex has a question')).toBeTruthy();
    const input = screen.getByLabelText('Secret');
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.change(input, { target: { value: 'chosen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(answerCodexPrompt).toHaveBeenCalledWith(4821, command.key, { constructor: 'chosen' }));
    delete (globalThis as any).window.fleet;
  });

  it('keeps a sent request disabled and clears its reminder timer on unmount', async () => {
    vi.useFakeTimers();
    const answerCodexPrompt = vi.fn().mockResolvedValue({ status: 'sent' });
    (globalThis as any).window.fleet = { answerCodexPrompt };
    const rendered = render(<CodexPromptCard pid={4821} prompt={command} onOpenTerminal={() => {}} />);
    try {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow once' })); });
      await act(async () => { vi.advanceTimersByTime(3100); });
      expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('status').textContent).toContain('Check Terminal');
      rendered.rerender(<CodexPromptCard pid={4821} prompt={{ ...command, key: 'new-key' }} onOpenTerminal={() => {}} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow once' })); });
      rendered.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally { rendered.unmount(); vi.useRealTimers(); delete (globalThis as any).window.fleet; }
  });

});
