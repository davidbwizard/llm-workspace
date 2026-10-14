import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { parseLocalPreviewUrl, type PreviewOpenResult } from '../../core/preview.ts';
import { object } from '../../core/remote.ts';
import type { PreviewConfig, RemoteConfig } from './config.ts';
import { inspectPreviewTarget } from './previewTarget.ts';

const STATUS_LIMIT = 1024 * 1024;
type RecordValue = Record<string, unknown>;
type Section = { tcp: RecordValue; web: RecordValue; funnel: RecordValue };
type ServeStatus = { root: Section; sections: Section[]; ports: Set<number> };
type Dependencies = {
  getConfig: () => RemoteConfig;
  /** Compare expected with current settings inside the same serialized save operation. */
  save: (config: RemoteConfig, expected: RemoteConfig) => Promise<unknown>;
  ensureGateway: () => Promise<number>;
  inspectTarget?: typeof inspectPreviewTarget;
  run?: (args: string[]) => Promise<string>;
};
class PreviewError extends Error {}
function fail(message: string): never { throw new PreviewError(message); }
function runTailscale(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tailscale', args, { encoding: 'utf8', timeout: 15_000, maxBuffer: STATUS_LIMIT }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}
function record(value: unknown): RecordValue {
  const result = object(value);
  if (!result) fail('Cannot safely read Tailscale Serve settings.');
  return result;
}
function keys(value: RecordValue, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Tailscale Serve settings use an unsupported format.');
}
function port(value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) fail('Cannot safely read Tailscale Serve ports.');
  return Number(value);
}
function endpointPort(value: string): number {
  const match = /^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):([1-9]\d{0,4})$/.exec(value);
  if (!match) fail('Cannot safely read Tailscale Serve endpoints.');
  return port(match[1]!);
}
function parseStatus(raw: string): ServeStatus {
  if (Buffer.byteLength(raw, 'utf8') > STATUS_LIMIT) fail('Tailscale Serve settings are too large to inspect safely.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail('Cannot safely read Tailscale Serve settings.'); }
  const sections: Section[] = []; const ports = new Set<number>();
  function section(value: unknown, kind: 'root' | 'foreground' | 'service'): Section {
    const source = record(value);
    keys(source, kind === 'service' ? ['TCP', 'Web', 'Tun'] : kind === 'foreground' ? ['TCP', 'Web', 'AllowFunnel'] : ['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services']);
    if ('Tun' in source && typeof source.Tun !== 'boolean') fail('Cannot safely read Tailscale Serve settings.');
    const result: Section = { tcp: source.TCP === undefined ? {} : record(source.TCP), web: source.Web === undefined ? {} : record(source.Web), funnel: source.AllowFunnel === undefined ? {} : record(source.AllowFunnel) };
    sections.push(result);
    for (const [key, value] of Object.entries(result.tcp)) {
      ports.add(port(key)); const handler = record(value);
      keys(handler, ['HTTPS', 'HTTP', 'TCPForward', 'TerminateTLS', 'ProxyProtocol']);
      for (const [name, field] of Object.entries(handler)) {
        if ((['HTTPS', 'HTTP'].includes(name) && typeof field !== 'boolean') || (['TCPForward', 'TerminateTLS'].includes(name) && typeof field !== 'string') || (name === 'ProxyProtocol' && ![0, 1, 2].includes(field as number))) fail('Cannot safely read Tailscale Serve settings.');
      }
    }
    for (const [key, value] of Object.entries(result.web)) {
      ports.add(endpointPort(key)); const web = record(value); keys(web, ['Handlers']);
      for (const [mount, value] of Object.entries(record(web.Handlers))) {
        if (!mount.startsWith('/')) fail('Cannot safely read Tailscale Serve settings.');
        const handler = record(value); keys(handler, ['Path', 'Proxy', 'Text', 'AcceptAppCaps', 'Redirect']);
        for (const [name, field] of Object.entries(handler)) {
          if (name === 'AcceptAppCaps' ? !Array.isArray(field) || field.some(cap => typeof cap !== 'string') : typeof field !== 'string') fail('Cannot safely read Tailscale Serve settings.');
        }
      }
    }
    for (const [key, allowed] of Object.entries(result.funnel)) {
      ports.add(endpointPort(key)); if (typeof allowed !== 'boolean') fail('Cannot safely read Tailscale Funnel settings.');
    }
    if (source.Foreground !== undefined) for (const child of Object.values(record(source.Foreground))) section(child, 'foreground');
    if (source.Services !== undefined) for (const child of Object.values(record(source.Services))) section(child, 'service');
    return result;
  }
  return { root: section(value === null ? {} : value, 'root'), sections, ports };
}
function usesPort(section: Section, selected: number): boolean {
  return Object.hasOwn(section.tcp, selected) || Object.keys(section.web).some(key => endpointPort(key) === selected) || Object.keys(section.funnel).some(key => endpointPort(key) === selected);
}
function funnelEnabled(status: ServeStatus, selected: number): boolean {
  return status.sections.some(section => Object.entries(section.funnel).some(([key, value]) => value === true && endpointPort(key) === selected));
}
/** Require a single root mount, so a nested mount cannot send the requested path elsewhere. */
function exactMapping(status: ServeStatus, hostname: string, selected: number, target: string): boolean {
  if (funnelEnabled(status, selected) || status.sections.some(section => section !== status.root && usesPort(section, selected))) return false;
  const tcp = object(status.root.tcp[selected]);
  if (!tcp || tcp.HTTPS !== true || Object.entries(tcp).some(([key, value]) => key !== 'HTTPS' && value !== false && value !== '' && value !== 0)) return false;
  const endpoints = Object.keys(status.root.web).filter(key => endpointPort(key) === selected);
  if (endpoints.length !== 1 || endpoints[0] !== `${hostname}:${selected}`) return false;
  const handlers = record(record(status.root.web[endpoints[0]!]).Handlers);
  const handler = object(handlers['/']);
  return Object.keys(handlers).length === 1 && !!handler && Object.keys(handler).length === 1 && (handler.Proxy === target || handler.Proxy === target + '/');
}
function reserved(config: RemoteConfig, status: ServeStatus): Set<number> {
  const ports = new Set(status.ports);
  ports.add(config.port); ports.add(Number(new URL(config.origin).port || 443));
  for (const preview of config.previews) ports.add(Number(new URL(preview.url).port || 443));
  return ports;
}
async function canonical(project: string): Promise<string> {
  if (typeof project !== 'string' || project.length > 4096 || !isAbsolute(project)) fail('The project directory is unavailable.');
  try { const path = await realpath(project); if (!(await stat(path)).isDirectory()) fail('The project directory is unavailable.'); return path; }
  catch { fail('The project directory is unavailable.'); }
}
async function matchingPreview(config: RemoteConfig, project: string, port: number): Promise<PreviewConfig | undefined> {
  for (const preview of config.previews) {
    if (preview.localPort !== port) continue;
    try { if (await realpath(preview.project) === project) return preview; }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return undefined;
}
function snapshot(config: RemoteConfig): RemoteConfig { return { ...config, previews: config.previews.map(preview => ({ ...preview })) }; }
function unchangedConnection(before: RemoteConfig, after: RemoteConfig): boolean {
  return after.enabled && before.port === after.port && before.origin === after.origin && before.login === after.login;
}

export class PreviewManager {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly run: (args: string[]) => Promise<string>;
  private readonly inspectTarget: typeof inspectPreviewTarget;
  constructor(private readonly deps: Dependencies) { this.run = deps.run ?? runTailscale; this.inspectTarget = deps.inspectTarget ?? inspectPreviewTarget; }
  open(project: string, rawUrl: unknown, isCurrent: () => boolean = () => true): Promise<PreviewOpenResult> {
    const operation = this.queue.then(() => this.openSerialized(project, rawUrl, isCurrent));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async status(): Promise<ServeStatus> {
    let output: string;
    try { output = await this.run(['serve', 'status', '--json']); }
    catch { fail('Cannot read Tailscale Serve settings. Check that Tailscale is installed and connected.'); }
    return parseStatus(output);
  }
  private async inspect(project: string, port: number) {
    try { return await this.inspectTarget(project, port); }
    catch { fail('Cannot verify a running server owned by this project. Start its development server and try again.'); }
  }
  private async rollback(hostname: string, selected: number, target: string): Promise<boolean> {
    try {
      const status = await this.status();
      if (!status.ports.has(selected)) return true;
      if (!exactMapping(status, hostname, selected, target)) return false;
      // Only this observed, exact root mapping may be removed; never reset Serve globally.
      await this.run(['serve', `--https=${selected}`, 'off']);
      return !(await this.status()).ports.has(selected);
    } catch { return false; }
  }
  private async openSerialized(project: string, rawUrl: unknown, isCurrent: () => boolean): Promise<PreviewOpenResult> {
    let attempted: { hostname: string; port: number; target: string } | undefined;
    try {
      if (!isCurrent()) fail('The selected session changed. Select its current session and try again.');
      const local = parseLocalPreviewUrl(rawUrl);
      if (!local) fail('Use an HTTP localhost link with an explicit development port (1024–65535).');
      const initial = snapshot(this.deps.getConfig());
      if (!initial.enabled) fail('Enable phone access in Fleet settings first.');
      const root = await canonical(project);
      if (local.port === initial.port) fail('Fleet’s own server cannot be used as a website preview.');
      const listener = await this.inspect(root, local.port);
      const existing = await matchingPreview(initial, root, local.port);
      if (existing) {
        const endpoint = new URL(existing.url);
        const selected = Number(endpoint.port || 443);
        let target: string;
        if (existing.managed) {
          const gatewayPort = await this.deps.ensureGateway();
          target = `http://127.0.0.1:${gatewayPort}`;
        } else target = `http://${listener.host === '::1' ? '[::1]' : listener.host}:${local.port}`;
        const status = await this.status();
        if (funnelEnabled(status, selected)) fail('This preview has public Tailscale Funnel enabled. Disable Funnel before opening it privately.');
        if (!exactMapping(status, endpoint.hostname, selected, target)) fail('This preview’s Tailscale mapping has changed. Check its private Serve settings.');
        if (JSON.stringify(initial) !== JSON.stringify(this.deps.getConfig())) fail('Phone access settings changed. Try again.');
        if (!isCurrent()) fail('The selected session changed. Select its current session and try again.');
        if (existing.managed && existing.localHost !== listener.host) {
          const updated = { ...initial, previews: initial.previews.map(preview => preview.id === existing.id ? { ...preview, localHost: listener.host } : preview) };
          try { await this.deps.save(updated, initial); }
          catch { fail('The preview listener settings could not be saved. Try again.'); }
          if (!isCurrent()) fail('The selected session changed. Select its current session and try again.');
        }
        return { ok: true, url: endpoint.origin + local.path };
      }
      if (initial.previews.length >= 32) fail('Fleet supports up to 32 website previews. Remove an unused preview first.');
      await this.status();
      const gatewayPort = await this.deps.ensureGateway();
      if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535 || gatewayPort === local.port) fail('The private preview gateway is unavailable on this port.');
      // Gateway startup can await other work. Read settings and Serve again before choosing a port.
      const current = snapshot(this.deps.getConfig());
      if (!unchangedConnection(initial, current)) fail('Phone access settings changed. Try again.');
      const status = await this.status();
      const occupied = reserved(current, status); occupied.add(gatewayPort); occupied.add(local.port);
      let selected = 8444;
      while (selected <= 8499 && occupied.has(selected)) selected++;
      if (selected > 8499) fail('No unused private preview port is available between 8444 and 8499.');
      const endpoint = new URL(current.origin); endpoint.port = String(selected);
      const target = `http://127.0.0.1:${gatewayPort}`;
      if (!isCurrent()) fail('The selected session changed. Select its current session and try again.');
      attempted = { hostname: endpoint.hostname, port: selected, target };
      try { await this.run(['serve', '--bg', `--https=${selected}`, target]); }
      catch { fail('Tailscale could not create the private preview. Check that Serve and HTTPS are available.'); }
      const verified = await this.status();
      if (funnelEnabled(verified, selected)) fail('Tailscale Funnel was detected on the new preview. It cannot be opened privately.');
      if (!exactMapping(verified, endpoint.hostname, selected, target)) fail('Tailscale did not confirm the expected private preview mapping.');
      const fresh = snapshot(this.deps.getConfig());
      if (!unchangedConnection(current, fresh)) fail('Phone access settings changed. Try again.');
      if (fresh.previews.length >= 32 || reserved(fresh, { ...verified, ports: new Set() }).has(selected) || await matchingPreview(fresh, root, local.port)) fail('Preview settings changed during setup. Try again.');
      const preview: PreviewConfig = { id: randomUUID(), project: root, label: (basename(root) || 'Website').slice(0, 80), localPort: local.port, localHost: listener.host, managed: true, url: endpoint.origin };
      if (!isCurrent()) fail('The selected session changed. Select its current session and try again.');
      try { await this.deps.save({ ...fresh, previews: [...fresh.previews, preview] }, fresh); }
      catch { fail('The private preview settings could not be saved. Try again.'); }
      return { ok: true, url: endpoint.origin + local.path };
    } catch (error) {
      let message = error instanceof PreviewError ? error.message : 'The private preview could not be opened. Check phone access settings and try again.';
      if (attempted && !await this.rollback(attempted.hostname, attempted.port, attempted.target)) message += ' Cleanup is uncertain because the Tailscale mapping changed or could not be checked. Review Serve settings before retrying.';
      return { ok: false, message };
    }
  }
}
