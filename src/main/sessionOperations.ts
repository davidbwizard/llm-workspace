import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { StageResult } from './staging.ts';
import { MOBILE_IMAGE_LIMIT, object, type OperationResult, type RemoteOperation } from '../core/remote.ts';

export interface SessionIdentity {
  pid: number;
  sessionId: string | null;
  provider: 'claude' | 'codex';
  started: string;
  tmux: string | null;
}
export interface SessionOperationDeps {
  list(): Array<{ pid: number; sessionId: string | null; cwd: string | null; provider: string; [key: string]: unknown }>;
  identity(pid: number): SessionIdentity | null;
  projects(): string[];
  favorites?(): string[];
  conversation(sessionId: string, cursor: unknown): Promise<unknown> | unknown;
  live(pid: number): unknown;
  send(pid: number, text: string, expectedSessionId: string, client?: string, images?: string[]): Promise<unknown>;
  answerClaude(pid: number, key: string, answer: unknown, client?: string): Promise<unknown> | unknown;
  answerCodex(pid: number, key: string, answer: unknown, client?: string): Promise<unknown> | unknown;
  images?: { stage(bytes: Uint8Array): Promise<StageResult>; discard(id: string): Promise<void> };
  close?(target: SessionIdentity, client: string, current: () => boolean): Promise<unknown>;
  launch(provider: 'claude' | 'codex', cwd: string, name?: string): Promise<unknown> | unknown;
}
function same(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.pid === b.pid && a.sessionId === b.sessionId && a.provider === b.provider && a.started === b.started && a.tmux === b.tmux;
}
function canonical(path: string): string | null {
  if (!isAbsolute(path)) return null;
  try { const real = realpathSync(path); return statSync(real).isDirectory() ? real : null; }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

/** Only server-issued handles cross the network; identity is read again at use. */
export class SessionOperations {
  private handles = new Map<string, SessionIdentity>();
  private projectHandles = new Map<string, { source: string; real: string }>();
  private uploads = new Map<string, Map<string, string>>();
  constructor(readonly dependencies: SessionOperationDeps) {}
  list() {
    const keep = new Set<string>();
    const rows = this.dependencies.list().map(row => {
      const identity = this.dependencies.identity(row.pid);
      let handle: string | null = null;
      if (identity?.started && identity.sessionId === row.sessionId && identity.provider === row.provider) {
        handle = [...this.handles].find(([, prior]) => same(prior, identity))?.[0] ?? randomUUID();
        this.handles.set(handle, identity); keep.add(handle);
      }
      return { ...row, handle, controllable: !!handle && !!identity?.tmux };
    });
    for (const key of this.handles.keys()) if (!keep.has(key)) this.handles.delete(key);
    return rows;
  }
  resolve(handle: string): SessionIdentity | null {
    const saved = this.handles.get(handle);
    if (!saved) return null;
    const current = this.dependencies.identity(saved.pid);
    return current && same(saved, current) ? current : null;
  }
  projects(): Array<{ id: string; label: string; favorite: boolean }> {
    const result: Array<{ id: string; label: string; favorite: boolean }> = [];
    const favorites = new Set((this.dependencies.favorites?.() ?? []).map(canonical).filter(Boolean));
    const keep = new Set<string>();
    for (const source of new Set(this.dependencies.projects())) {
      const real = canonical(source);
      if (!real) continue;
      const id = [...this.projectHandles].find(([, p]) => p.source === source && p.real === real)?.[0] ?? randomUUID();
      this.projectHandles.set(id, { source, real }); keep.add(id);
      result.push({ id, label: `${basename(real)} — ${real}`, favorite: favorites.has(real) });
    }
    for (const key of this.projectHandles.keys()) if (!keep.has(key)) this.projectHandles.delete(key);
    return result.sort((a, b) => Number(b.favorite) - Number(a.favorite));
  }
  projectPath(id: string): string | null {
    const project = this.projectHandles.get(id);
    if (!project || !this.dependencies.projects().includes(project.source)) return null;
    return canonical(project.source) === project.real ? project.real : null;
  }
  async read(_client: string, operation: 'conversation' | 'live', payload: unknown): Promise<OperationResult> {
    const p = object(payload);
    if (!p || typeof p.handle !== 'string') return { ok: false, reason: 'invalid' };
    const target = this.resolve(p.handle);
    if (!target) return { ok: false, reason: 'stale' };
    if (operation === 'live') return { ok: true, value: this.dependencies.live(target.pid) };
    if (!target.sessionId) return { ok: false, reason: 'unavailable' };
    return { ok: true, value: await this.dependencies.conversation(target.sessionId, p.cursor) };
  }
  async mutate(client: string, operation: RemoteOperation, payload: unknown): Promise<OperationResult> {
    const p = object(payload);
    if (!p) return { ok: false, reason: 'invalid' };
    if (operation === 'launch') {
      if (typeof p.project !== 'string' || (p.provider !== 'claude' && p.provider !== 'codex')
        || (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 64))) return { ok: false, reason: 'invalid' };
      const cwd = this.projectPath(p.project);
      if (!cwd) return { ok: false, reason: 'stale' };
      return { ok: true, value: await this.dependencies.launch(p.provider, cwd, p.name as string | undefined) };
    }
    if (typeof p.handle !== 'string') return { ok: false, reason: 'invalid' };
    const target = this.resolve(p.handle);
    if (!target) return { ok: false, reason: 'stale' };
    if (!target.tmux) return { ok: false, reason: 'unsupported' };
    if (operation === 'close') {
      if (!this.dependencies.close) return { ok: false, reason: 'unsupported' };
      const handle = p.handle;
      return { ok: true, value: await this.dependencies.close(target, client, () => !!this.resolve(handle)) };
    }
    if (!target.sessionId) return { ok: false, reason: 'unavailable' };
    let value: unknown;
    if (operation === 'send') {
      const images = p.images === undefined ? [] : p.images;
      const owned = this.uploads.get(client);
      if (!Array.isArray(images) || images.length > MOBILE_IMAGE_LIMIT || new Set(images).size !== images.length
        || images.some(id => typeof id !== 'string' || owned?.get(id) !== p.handle)
        || typeof p.text !== 'string' || (!p.text.trim() && !images.length) || Buffer.byteLength(p.text) > 32 * 1024) return { ok: false, reason: 'invalid' };
      // Once sending starts the agent may need these files, even if its acknowledgement is lost.
      for (const id of images) owned!.delete(id);
      value = images.length
        ? await this.dependencies.send(target.pid, p.text, target.sessionId, client, images)
        : await this.dependencies.send(target.pid, p.text, target.sessionId, client);
    } else if (operation === 'answerClaude' || operation === 'answerCodex') {
      if (typeof p.key !== 'string' || !p.key || p.key.length > 1024 || p.answer === undefined) return { ok: false, reason: 'invalid' };
      if (target.provider !== (operation === 'answerClaude' ? 'claude' : 'codex')) return { ok: false, reason: 'invalid' };
      value = await (operation === 'answerClaude' ? this.dependencies.answerClaude : this.dependencies.answerCodex)(target.pid, p.key, p.answer, client);
    } else return { ok: false, reason: 'unsupported' };
    return { ok: true, value };
  }
  async stageImage(client: string, handle: string, bytes: Uint8Array): Promise<OperationResult> {
    const target = this.resolve(handle);
    if (!target?.tmux || !target.sessionId) return { ok: false, reason: 'stale' };
    const stager = this.dependencies.images;
    if (!stager) return { ok: false, reason: 'unsupported' };
    let owned = this.uploads.get(client);
    if (!owned) { owned = new Map(); this.uploads.set(client, owned); }
    if (owned.size >= MOBILE_IMAGE_LIMIT) return { ok: false, reason: 'busy' };
    const reservation = randomUUID(); owned.set(reservation, handle);
    try {
      const result = await stager.stage(bytes);
      if (!result.ok) return { ok: false, reason: 'invalid', message: `Image upload failed: ${result.reason}. Use PNG, JPEG, GIF or WebP up to 10 MB.` };
      if (this.uploads.get(client) !== owned || !this.resolve(handle)) {
        await stager.discard(result.id); return { ok: false, reason: 'stale' };
      }
      owned.set(result.id, handle);
      return { ok: true, value: { id: result.id } };
    } finally { owned.delete(reservation); }
  }
  async discardImages(client: string): Promise<void> {
    const owned = this.uploads.get(client); this.uploads.delete(client);
    if (owned) await Promise.all([...owned.keys()].map(id => this.dependencies.images?.discard(id)));
  }
  release(client: string): void {
    void this.discardImages(client).catch(() => console.error('Remote image cleanup failed'));
  }
}
