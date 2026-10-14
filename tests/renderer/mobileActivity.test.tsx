import { expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { MobileApp, type MobileSession } from '../../src/renderer/mobile/MobileApp.tsx';
import { MobileSessionList } from '../../src/renderer/mobile/MobileSessionList.tsx';
import type { MobileConnection } from '../../src/renderer/mobile/connection.ts';
import type { SessionLivePayload } from '../../src/main/sessionLive.ts';
vi.mock('../../src/renderer/components/TerminalView.tsx', () => ({ TerminalView: () => <div>Terminal output</div> }));
const row: MobileSession = { handle: 'h', pid: 10, sessionId: 'sid', provider: 'codex', name: 'Phone task', cwd: '/work', controllable: true, activity: 'working' };
const live: SessionLivePayload = { version: 1, pid: 10, sessionId: 'sid', activity: 'working', since: Date.now() - 42000, events: 0, prompt: null, context: null, mode: null };
const waiting: SessionLivePayload = { ...live, activity: 'waiting', since: null, codex: { state: 'ready', prompts: [{ key: 'approval', kind: 'command', threadId: 'sid', turnId: null, itemId: null, reason: null, command: 'npm test', cwd: '/work', details: null, questions: null, decisions: ['accept', 'decline'] }] } };
function fixture(initial: SessionLivePayload = live) {
  localStorage.clear();
  let state = 'ready';
  const stateListeners = new Set<() => void>();
  const eventListeners = new Set<(event: string, data: unknown) => void>();
  const connection = {
    state: () => state,
    subscribe: (fn: () => void) => { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    onEvent: (fn: (event: string, data: unknown) => void) => { eventListeners.add(fn); return () => eventListeners.delete(fn); },
    request: async (op: string) => ({ ok: true, value: op === 'list' ? [row] : op === 'live' ? initial : op === 'conversation' ? { turns: [], nextCursor: null } : [] }),
    close: () => {}, connect: async () => {},
  } as unknown as MobileConnection;
  return { view: render(<MobileApp connection={connection} />),
    emit: (value: SessionLivePayload) => act(() => eventListeners.forEach(fn => fn('session:live', value))),
    disconnect: () => act(() => { state = 'offline'; stateListeners.forEach(fn => fn()); }),
  };
}
it('keeps working and waiting counts visible in collapsed folders and marks waiting rows distinctly', () => {
  const rows = [row, { ...row, pid: 11, sessionId: 'second', name: 'Needs approval', activity: 'waiting_permission' }];
  const view = render(<MobileSessionList sessions={rows} onSelect={() => {}} />);
  try {
    expect(within(screen.getByRole('button', { name: /Needs approval/ })).getByText('Waiting on you')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /Phone task/ })).getByText('Working')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'work, 2 sessions' }));
    expect(screen.getByText('1 working')).toBeTruthy();
    expect(screen.getByText('1 waiting on you')).toBeTruthy();
  } finally { view.unmount(); }
});
it('shows the working strip in conversation and terminal and clears it when work ends', async () => {
  const f = fixture();
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    expect(await screen.findByText('Codex is working')).toBeTruthy();
    expect(screen.getByText(/42s|43s/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByText('Codex is working')).toBeTruthy();
    f.emit({ ...live, activity: 'idle', since: null });
    expect(screen.queryByText('Codex is working')).toBeNull();
  } finally { f.view.unmount(); }
});
it('replaces work with attention and reviews the actual prompt from terminal view', async () => {
  const scroll = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  const scrollMethod = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  HTMLElement.prototype.scrollIntoView = scroll;
  const f = fixture();
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    await screen.findByText('Codex is working');
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    f.emit(waiting);
    expect(screen.queryByText('Codex is working')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review request' }));
    expect(screen.getByText('Allow this command?')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Session requests' }));
    expect(scroll).toHaveBeenCalled();
    f.emit({ ...live, activity: 'idle', since: null });
    expect(screen.queryByRole('button', { name: 'Review request' })).toBeNull();
  } finally { f.view.unmount(); vi.unstubAllGlobals(); if (scrollMethod) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollMethod); else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; }
});
it('offers terminal access when waiting but no actionable prompt is available', async () => {
  const f = fixture({ ...live, activity: 'waiting', since: null });
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal' }));
    expect(screen.getByText('Terminal output')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review request' })).toBeNull();
  } finally { f.view.unmount(); }
});
it('does not show stale working or waiting signals after losing the connection', async () => {
  const f = fixture(waiting);
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    await screen.findByRole('button', { name: 'Review request' });
    f.disconnect();
    expect(screen.queryByRole('button', { name: 'Review request' })).toBeNull();
    expect(screen.queryByText('Codex is working')).toBeNull();
    expect(screen.queryByText('Working')).toBeNull();
    expect(screen.queryByText('Allow this command?')).toBeNull();
    expect(screen.getByText('Status unavailable')).toBeTruthy();
  } finally { f.view.unmount(); }
});
it('surfaces a nonblocking Codex question without claiming the agent has stopped', async () => {
  const f = fixture({ ...waiting, activity: 'working', codex: { state: 'ready', prompts: waiting.codex!.prompts.map(p => ({ ...p, isBlocking: false })) } });
  try {
    fireEvent.click(await screen.findByText('Phone task'));
    expect(await screen.findByRole('button', { name: 'Review request' })).toBeTruthy();
    expect(screen.getByText('Needs your input')).toBeTruthy();
    expect(screen.queryByText('Waiting on you')).toBeNull();
  } finally { f.view.unmount(); }
});
