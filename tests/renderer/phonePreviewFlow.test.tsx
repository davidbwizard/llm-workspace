import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConversationView } from '../../src/renderer/components/ConversationView.tsx';
import { MobileApp, type MobileSession } from '../../src/renderer/mobile/MobileApp.tsx';
import type { MobileConnection } from '../../src/renderer/mobile/connection.ts';
import { RemoteSettings } from '../../src/renderer/components/RemoteSettings.tsx';
import type { PreviewOpenResult } from '../../src/core/preview.ts';
vi.mock('../../src/renderer/components/TerminalView.tsx', () => ({ TerminalView: () => <div>Terminal output</div> }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
const local = 'http://localhost:3000/app?mode=preview#top';
const privateUrl = 'https://mac.tail.ts.net:8443/app?mode=preview#top';
const page = { turns: [{ id: 1, role: 'assistant', text: `[Test website](${local})`, ts: '2026-10-14T01:00:00Z' }], nextCursor: null };
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); delete window.fleet; });
it('sends the selected desktop session identity only after clicking Open on phone', async () => {
  const openPhonePreview = vi.fn(async () => ({ ok: true, url: privateUrl }));
  window.fleet = { conversation: async () => page, openPhonePreview } as unknown as NonNullable<Window['fleet']>;
  render(<ConversationView sessionId="desktop-session" provider="claude" events={null} pid={42} tmux={true} onOpenTerminal={() => {}} />);
  const trigger = await screen.findByRole('button', { name: 'Open on phone' });
  expect(openPhonePreview).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  expect(await screen.findByRole('link', { name: 'Open website' })).toHaveProperty('href', privateUrl);
  expect(openPhonePreview).toHaveBeenCalledWith(42, 'desktop-session', local);
});
function mobileFixture(open: () => Promise<{ ok: true; value: PreviewOpenResult } | { ok: false; reason: string }>) {
  const rows: MobileSession[] = [
    { handle: 'first-handle', sessionId: 'first-session', pid: 42, provider: 'codex', name: 'First work', cwd: '/work', controllable: true },
    { handle: 'second-handle', sessionId: 'second-session', pid: 43, provider: 'codex', name: 'Second work', cwd: '/work', controllable: true },
  ];
  let shared = false;
  const request = vi.fn(async (op: string, _payload?: unknown) => {
    if (op === 'list') return { ok: true, value: rows };
    if (op === 'conversation') return { ok: true, value: page };
    if (op === 'preview:open') { const result = await open(); shared = result.ok; return result; }
    if (op === 'previews') return { ok: true, value: shared ? [{ id: 'p', label: 'Connected project', url: privateUrl, available: true }] : [] };
    if (op === 'live') return { ok: true, value: null };
    return { ok: true, value: [] };
  });
  let state = 'ready'; const listeners = new Set<() => void>();
  const connection = { state: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onEvent: () => () => {}, request, connect: vi.fn(), close: vi.fn() } as unknown as MobileConnection;
  return { request, view: render(<MobileApp connection={connection} />), setState(next: string) { state = next; listeners.forEach(listener => listener()); } };
}
it('uses the mobile preview operation and refreshes Websites after setup', async () => {
  const f = mobileFixture(async () => ({ ok: true, value: { ok: true, url: privateUrl } }));
  fireEvent.click(await screen.findByRole('button', { name: /First work/ }));
  const trigger = await screen.findByRole('button', { name: 'Open website' });
  expect(f.request.mock.calls.some(call => call[0] === 'preview:open')).toBe(false);
  expect(screen.queryByRole('link', { name: 'Test website' })).toBeNull();
  const priorChecks = f.request.mock.calls.filter(call => call[0] === 'previews').length;
  fireEvent.click(trigger);
  expect(await screen.findByRole('link', { name: 'Open website' })).toHaveProperty('href', privateUrl);
  expect(f.request).toHaveBeenCalledWith('preview:open', { handle: 'first-handle', url: local });
  expect(f.request.mock.calls.filter(call => call[0] === 'previews').length).toBeGreaterThan(priorChecks);
  fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Websites' }));
  expect(await screen.findByRole('link', { name: 'Open Connected project' })).toBeTruthy();
  expect(screen.getByLabelText('Website address on your Mac')).toBeTruthy();
});
it('shows mobile operation refusals without creating a website link', async () => {
  mobileFixture(async () => ({ ok: false, reason: 'stale' }));
  fireEvent.click(await screen.findByRole('button', { name: /First work/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open website' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Open website' })).toBeNull();
});
it('does not display the first session result or refresh its previews after switching sessions', async () => {
  let resolve!: (result: { ok: true; value: PreviewOpenResult }) => void;
  const f = mobileFixture(() => new Promise(done => { resolve = done; }));
  fireEvent.click(await screen.findByRole('button', { name: /First work/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open website' }));
  fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sessions' }));
  fireEvent.click(screen.getByRole('button', { name: /Second work/ }));
  await screen.findByRole('button', { name: 'Open website' });
  const checks = f.request.mock.calls.filter(call => call[0] === 'previews').length;
  await act(async () => { resolve({ ok: true, value: { ok: true, url: privateUrl } }); });
  expect(screen.queryByRole('link', { name: 'Open website' })).toBeNull();
  expect(f.request.mock.calls.filter(call => call[0] === 'previews')).toHaveLength(checks);
});
it('keeps managed addresses read-only and shows the gateway mapping and route removal explanation', async () => {
  const config = { enabled: true, port: 43180, origin: 'https://mac.tail.ts.net', login: 'owner@example.com', previews: [{ id: 'managed', project: '/work', label: 'My website', localPort: 3000, url: 'https://mac.tail.ts.net:8443', managed: true as const, localHost: '127.0.0.1' as const }] };
  const remoteConfigure = vi.fn(async (next: typeof config) => ({ state: 'ready', config: next, error: null }));
  window.fleet = { remoteGet: async () => ({ state: 'ready', config, error: null }), remoteConfigure } as unknown as NonNullable<Window['fleet']>;
  const view = render(<RemoteSettings />);
  const address = await screen.findByLabelText('Private preview address');
  expect(address).toHaveProperty('readOnly', true);
  expect(screen.getByLabelText('Development server port')).toHaveProperty('readOnly', true);
  expect(screen.getByLabelText('Project folder')).toHaveProperty('readOnly', true);
  expect(screen.getByLabelText('Name')).toHaveProperty('readOnly', false);
  expect(screen.getByText(/Removing this preview and saving closes its route/)).toBeTruthy();
  expect(view.container.querySelector('pre')?.textContent).toContain('--https=8443 http://127.0.0.1:43181');
  expect(view.container.querySelector('pre')?.textContent).not.toContain('http://127.0.0.1:3000');
  fireEvent.click(screen.getByRole('button', { name: 'Remove preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save and restart remote access' }));
  await waitFor(() => expect(remoteConfigure).toHaveBeenCalledWith({ ...config, previews: [] }));
});
it('refreshes again when setup finishes during an older website check', async () => {
  const f = mobileFixture(async () => ({ ok: true, value: { ok: true, url: privateUrl } }));
  fireEvent.click(await screen.findByRole('button', { name: /First work/ }));
  await screen.findByRole('button', { name: 'Open website' });
  const original = f.request.getMockImplementation()!;
  let resolve!: (value: Awaited<ReturnType<typeof original>>) => void;
  let hold = true;
  f.request.mockImplementation((op, payload) => {
    if (op === 'previews' && hold) { hold = false; return new Promise(done => { resolve = done; }); }
    return original(op, payload);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Websites' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Open website' }).find(button => !button.hasAttribute('disabled'))!);
  await screen.findByRole('link', { name: 'Open website' });
  await act(async () => { resolve({ ok: true, value: [] }); });
  expect(await screen.findByRole('link', { name: 'Open Connected project' })).toBeTruthy();
});

it('keeps uncertain website setup guidance visible through disconnect and reconnect', async () => {
  let resolve!: (result: { ok: false; reason: string }) => void;
  const f = mobileFixture(() => new Promise(done => { resolve = done; }));
  fireEvent.click(await screen.findByRole('button', { name: /First work/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open website' }));
  await act(async () => { resolve({ ok: false, reason: 'uncertain' }); f.setState('offline'); });
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connection lost before Fleet confirmed setup. This website may already be connected. Reconnect and check Websites, or safely retry Open website.');
  expect(screen.getByRole('button', { name: 'Open website' })).toHaveProperty('disabled', true);
  await act(async () => { f.setState('ready'); });
  expect(screen.getByRole('alert').textContent).toContain('may already be connected');
  expect(screen.getByRole('button', { name: 'Open website' })).toHaveProperty('disabled', false);
  expect(f.request.mock.calls.filter(call => call[0] === 'preview:open')).toHaveLength(1);
});
