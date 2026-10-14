import { expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MobileApp } from '../../src/renderer/mobile/MobileApp.tsx';
import { MobileConnection } from '../../src/renderer/mobile/connection.ts';
import type { MobileSession } from '../../src/renderer/mobile/MobileApp.tsx';
vi.mock('../../src/renderer/components/TerminalView.tsx', () => ({ TerminalView: () => <div>Terminal</div> }));
it('groups sessions by full folder path and keeps waiting status visible when collapsed', async () => {
  localStorage.clear();
  const rows = [
    { pid: 1, cwd: '/work/project', name: 'Claude task', provider: 'claude', activity: 'waiting_input' },
    { pid: 2, cwd: '/work/project', name: 'Codex task', provider: 'codex', activity: 'working' },
    { pid: 3, cwd: '/other/project', name: 'Other task', provider: 'codex', activity: 'idle' },
    { pid: 4, cwd: '/other/project', name: 'Another task', provider: 'claude', activity: 'idle' },
    { pid: 5, cwd: null, name: 'Unknown folder', provider: 'codex', activity: 'idle' },
  ].map(row => ({ ...row, handle: `handle-${row.pid}`, sessionId: `session-${row.pid}`, controllable: true }));
  const request = async (op: string, payload?: { handle?: string }) => {
    if (op === 'list') return { ok: true, value: rows };
    if (op === 'conversation') return { ok: true, value: { turns: [{ id: 1, role: 'assistant', text: `Conversation ${payload?.handle}`, ts: '' }], nextCursor: null } };
    if (op === 'live') return { ok: true, value: null };
    return { ok: true, value: [] };
  };
  const connection = { state: () => 'ready', subscribe: () => () => {}, onEvent: () => () => {}, sendReply: MobileConnection.prototype.sendReply, request, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
  const view = render(<MobileApp connection={connection} />);
  try {
    const group = await screen.findByRole('region', { name: '/work/project' });
    const other = screen.getByRole('region', { name: '/other/project' });
    expect(within(group).getByText('Claude task')).toBeTruthy();
    expect(within(group).getByText('Codex task')).toBeTruthy();
    expect(within(group).queryByText('Other task')).toBeNull();
    expect(within(other).getByText('Other task')).toBeTruthy();
    expect(screen.getByText('Unknown folder')).toBeTruthy();
    const toggle = within(group).getByRole('button', { name: 'project, 2 sessions' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(group).queryByRole('button', { name: /Claude task/ })).toBeNull();
    expect(within(group).getByText('1 waiting on you')).toBeTruthy();
    fireEvent.click(toggle);
    fireEvent.click(within(group).getByRole('button', { name: /Codex task/ }));
    expect(await screen.findByText('Conversation handle-2')).toBeTruthy();
  } finally { view.unmount(); }
});
it('waits for a launched Codex thread identity before selecting its conversation', async () => {
  localStorage.clear(); vi.useFakeTimers();
  let rows: MobileSession[] = [];
  const request = async (op: string) => {
    if (op === 'list') return { ok: true, value: rows };
    if (op === 'projects') return { ok: true, value: [{ id: 'project', label: 'Project' }] };
    if (op === 'launch') return { ok: true, value: { status: 'launched', pid: 88 } };
    if (op === 'conversation') return { ok: true, value: { turns: [{ id: 1, role: 'assistant', text: 'Ready to work', ts: '' }], nextCursor: null } };
    if (op === 'live') return { ok: true, value: null };
    return { ok: true, value: [] };
  };
  const connection = { state: () => 'ready', subscribe: () => () => {}, onEvent: () => () => {}, sendReply: MobileConnection.prototype.sendReply, request, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
  const view = render(<MobileApp connection={connection} />);
  try {
    await act(async () => { fireEvent.click(screen.getByText('New session')); });
    await act(async () => { fireEvent.click(screen.getByText('Start session')); });
    rows = [{ pid: 88, provider: 'codex', sessionId: null, handle: null, cwd: '/work', controllable: false }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText(/Fleet cannot verify this session/)).toBeNull();
    rows = [{ ...rows[0]!, sessionId: 'new-thread', handle: 'verified', controllable: true }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('Ready to work')).toBeTruthy();
    expect(localStorage.getItem('fleet:mobile:selection')).toBe('new-thread');
  } finally { view.unmount(); vi.useRealTimers(); }
});
it('lists existing sessions and preserves the reply after a lost acknowledgement', async () => {
  localStorage.clear();
  const request = vi.fn(async (op: string) => {
    if (op === 'list') return { ok: true, value: [{ handle: 'h', pid: 10, sessionId: 'sid', provider: 'codex', name: 'Current work', cwd: '/work', controllable: true }] };
    if (op === 'conversation') return { ok: true, value: { turns: [{ id: 1, role: 'assistant', text: 'Existing conversation', ts: '' }], nextCursor: null } };
    if (op === 'send') return { ok: false, reason: 'uncertain' };
    if (op === 'live') return { ok: true, value: null };
    return { ok: true, value: [] };
  });
  const connection = { state: () => 'ready', subscribe: () => () => {}, onEvent: () => () => {}, sendReply: MobileConnection.prototype.sendReply, request, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
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
  const connection = { state: () => 'ready', subscribe: () => () => {}, onEvent: () => () => {}, sendReply: MobileConnection.prototype.sendReply, request, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
  const view = render(<MobileApp connection={connection} />);
  fireEvent.click(screen.getByText('New session'));
  const favorite = await screen.findByRole('button', { name: 'Fleet — /work/fleet' }); fireEvent.click(favorite);
  fireEvent.change(screen.getByLabelText('Session name (optional)'), { target: { value: 'Phone follow-up' } });
  fireEvent.click(screen.getByText('Start session'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('launch', { project: 'favorite-project', provider: 'codex', name: 'Phone follow-up' }));
  view.unmount();
});
function controlsFixture() {
  localStorage.clear();
  let rows = [{ handle: 'h', pid: 10, sessionId: 'sid', provider: 'codex', name: 'Phone task', cwd: '/work', controllable: true }];
  const request = vi.fn(async (op: string, _payload?: unknown): Promise<any> => {
    if (op === 'list') return { ok: true, value: rows };
    if (op === 'conversation') return { ok: true, value: { turns: [], nextCursor: null } };
    if (op === 'live') return { ok: true, value: null };
    if (op === 'send') return { ok: false, reason: 'uncertain' };
    if (op === 'close') { rows = []; return { ok: true, value: { status: 'killed' } }; }
    return { ok: true, value: [] };
  });
  const uploadImage = vi.fn(async () => ({ ok: true, value: { id: 'image-1' } }));
  const connection = { state: () => 'ready', subscribe: () => () => {}, onEvent: () => () => {}, sendReply: MobileConnection.prototype.sendReply, request, uploadImage, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
  return { request, uploadImage, view: render(<MobileApp connection={connection} />) };
}
it('requires confirmation before closing the named session and allows cancellation', async () => {
  const f = controlsFixture();
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    const dialog = screen.getByRole('dialog', { name: 'Close session' });
    expect(within(dialog).getByText('Close Phone task?')).toBeTruthy();
    expect(f.request.mock.calls.some(c => c[0] === 'close')).toBe(false);
    fireEvent.click(within(dialog).getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    fireEvent.click(screen.getByText('Stop session'));
    await waitFor(() => expect(f.request).toHaveBeenCalledWith('close', { handle: 'h' }));
    expect(await screen.findByText(/Close requested/)).toBeTruthy();
  } finally { f.view.unmount(); }
});
it('uploads an image-only reply and retains the image after an uncertain send', async () => {
  const create = vi.fn(() => 'blob:preview'); const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const f = controlsFixture();
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    const file = new File(['image'], 'screen.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Upload images'), { target: { files: [file] } });
    expect(screen.getByAltText('screen.png')).toBeTruthy();
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(f.request).toHaveBeenCalledWith('send', { handle: 'h', text: '', images: ['image-1'] }));
    expect(f.uploadImage).toHaveBeenCalledWith('h', file);
    expect(await screen.findByText(/may have been sent/)).toBeTruthy();
    expect(screen.getByAltText('screen.png')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove screen.png'));
    expect(revoke).toHaveBeenCalledWith('blob:preview');
    expect(screen.queryByAltText('screen.png')).toBeNull();
  } finally { f.view.unmount(); vi.unstubAllGlobals(); }
});
it('shows website setup guidance and refreshes configured private links', async () => {
  const f = controlsFixture();
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    fireEvent.click(screen.getByRole('button', { name: 'Websites' }));
    expect(screen.getByText(/No websites connected/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Refresh websites')).toBeTruthy());
    f.request.mockImplementation(async op => op === 'previews' ? { ok: true, value: [{ id: 'site', label: 'My app', url: 'https://mac.tail123.ts.net:8443', available: true }] } : { ok: true, value: [] });
    fireEvent.click(screen.getByText('Refresh websites'));
    const link = await screen.findByRole('link', { name: 'Open My app' });
    expect(link.getAttribute('href')).toBe('https://mac.tail123.ts.net:8443');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  } finally { f.view.unmount(); }
});
