import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MobileApp, type MobileSession } from '../../src/renderer/mobile/MobileApp.tsx';
import type { MobileConnection } from '../../src/renderer/mobile/connection.ts';
import type { ConversationPage } from '../../src/store/conversation.ts';

vi.mock('../../src/renderer/components/TerminalView.tsx', () => ({ TerminalView: () => <div>Terminal output</div> }));
const row: MobileSession = { handle: 'h', pid: 10, sessionId: 'sid', provider: 'codex', name: 'Phone task', cwd: '/work', controllable: true, activity: 'idle' };
const first = { id: 1, role: 'assistant' as const, text: 'Earlier reply', ts: '2026-10-14T01:00:00Z' };
const second = { id: 2, role: 'assistant' as const, text: 'Fresh reply', ts: '2026-10-14T02:00:00Z' };
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function fixture() {
  let rows = [{ ...row, events: 1, lastProse: first.text }];
  let page: ConversationPage = { turns: [first], nextCursor: null };
  let state = 'ready';
  let conversation: (() => Promise<unknown>) | null = null;
  const listeners = new Set<() => void>();
  const connection = {
    state: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    onEvent: () => () => {}, connect: async () => {}, close: () => {},
    request: async (op: string) => {
      if (op === 'list') return { ok: true, value: rows };
      if (op === 'conversation') return conversation ? conversation() : { ok: true, value: page };
      if (op === 'live') return { ok: true, value: null };
      return { ok: true, value: [] };
    },
  } as unknown as MobileConnection;
  return { view: render(<MobileApp connection={connection} />), connection,
    setRows(next: typeof rows) { rows = next; },
    update() { rows = [{ ...row, events: 2, lastProse: second.text }]; page = { turns: [first, second], nextCursor: null }; },
    setConversation(next: typeof conversation) { conversation = next; },
    setPage(next: ConversationPage) { page = next; },
    setState(next: string) { act(() => { state = next; listeners.forEach(fn => fn()); }); },
  };
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(5100); }); }
const nav = () => screen.getByRole('navigation', { name: 'Fleet views' });
function openSession() { fireEvent.click(screen.getByRole('button', { name: /Phone task/ })); }
function back() { fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sessions' })); }
it('shows waiting sessions across folders and keeps their count after opening a request', async () => {
  const f = fixture();
  f.setRows([{ ...row, activity: 'waiting_permission', events: 1, lastProse: first.text }, { ...row, handle: 'other', pid: 11, sessionId: 'other', cwd: '/another', name: 'Other request', activity: 'waiting_input', events: 2, lastProse: 'Choose a direction' }]);
  await poll();
  fireEvent.click(within(nav()).getByRole('button', { name: /Needs you.*2/ }));
  expect(screen.getByRole('heading', { name: 'Other request' })).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: /Review/ })[0]!); await settle();
  expect(within(nav()).getByRole('button', { name: /Needs you.*2/ })).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Reply tools' })).toBeTruthy();
});
it('keeps updates unread in the inbox and reads only a loaded visible conversation, preserving the draft', async () => {
  const f = fixture(); await settle(); openSession(); await settle();
  fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Keep my draft' } }); back();
  f.update(); await poll();
  fireEvent.click(within(nav()).getByRole('button', { name: /Updates.*1/ }));
  expect(within(screen.getByRole('list')).getByText('Fresh reply')).toBeTruthy();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Open latest/ })); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*0/ })).toBeTruthy();
  expect(screen.getByText('New since your last visit').nextElementSibling?.textContent).toContain('Fresh reply');
  expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe('Keep my draft');
  expect(within(screen.getByRole('group', { name: 'Reply tools' })).getByRole('button', { name: 'Terminal' })).toBeTruthy();
});
it('does not clear new output in terminal or a hidden tab, and clears it when the conversation becomes visible', async () => {
  const f = fixture(); await settle(); openSession(); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  f.update(); await poll();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange'));
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' })); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); fireEvent(document, new Event('visibilitychange')); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*0/ })).toBeTruthy();
});
it('does not clear an update when offline or before its matching transcript arrives', async () => {
  const f = fixture(); await settle(); openSession(); await settle(); back();
  f.update(); f.setConversation(async () => ({ ok: true, value: { turns: [first], nextCursor: null } })); await poll();
  f.setState('offline'); openSession(); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  f.setState('ready'); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  f.setConversation(null); await poll();
  expect(within(nav()).getByRole('button', { name: /Updates.*0/ })).toBeTruthy();
});
it('keeps device unread state after remount without inventing an earlier transcript boundary', async () => {
  const f = fixture(); await settle(); f.update(); await poll(); f.view.unmount();
  render(<MobileApp connection={f.connection} />); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  openSession(); await settle();
  expect(screen.queryByText('New since your last visit')).toBeNull();
});
it('leaves a reply unread while reading older messages, then clears it when scrolled to the latest', async () => {
  const f = fixture(); await settle(); openSession(); await settle();
  const transcript = screen.getByText('Earlier reply').closest('.mobile-transcript')!;
  Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 400 } });
  transcript.scrollTop = 0; fireEvent.scroll(transcript);
  f.update(); await poll();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  transcript.scrollTop = 750; fireEvent.scroll(transcript); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  transcript.scrollTop = 800; fireEvent.scroll(transcript); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*0/ })).toBeTruthy();
});
it('restores the bottom of a hidden conversation before acknowledging its latest reply', async () => {
  const f = fixture(); await settle(); openSession(); await settle();
  const transcript = screen.getByText('Earlier reply').closest('.mobile-transcript')!;
  Object.defineProperties(transcript, { scrollHeight: { configurable: true, get: () => transcript.closest('main')!.hidden ? 0 : 1200 }, clientHeight: { configurable: true, value: 400 } });
  back(); fireEvent.click(within(nav()).getByRole('button', { name: /Updates/ }));
  f.update(); await poll();
  expect(transcript.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: /Open latest/ })); await settle();
  expect(transcript.scrollTop).toBeGreaterThanOrEqual(800);
  expect(within(nav()).getByRole('button', { name: /Updates.*0/ })).toBeTruthy();
});
it('keeps updates unread while a modal covers the conversation', async () => {
  const f = fixture(); await settle(); openSession(); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'New session' })); await settle();
  f.update(); await poll();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('dialog', { name: 'New session' })).getByRole('button', { name: 'Cancel' })); await settle();
  expect(within(nav()).getByRole('button', { name: /Updates.*0/ })).toBeTruthy();
});

