import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MobileApp } from '../../src/renderer/mobile/MobileApp.tsx';
import type { MobileConnection } from '../../src/renderer/mobile/connection.ts';
vi.mock('../../src/renderer/components/TerminalView.tsx', () => ({ TerminalView: () => <div>Terminal</div> }));
it('lists existing sessions and preserves the reply after a lost acknowledgement', async () => {
  localStorage.clear();
  const request = vi.fn(async (op: string) => {
    if (op === 'list') return { ok: true, value: [{ handle: 'h', pid: 10, sessionId: 'sid', provider: 'codex', name: 'Current work', cwd: '/work', controllable: true }] };
    if (op === 'conversation') return { ok: true, value: { turns: [{ id: 1, role: 'assistant', text: 'Existing conversation', ts: '' }], nextCursor: null } };
    if (op === 'send') return { ok: false, reason: 'uncertain' };
    if (op === 'live') return { ok: true, value: null };
    return { ok: true, value: [] };
  });
  const connection = { state: () => 'ready', subscribe: () => () => {}, onEvent: () => () => {}, request, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
  const view = render(<MobileApp connection={connection} />);
  fireEvent.click(await screen.findByText('Current work'));
  expect(await screen.findByText('Existing conversation')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByText('Send'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('may have been sent'));
  expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe('Keep this draft');
  expect(request.mock.calls.filter(c => c[0] === 'send')).toHaveLength(1); view.unmount();
});
