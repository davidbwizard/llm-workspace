import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteConfig } from '../../src/main/remote/config.ts';
import { PreviewManager } from '../../src/main/remote/previewManager.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-preview-'))); dirs.push(project);
  let config: RemoteConfig = { enabled: true, port: 43180, origin: 'https://mac.tail.ts.net', login: 'owner', previews: [] };
  const status: { TCP: Record<string, unknown>; Web: Record<string, unknown>; AllowFunnel: Record<string, boolean>; Foreground?: unknown; Services?: unknown } = { TCP: {}, Web: {}, AllowFunnel: {} };
  const mapping = (port: number, target = 'http://127.0.0.1:43181') => {
    status.TCP[port] = { HTTPS: true };
    status.Web[`mac.tail.ts.net:${port}`] = { Handlers: { '/': { Proxy: target } } };
  };
  const run = vi.fn(async (args: string[]) => {
    if (args.join(' ') === 'serve status --json') return JSON.stringify(status);
    const port = Number(args.find(a => a.startsWith('--https='))?.split('=')[1]);
    if (args.at(-1) === 'off') { delete status.TCP[port]; delete status.Web[`mac.tail.ts.net:${port}`]; return ''; }
    if (args[0] !== 'serve' || args[1] !== '--bg' || !port || args.at(-1) !== 'http://127.0.0.1:43181') throw new Error('Unexpected command');
    mapping(port); return '';
  });
  const save = vi.fn(async (next: RemoteConfig, expected: RemoteConfig) => { expect(config).toEqual(expected); config = next; });
  const inspectTarget = vi.fn(async (): Promise<{ host: '127.0.0.1' | '::1' }> => ({ host: '127.0.0.1' }));
  const ensureGateway = vi.fn(async () => 43181);
  const manager = new PreviewManager({ getConfig: () => config, save, ensureGateway, inspectTarget, run });
  return { project, status, mapping, run, save, inspectTarget, ensureGateway, manager, get config() { return config; }, set config(value: RemoteConfig) { config = value; } };
}
it('creates a private preview, preserving URL path, query and fragment', async () => {
  const f = setup();
  expect(await f.manager.open(f.project, 'http://localhost:3000/foo?q=hello#here')).toEqual({ ok: true, url: 'https://mac.tail.ts.net:8444/foo?q=hello#here' });
  expect(f.config.previews).toEqual([expect.objectContaining({ project: f.project, localPort: 3000, localHost: '127.0.0.1', managed: true, url: 'https://mac.tail.ts.net:8444' })]);
  expect(f.inspectTarget).toHaveBeenCalledWith(f.project, 3000);
  expect(f.run).toHaveBeenCalledWith(['serve', '--bg', '--https=8444', 'http://127.0.0.1:43181']);
});
it('serializes duplicate requests and checks the live managed mapping before reuse', async () => {
  const f = setup();
  const results = await Promise.all([f.manager.open(f.project, 'http://localhost:3000/a'), f.manager.open(f.project, 'http://127.0.0.1:3000/b')]);
  expect(results).toEqual([{ ok: true, url: 'https://mac.tail.ts.net:8444/a' }, { ok: true, url: 'https://mac.tail.ts.net:8444/b' }]);
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.inspectTarget).toHaveBeenCalledTimes(2);
  f.mapping(8444, 'http://127.0.0.1:9999');
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
});
it('records the verified IPv6 loopback listener', async () => {
  const f = setup(); f.inspectTarget.mockResolvedValue({ host: '::1' });
  expect(await f.manager.open(f.project, 'http://[::1]:3000/')).toMatchObject({ ok: true });
  expect(f.config.previews[0]).toMatchObject({ localHost: '::1' });
});
it('reserves all configured TCP, Web, Funnel, foreground, service and Fleet ports', async () => {
  const f = setup(); f.config.origin = 'https://mac.tail.ts.net:8444';
  f.mapping(8443); f.status.TCP[8445] = { TCPForward: '127.0.0.1:22' };
  f.status.Web['mac.tail.ts.net:8446'] = { Handlers: { '/': { Text: 'existing' } } };
  f.status.AllowFunnel['mac.tail.ts.net:8447'] = true;
  f.status.Foreground = { session: { TCP: { 8448: { HTTPS: true } } } };
  f.status.Services = { 'svc:example': { TCP: { 8449: { HTTPS: true } } } };
  f.config.previews = [{ id: 'old', project: f.project, label: 'Old', localPort: 4000, url: 'https://mac.tail.ts.net:8450' }];
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toEqual({ ok: true, url: 'https://mac.tail.ts.net:8451/' });
  expect(f.status.Web['mac.tail.ts.net:8443']).toEqual({ Handlers: { '/': { Proxy: 'http://127.0.0.1:43181' } } });
});
it('reuses manual previews only when the direct target is verified and private', async () => {
  const f = setup(); f.config.previews = [{ id: 'old', project: f.project, label: 'Old', localPort: 3000, url: 'https://mac.tail.ts.net:8443' }];
  f.mapping(8443, 'http://127.0.0.1:3000');
  expect(await f.manager.open(f.project, 'http://localhost:3000/test')).toEqual({ ok: true, url: 'https://mac.tail.ts.net:8443/test' });
  expect(f.save).not.toHaveBeenCalled();
  f.status.AllowFunnel['mac.tail.ts.net:8443'] = true;
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false, message: expect.stringMatching(/Funnel/) });
});
it.each(['https://localhost:3000', 'http://example.com:3000', 'http://user:secret@localhost:3000', 'http://localhost:80', null])('rejects unsafe URL %s without CLI mutations', async url => {
  const f = setup(); expect(await f.manager.open(f.project, url)).toMatchObject({ ok: false }); expect(f.run).not.toHaveBeenCalled();
});
it('rejects missing projects, disabled access and unowned listeners', async () => {
  const f = setup();
  expect(await f.manager.open('/does-not-exist', 'http://localhost:3000')).toMatchObject({ ok: false });
  f.config.enabled = false;
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  f.config.enabled = true; f.inspectTarget.mockRejectedValue(new Error('Not owned by project'));
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  expect(f.run).not.toHaveBeenCalled();
});
it('fails closed for malformed and oversized Tailscale status', async () => {
  const f = setup();
  for (const output of ['not json', '{"TCP":[]}', '{"Unexpected":{}}', '{"AllowFunnel":{"invalid":false}}', ' '.repeat(1024 * 1024 + 1)]) {
    f.run.mockResolvedValueOnce(output);
    expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  }
  expect(f.save).not.toHaveBeenCalled();
});
it('reports CLI failure without exposing CLI output or private URLs', async () => {
  const f = setup(); f.run.mockRejectedValueOnce(new Error('secret query and token'));
  const result = await f.manager.open(f.project, 'http://localhost:3000/?secret');
  expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toMatch(/secret|token/); expect(f.save).not.toHaveBeenCalled();
});
it('rolls back only its own exact mapping when save fails', async () => {
  const f = setup(); f.mapping(8443); f.save.mockRejectedValueOnce(new Error('Disk unavailable'));
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  expect(f.status.TCP[8444]).toBeUndefined(); expect(f.status.TCP[8443]).toEqual({ HTTPS: true });
  expect(f.run).toHaveBeenCalledWith(['serve', '--https=8444', 'off']);
});
it('leaves a concurrently replaced mapping alone and reports uncertain cleanup', async () => {
  const f = setup(); f.save.mockImplementationOnce(async () => { f.mapping(8444, 'http://127.0.0.1:9000'); throw new Error('Settings changed'); });
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false, message: expect.stringMatching(/uncertain|changed/i) });
  expect(f.status.Web['mac.tail.ts.net:8444']).toEqual({ Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } });
  expect(f.run.mock.calls.some(([args]) => args.at(-1) === 'off')).toBe(false);
});
it('preserves fresh settings and provides a snapshot for compare-and-save', async () => {
  const f = setup(); f.ensureGateway.mockImplementationOnce(async () => { f.config = { ...f.config, previews: [{ id: 'other', project: f.project, label: 'Other', localPort: 4000, url: 'https://mac.tail.ts.net:8455' }] }; return 43181; });
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: true });
  expect(f.config.previews).toHaveLength(2); expect(f.config.previews[0]!.id).toBe('other');
  expect(f.save.mock.calls[0]![1].previews).toHaveLength(1);
});
it('does not create a mapping after the selected session becomes stale', async () => {
  const f = setup(); let current = true;
  f.ensureGateway.mockImplementationOnce(async () => { current = false; return 43181; });
  expect(await f.manager.open(f.project, 'http://localhost:3000', () => current)).toMatchObject({ ok: false, message: expect.stringMatching(/session/i) });
  expect(f.run.mock.calls.some(([args]) => args[1] === '--bg')).toBe(false); expect(f.save).not.toHaveBeenCalled();
});
it('rolls back if the selected session becomes stale during Serve setup', async () => {
  const f = setup(); let current = true; const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => { const result = await run(args); if (args[1] === '--bg') current = false; return result; });
  expect(await f.manager.open(f.project, 'http://localhost:3000', () => current)).toMatchObject({ ok: false });
  expect(f.status.TCP[8444]).toBeUndefined(); expect(f.save).not.toHaveBeenCalled();
});
it('handles a CLI timeout after applying a mapping by inspecting and removing that exact mapping', async () => {
  const f = setup(); const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => { const result = await run(args); if (args[1] === '--bg') throw new Error('Timeout'); return result; });
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  expect(f.status.TCP[8444]).toBeUndefined(); expect(f.save).not.toHaveBeenCalled();
});
it('refuses a new mapping that becomes public without deleting user-changed Funnel configuration', async () => {
  const f = setup(); const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => { const result = await run(args); if (args[1] === '--bg') f.status.AllowFunnel['mac.tail.ts.net:8444'] = true; return result; });
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false, message: expect.stringMatching(/Funnel.*uncertain/) });
  expect(f.save).not.toHaveBeenCalled(); expect(f.run.mock.calls.some(([args]) => args.at(-1) === 'off')).toBe(false);
});
it('reports failed rollback instead of claiming the mapping was removed', async () => {
  const f = setup(); f.save.mockRejectedValueOnce(new Error('Disk unavailable')); const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => { if (args.at(-1) === 'off') throw new Error('Permission denied'); return run(args); });
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false, message: expect.stringMatching(/uncertain/) });
  expect(f.status.TCP[8444]).toBeDefined();
});
it('rejects previews with additional path handlers, including on a managed mapping', async () => {
  const f = setup(); await f.manager.open(f.project, 'http://localhost:3000');
  f.status.Web['mac.tail.ts.net:8444'] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:43181' }, '/admin': { Proxy: 'http://127.0.0.1:9000' } } };
  expect(await f.manager.open(f.project, 'http://localhost:3000/admin')).toMatchObject({ ok: false });
});
it('does not overwrite settings if the remote connection changes during setup', async () => {
  const f = setup(); const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async args => { const result = await run(args); if (args[1] === '--bg') f.config = { ...f.config, login: 'another-owner' }; return result; });
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  expect(f.config.login).toBe('another-owner'); expect(f.save).not.toHaveBeenCalled(); expect(f.status.TCP[8444]).toBeUndefined();
});
it('updates a managed preview after its project listener switches loopback families', async () => {
  const f = setup(); await f.manager.open(f.project, 'http://localhost:3000');
  f.inspectTarget.mockResolvedValue({ host: '::1' });
  expect(await f.manager.open(f.project, 'http://[::1]:3000/restarted')).toEqual({ ok: true, url: 'https://mac.tail.ts.net:8444/restarted' });
  expect(f.config.previews).toHaveLength(1); expect(f.config.previews[0]?.localHost).toBe('::1');
  expect(f.run.mock.calls.filter(([args]) => args[1] === '--bg')).toHaveLength(1);
  expect(f.save.mock.calls[1]?.[1].previews[0]?.localHost).toBe('127.0.0.1');
});
it('keeps the existing mapping if updating its listener address cannot be saved', async () => {
  const f = setup(); await f.manager.open(f.project, 'http://localhost:3000');
  f.inspectTarget.mockResolvedValue({ host: '::1' }); f.save.mockRejectedValueOnce(new Error('Settings changed'));
  expect(await f.manager.open(f.project, 'http://[::1]:3000')).toMatchObject({ ok: false });
  expect(f.config.previews[0]?.localHost).toBe('127.0.0.1'); expect(f.status.TCP[8444]).toBeDefined();
  expect(f.run.mock.calls.some(([args]) => args.at(-1) === 'off')).toBe(false);
});
it('accepts Tailscale’s null status for an unconfigured node', async () => {
  const f = setup(); f.run.mockResolvedValueOnce('null\n').mockResolvedValueOnce('null\n');
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toEqual({ ok: true, url: 'https://mac.tail.ts.net:8444/' });
});
it('refuses a full preview list and exhausted external ports without mutations', async () => {
  const f = setup();
  f.config.previews = Array.from({ length: 32 }, (_, i) => ({ id: 'p' + i, project: f.project, label: 'Site', localPort: 4000 + i, url: 'https://mac.tail.ts.net:' + (8500 + i) }));
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  f.config.previews = [];
  for (let port = 8444; port <= 8499; port++) f.status.TCP[port] = { HTTPS: true };
  expect(await f.manager.open(f.project, 'http://localhost:3000')).toMatchObject({ ok: false });
  expect(f.run.mock.calls.some(([args]) => args[1] === '--bg')).toBe(false); expect(f.save).not.toHaveBeenCalled();
});