it('does not acknowledge new replies while loading earlier messages', async () => {
  const f = fixture(); f.setPage({ turns: [first], nextCursor: { ts: first.ts, id: first.id } });
  await settle(); openSession(); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' })); await settle();
  f.update(); await poll();
  expect(within(nav()).getByRole('button', { name: /Updates.*1/ })).toBeTruthy();
});
it('opens the latest reply after leaving the same session scrolled up without resetting its draft', async () => {
  const f = fixture(); await settle(); openSession(); await settle();
  const transcript = screen.getByText('Earlier reply').closest('.mobile-transcript')!;
  const composer = screen.getByLabelText('Reply');
  fireEvent.change(composer, { target: { value: 'Keep this while catching up' } });
  Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 400 } });
  transcript.scrollTop = 0; fireEvent.scroll(transcript);
  f.update(); await poll();
  fireEvent.click(within(nav()).getByRole('button', { name: /Updates.*1/ }));
  fireEvent.click(screen.getByRole('button', { name: /Open latest/ })); await settle();
  expect(transcript.scrollTop).toBeGreaterThanOrEqual(800);
  expect(screen.getByLabelText('Reply')).toBe(composer);
  expect((composer as HTMLTextAreaElement).value).toBe('Keep this while catching up');
  expect(within(nav()).getByRole('button', { name: /Updates.*0/ })).toBeTruthy();
});
