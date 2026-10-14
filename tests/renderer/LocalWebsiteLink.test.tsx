import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalWebsiteContext, LocalWebsiteInput } from '../../src/renderer/components/LocalWebsiteLink.tsx';
import { MarkdownText } from '../../src/renderer/components/ConversationView.tsx';
import QRCode from 'qrcode';
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const local = 'http://localhost:3000/path?q=hello#section';
const remote = 'https://mac.tail.ts.net:8443/path?q=hello#section';
it('preserves desktop localhost links and only shares after the phone action is clicked', async () => {
  const open = vi.fn(async () => ({ ok: true as const, url: remote }));
  const copy = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
  render(<LocalWebsiteContext.Provider value={{ open }}><MarkdownText text={`[My site](${local})`} /></LocalWebsiteContext.Provider>);
  expect(screen.getByRole('link', { name: 'My site' }).getAttribute('href')).toBe(local);
  expect(open).not.toHaveBeenCalled(); expect(QRCode.toDataURL).not.toHaveBeenCalled();
  expect(screen.getByText(/Makes this site accessible to your Tailscale devices/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open on phone' }));
  expect(await screen.findByRole('link', { name: 'Open website' })).toHaveProperty('href', remote);
  expect(open).toHaveBeenCalledWith(local);
  expect(await screen.findByAltText('Scan to open this website on your phone')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(remote));
});
it('replaces mobile localhost navigation with setup and reports failures inline', async () => {
  const open = vi.fn(async () => ({ ok: false as const, message: 'Start the development server on your Mac.' }));
  render(<LocalWebsiteContext.Provider value={{ open, mobile: true }}><MarkdownText text={`[My site](${local})`} /></LocalWebsiteContext.Provider>);
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Open website/ }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Start the development server on your Mac.');
});
it('leaves external links alone and refuses non-private result URLs', async () => {
  const open = vi.fn(async () => ({ ok: true as const, url: 'https://public.example.com/' }));
  render(<LocalWebsiteContext.Provider value={{ open }}><MarkdownText text={`[External](https://example.com) [Local](${local})`} /></LocalWebsiteContext.Provider>);
  expect(screen.getByRole('link', { name: 'External' }).getAttribute('href')).toBe('https://example.com');
  fireEvent.click(screen.getByRole('button', { name: 'Open on phone' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Fleet returned an invalid private website address.');
  expect(screen.queryByRole('link', { name: 'Open website' })).toBeNull();
});
it('ignores a pending result after the session context changes', async () => {
  let resolve!: (value: { ok: true; url: string }) => void;
  const first = { open: vi.fn(() => new Promise<{ ok: true; url: string }>(done => { resolve = done; })) };
  const second = { open: vi.fn(async () => ({ ok: true as const, url: remote })) };
  const view = render(<LocalWebsiteContext.Provider value={first}><MarkdownText text={`[Site](${local})`} /></LocalWebsiteContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open on phone' }));
  expect(screen.getByRole('status').textContent).toContain('Connecting');
  view.rerender(<LocalWebsiteContext.Provider value={second}><MarkdownText text={`[Site](${local})`} /></LocalWebsiteContext.Provider>);
  await act(async () => { resolve({ ok: true, url: remote }); });
  expect(screen.queryByRole('link', { name: 'Open website' })).toBeNull();
});
it('accepts pasted localhost addresses without sharing until clicked', async () => {
  const open = vi.fn(async () => ({ ok: true as const, url: remote }));
  render(<LocalWebsiteContext.Provider value={{ open, mobile: true }}><LocalWebsiteInput /></LocalWebsiteContext.Provider>);
  fireEvent.change(screen.getByLabelText('Website address on your Mac'), { target: { value: local } });
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open website' }));
  expect(await screen.findByRole('link', { name: 'Open website' })).toBeTruthy();
  expect(open).toHaveBeenCalledWith(local);
});

it('reports a browser clipboard failure without claiming the link was copied', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('Clipboard denied'); }) }, configurable: true });
  try {
    render(<LocalWebsiteContext.Provider value={{ open: async () => ({ ok: true, url: remote }), mobile: true }}><MarkdownText text={`[Site](${local})`} /></LocalWebsiteContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open website' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  } finally { error.mockRestore(); }
});
