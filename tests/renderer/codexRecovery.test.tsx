import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useFleet } from '../../src/renderer/state/useFleet.ts';
import { ConversationView, clearDrafts } from '../../src/renderer/components/ConversationView.tsx';
import { clearPending, pendingFor } from '../../src/renderer/state/pending.ts';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const session = (pid: number, sessionId = id) => ({ pid, sessionId, provider: 'codex', cwd: '/same', tmux: true,
  match: 'exact', context: null, codexConnection: { state: 'ready', recoverable: true } });
const payload = (openSessions: any[], codexReplacements: any[] = []) => ({ version: 1, generatedAt: '', openSessions, codexReplacements });
let push: (p: any) => void;
let live: (p: any) => void;
let send: ReturnType<typeof vi.fn>;
function bridge() {
  send = vi.fn().mockResolvedValue({ status: 'sent', queued: false });
  (window as any).fleet = { listFleet: vi.fn().mockResolvedValue(payload([session(1), session(3, other)])),
    onFleet: (cb: any) => { push = cb; return () => {}; },
    conversation: vi.fn().mockResolvedValue({ turns: [{ id: 1, role: 'assistant', text: 'Saved reply', ts: '2026-10-09' }], nextCursor: null }),
    sendKeys: send, stageFile: vi.fn().mockResolvedValue({ ok: true, id: 'file-1' }),
    watchSession: vi.fn().mockResolvedValue(true), onSessionLive: (cb: any) => { live = cb; return () => {}; } };
}
function view(pid = 1, sessionId: string | null = id, connection: any = { state: 'ready', recoverable: true }) {
  return <ConversationView pid={pid} sessionId={sessionId} provider="codex" events={1} tmux
    codexConnection={connection} onOpenTerminal={vi.fn()} />;
}
async function attach() {
  const file = new File(['data'], 'notes.txt', { type: 'text/plain' });
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } });
  await screen.findByText('notes.txt');
}
beforeEach(() => { clearDrafts(); clearPending(); bridge(); });
afterEach(() => { cleanup(); delete window.fleet; });
describe('exact Codex recovery', () => {
  it('remaps current selection while retaining Conversation and text plus attachments', async () => {
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    act(() => result.current.select(1));
    const ui = render(view());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'held draft' } });
    await attach();
    act(() => push(payload([session(2), session(3, other)], [{ previousPid: 1, pid: 2, sessionId: id }])));
    expect(result.current.selection).toEqual({ pid: 2, view: 'conversation' });
    ui.rerender(view(2));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('held draft');
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
  it('a late replacement never steals another selection and wrong IDs never remap', async () => {
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    act(() => result.current.select(3));
    act(() => push(payload([session(2), session(3, other)], [{ previousPid: 1, pid: 2, sessionId: id }])));
    expect(result.current.selection?.pid).toBe(3);
    act(() => result.current.select(3));
    act(() => push(payload([session(4)], [{ previousPid: 3, pid: 4, sessionId: id }])));
    expect(result.current.selection?.pid).toBe(3);
  });
  it('restores attachments after unmount and isolates distinct same-folder threads', async () => {
    const ui = render(view());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep me' } });
    await attach();
    ui.unmount();
    const otherUi = render(view(3, other));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText('notes.txt')).toBeNull();
    otherUi.unmount();
    render(view());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep me');
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });
  it('preserves attachment staging across replacement even when the draft was empty', async () => {
    let resolve!: (r: any) => void;
    const stage = vi.fn().mockImplementation(() => new Promise(r => { resolve = r; }));
    window.fleet!.stageFile = stage;
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    const ui = render(view());
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['data'], 'late.txt')] } });
    await waitFor(() => expect(stage).toHaveBeenCalled());
    act(() => push(payload([session(2)], [{ previousPid: 1, pid: 2, sessionId: id }])));
    ui.rerender(view(2));
    await act(async () => resolve({ ok: true, id: 'late-file' }));
    expect(await screen.findByText('late.txt')).toBeTruthy();
  });
  it('restores refusal to successor when replacement arrives during send', async () => {
    let resolve!: (r: any) => void;
    send.mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    act(() => result.current.select(1));
    const ui = render(view());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsent' } });
    await attach();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(send).toHaveBeenCalledWith(1, 'unsent', { images: [], files: ['file-1'] }, id);
    act(() => push(payload([session(2)], [{ previousPid: 1, pid: 2, sessionId: id }])));
    ui.rerender(view(2));
    await act(async () => resolve({ status: 'refused', reason: 'codex_not_ready' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('unsent');
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(pendingFor(2, id)).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps working async questions visible and draft editable while blocking Send', async () => {
    render(view());
    act(() => live({ pid: 1, sessionId: id, events: 1, activity: 'working', since: null,
      codex: { connection: 'ready', prompts: [{ key: 'q', kind: 'questions', threadId: id, decisions: [], title: 'Choose direction',
        isBlocking: false, questions: [{ id: 'direction', header: 'Direction', question: 'Which way?', options: [] }] }] } }));
    expect(screen.getByText('Which way?')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Message this session' });
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'held while working' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    act(() => live({ pid: 1, sessionId: id, events: 1, activity: 'idle', codex: { connection: 'ready', prompts: [] } }));
    expect(send).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('held while working');
  });
  it('follows a validated predecessor initially discovered with unknown identity', async () => {
    (window.fleet!.listFleet as any).mockResolvedValue(payload([{ ...session(1), sessionId: null }]));
    const { result } = renderHook(() => useFleet());
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    act(() => result.current.select(1));
    act(() => push(payload([session(2)], [{ previousPid: 1, pid: 2, sessionId: id }])));
    expect(result.current.selection).toEqual({ pid: 2, view: 'conversation' });
  });
  it('does not let a slow initial list regress a newer fleet update', async () => {
    let resolve!: (r: any) => void;
    (window.fleet!.listFleet as any).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useFleet());
    act(() => push(payload([session(2)])));
    await act(async () => resolve(payload([session(1)])));
    expect(result.current.payload?.openSessions[0]?.pid).toBe(2);
  });
  it('ignores stale initial list rejection after a valid fleet push', async () => {
    let reject!: (reason: Error) => void;
    (window.fleet!.listFleet as any).mockImplementation(() => new Promise((_resolve, r) => { reject = r; }));
    const { result } = renderHook(() => useFleet());
    act(() => push(payload([session(2)])));
    await act(async () => reject(new Error('Initial pull failed')));
    expect(result.current.payload?.openSessions[0]?.pid).toBe(2);
    expect(result.current.error).toBeNull();
  });
  it('never offers a new native thread prompt under old same-PID history', () => {
    render(view());
    act(() => live({ pid: 1, sessionId: other, events: 2, activity: 'waiting',
      codexConnection: { state: 'ready', recoverable: true },
      codex: { state: 'ready', prompts: [{ key: 'changed', threadId: other, kind: 'questions', decisions: [],
        questions: [{ id: 'new', header: 'New', question: 'Other thread question', options: [] }] }] } }));
    expect(screen.queryByText('Other thread question')).toBeNull();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows failed retry honestly without selecting its returned PID or replaying draft', async () => {
    (window.fleet as any).recoverCodex = vi.fn().mockResolvedValue({ status: 'failed', reason: 'Resume needs native trust' });
    render(view(1, id, { state: 'failed', recoverable: true, reason: 'Automatic reconnect failed' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hold this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry reconnect' }));
    expect(await screen.findByText('Resume needs native trust')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hold this');
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves interrupted input and requires explicit native acknowledgment', async () => {
    send.mockResolvedValue({ status: 'interrupted', reason: 'codex_not_ready' });
    const clear = vi.fn().mockResolvedValue({ status: 'cleared' });
    (window.fleet as any).clearCodexInput = clear;
    const ui = render(view());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'maybe pasted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'I handled the terminal draft' });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(pendingFor(1, id)).toHaveLength(0);
    ui.unmount();
    render(view());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('maybe pasted');
    fireEvent.click(screen.getByRole('button', { name: 'I handled the terminal draft' }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(1, id));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps blocking approvals visible and blocks Send while preserving editable composition', () => {
    render(view());
    act(() => live({ pid: 1, sessionId: id, events: 1, activity: 'waiting',
      codexConnection: { state: 'ready', recoverable: true },
      codex: { state: 'ready', prompts: [{ key: 'approval', threadId: id, kind: 'command',
        isBlocking: true, decisions: ['accept', 'decline'], command: 'git status', questions: null }] } }));
    expect(screen.getByText('git status')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves ordinary unmanaged Codex tmux sending without a recovery warning', async () => {
    render(<ConversationView pid={1} sessionId={id} provider="codex" events={1} tmux onOpenTerminal={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'ordinary native session' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/connection cannot be verified/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(1, 'ordinary native session', undefined, id));
  });
  it('keeps explicitly unresolved managed Codex tmux sessions blocked', () => {
    render(view(1, id, { state: 'unknown', recoverable: false }));
    const box = screen.getByRole('textbox');
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(box, { target: { value: 'hold while identity unknown' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/connection cannot be verified/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps disconnected draft editable and blocks ordinary sends', () => {
    render(view(1, id, { state: 'recovering', recoverable: true }));
    const box = screen.getByRole('textbox');
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
