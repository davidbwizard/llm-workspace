import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object } from '../../core/remote.ts';
export interface PreviewConfig { id: string; project: string; label: string; localPort: number; url: string }
export interface RemoteConfig { enabled: boolean; port: number; origin: string; login: string; previews: PreviewConfig[] }
export const DEFAULT_REMOTE: RemoteConfig = { enabled: false, port: 43180, origin: '', login: '', previews: [] };
function port(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535; }
function endpoint(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Enter a private HTTPS address.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin) throw new Error('Use the exact Tailscale HTTPS origin without a path or trailing slash.');
  return url;
}
export function parseRemoteConfig(value: unknown): RemoteConfig {
  if (value === undefined) return { ...DEFAULT_REMOTE, previews: [] };
  const p = object(value);
  if (!p || Object.keys(p).some(k => !['enabled', 'port', 'origin', 'login', 'previews'].includes(k)) || typeof p.enabled !== 'boolean' || !port(p.port) || typeof p.login !== 'string' || p.login.length > 254 || /[\s,\x00-\x1f]/.test(p.login) || !Array.isArray(p.previews) || p.previews.length > 32) throw new Error('Invalid remote access settings.');
  if (!p.enabled && p.origin === '' && p.login === '' && !p.previews.length) return { ...DEFAULT_REMOTE, port: p.port, previews: [] };
  const origin = endpoint(p.origin);
  if (!p.login) throw new Error('Enter your Tailscale login.');
  const ids = new Set<string>(); const ports = new Set<string>();
  const previews = p.previews.map(raw => {
    const q = object(raw);
    if (!q || Object.keys(q).some(k => !['id', 'project', 'label', 'localPort', 'url'].includes(k)) || typeof q.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(q.id) || typeof q.project !== 'string' || !isAbsolute(q.project) || q.project.length > 4096 || typeof q.label !== 'string' || !q.label.trim() || q.label.length > 80 || !port(q.localPort) || q.localPort === p.port) throw new Error('Invalid preview settings.');
    const url = endpoint(q.url);
    if (url.hostname !== origin.hostname || url.origin === origin.origin || ids.has(q.id) || ports.has(url.port)) throw new Error('Previews need unique HTTPS ports on this Mac, separate from Fleet.');
    ids.add(q.id); ports.add(url.port);
    return { id: q.id, project: q.project, label: q.label, localPort: q.localPort, url: url.origin };
  });
  return { enabled: p.enabled, port: p.port, origin: origin.origin, login: p.login, previews };
}
export function readRemoteConfig(path: string): RemoteConfig {
  try { return parseRemoteConfig(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseRemoteConfig(undefined); throw error; }
}
export function writeRemoteConfig(path: string, value: unknown): RemoteConfig {
  const config = parseRemoteConfig(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  return config;
}
