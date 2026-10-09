import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MainPane } from '../../src/renderer/components/MainPane.tsx';
import { clearDrafts } from '../../src/renderer/state/drafts.ts';
vi.mock('../../src/renderer/components/TerminalView.tsx', () => ({ TerminalView: ({ pid }: { pid: number }) => <div data-testid="native">Native terminal {pid}</div> }));
const id = '11111111-1111-4111-8111-111111111111';
const s = { pid: 2, sessionId: id, project: 'same', cwd: '/same', provider: 'codex', tmux: true,
  context: null, activity: 'idle', ageSeconds: 1, rssBytes: 1, events: 1, agents: null, liveAgents: null,
  codexConnection: { state: 'ready', recoverable: true, previousTerminalPid: 1 } } as any;
beforeEach(() => { clearDrafts(); (window as any).fleet = {
  conversation: vi.fn().mockResolvedValue({ turns: [], nextCursor: null }),
  listHistory: vi.fn().mockResolvedValue({ version: 1, sessions: [], total: 0 }),
  stageFile: vi.fn().mockResolvedValue({ ok: true, id: 'held-file' }) };
});
afterEach(() => { cleanup(); delete window.fleet; });
it('opens preserved native terminal locally and returns with draft and attachments intact', async () => {
  const select = vi.fn(), setView = vi.fn();
  render(<MainPane selection={{ pid: 2, view: 'conversation' }} sessions={[s]} onSelect={select}
    onSetView={setView} onClear={vi.fn()} railSide="left" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fleet draft' } });
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['a'], 'held.txt')] } });
  await screen.findByText('held.txt');
  fireEvent.click(screen.getByRole('button', { name: 'Open previous Terminal' }));
  expect(screen.getByTestId('native').textContent).toContain('1');
  expect(select).not.toHaveBeenCalled();
  expect(setView).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Return to Conversation' }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Fleet draft'));
  expect(screen.getByText('held.txt')).toBeTruthy();
});
it('opens an unconfirmed reconnect terminal without changing the logical selection', () => {
  const select = vi.fn();
  render(<MainPane selection={{ pid: 2, view: 'conversation' }} sessions={[{ ...s,
    codexConnection: { state: 'failed', recoverable: true, recoveryTerminalPid: 4 } }]}
    onSelect={select} onSetView={vi.fn()} onClear={vi.fn()} railSide="left" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open reconnect Terminal' }));
  expect(screen.getByTestId('native').textContent).toContain('4');
  expect(select).not.toHaveBeenCalled();
});
