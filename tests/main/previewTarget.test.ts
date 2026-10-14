import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execute }));
import { inspectPreviewTarget } from '../../src/main/remote/previewTarget.ts';
afterEach(() => vi.clearAllMocks());
function fixture(cwd: string, listener = 'p123\nn127.0.0.1:5199\n') {
  execute.mockImplementation((_file, args, _options, callback) => callback(null, args.includes('cwd') ? `p123\nn${cwd}\n` : listener, ''));
}
it('validates project ownership and discovers IPv6-only loopback listeners', async () => {
  const server = createServer(); await new Promise<void>(r => server.listen(0, '::1', r));
  try {
    const project = await realpath(process.cwd()); fixture(project, 'p123\nn[::1]:5199\n');
    expect(await inspectPreviewTarget(project, (server.address() as { port: number }).port)).toEqual({ host: '::1' });
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
it('rejects unrelated listener directories and missing listeners', async () => {
  fixture('/unrelated'); await expect(inspectPreviewTarget(process.cwd(), 5199)).rejects.toThrow(/project/i);
  fixture(process.cwd(), ''); await expect(inspectPreviewTarget(process.cwd(), 5199)).rejects.toThrow(/listen/i);
});
it('rejects invalid ports before invoking a subprocess', async () => {
  await expect(inspectPreviewTarget(process.cwd(), 0)).rejects.toThrow(/port/i);
  expect(execute).not.toHaveBeenCalled();
});
it('accepts canonical descendant directories and coalesces only in-flight checks', async () => {
  const server = createServer(socket => socket.end()); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = (server.address() as { port: number }).port; fixture(process.cwd() + '/src');
    const first = inspectPreviewTarget(process.cwd(), port); const second = inspectPreviewTarget(process.cwd(), port);
    expect(first).toBe(second); expect(await first).toEqual({ host: '127.0.0.1' });
    fixture('/unrelated'); await expect(inspectPreviewTarget(process.cwd(), port)).rejects.toThrow(/project/i);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
