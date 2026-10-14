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
it('shows favourite folders and sends the optional session name when launching', async () => {
  localStorage.clear();
  const request = vi.fn(async (op: string, _payload?: unknown) => {
    if (op === 'projects') return { ok: true, value: [{ id: 'favorite-project', label: 'Fleet — /work/fleet', favorite: true }, { id: 'other-project', label: 'Other — /work/other', favorite: false }] };
    if (op === 'launch') return { ok: true, value: { status: 'launched', pid: 88 } };
    return { ok: true, value: [] };
  });
  const connection = { state: () => 'ready', subscribe: () => () => {}, onEvent: () => () => {}, request, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
  const view = render(<MobileApp connection={connection} />);
  fireEvent.click(screen.getByText('New session'));
  const favorite = await screen.findByRole('button', { name: 'Fleet — /work/fleet' }); fireEvent.click(favorite);
  fireEvent.change(screen.getByLabelText('Session name (optional)'), { target: { value: 'Phone follow-up' } });
  fireEvent.click(screen.getByText('Start session'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('launch', { project: 'favorite-project', provider: 'codex', name: 'Phone follow-up' }));
  view.unmount();
});
