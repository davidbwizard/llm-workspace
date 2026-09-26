import { createHash, randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexPrompt, CodexQuestion, CodexSnapshot } from '../core/codexPrompt.ts';

/** One read-only subscription to the already-running Codex app-server. Only
 * an explicit answer from the conversation is sent back. The socket never
 * comes from the renderer, and no thread settings are changed on resume. */
type RecordValue = Record<string, unknown>;
type RequestId = string | number;
type Request = { id: RequestId; method: string; params: RecordValue };
export type CodexAnswerResult = { status: 'sent' } | { status: 'refused'; reason: 'invalid' | 'stale' | 'unavailable' };

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_TEXT = 2000;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
// Keep line breaks and tabs in command previews: flattening a multi-line
// shell command would change what the person thinks they are approving.
const CONTROL_DISPLAY = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/g;
const display = (value: unknown): string | null => typeof value === 'string'
  ? value.replace(CONTROL_DISPLAY, ' ').replace(BIDI, '').slice(0, 12000) : null;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : null;
const requestKey = (id: RequestId): string => `${typeof id}:${id}`;

function asRequest(value: unknown): Request | null {
  const v = record(value);
  const p = record(v?.params);
  if (!v || !p || (typeof v.id !== 'string' && !(typeof v.id === 'number' && Number.isSafeInteger(v.id)))
    || typeof v.method !== 'string') return null;
  return { id: v.id, method: v.method, params: p };
}

export function viewCodexRequest(value: unknown, threadId: string): CodexPrompt | null {
  const req = asRequest(value);
  if (!req || req.params.threadId !== threadId || typeof req.params.turnId !== 'string'
    || typeof req.params.itemId !== 'string') return null;
  const p = req.params;
  let kind: CodexPrompt['kind'];
  switch (req.method) {
    case 'item/commandExecution/requestApproval': kind = 'command'; break;
    case 'item/fileChange/requestApproval': kind = 'file'; break;
    case 'item/permissions/requestApproval': kind = 'permissions'; break;
    case 'item/tool/requestUserInput': kind = 'questions'; break;
    default: return null;
  }
  let questions: CodexQuestion[] | null = null;
  if (kind === 'questions') {
    if (!Array.isArray(p.questions) || p.questions.length === 0 || p.questions.length > 3) return null;
    questions = [];
    const ids = new Set<string>();
    for (const raw of p.questions) {
      const q = record(raw);
      if (!q || typeof q.id !== 'string' || !q.id || ids.has(q.id)
        || typeof q.question !== 'string') return null;
      ids.add(q.id);
      if (q.options !== null && q.options !== undefined && !Array.isArray(q.options)) return null;
      const options = q.options === null || q.options === undefined ? null : Array.isArray(q.options)
        ? q.options.map(rawOption => {
          const o = record(rawOption);
          return o && typeof o.label === 'string' && typeof o.description === 'string'
            && display(o.label) === o.label
            ? { label: display(o.label) ?? '', description: display(o.description) ?? '' } : null;
        }) : null;
      if (Array.isArray(options) && options.some(o => o === null)) return null;
      questions.push({ id: q.id, header: display(q.header) ?? '', question: display(q.question) ?? '',
        isSecret: q.isSecret === true, isOther: q.isOther === true,
        options: options as CodexQuestion['options'] });
    }
  }
  const standard = ['accept', 'acceptForSession', 'decline', 'cancel'] as const;
  const available = p.availableDecisions;
  const offered = Array.isArray(available)
    ? standard.filter(d => available.includes(d)) : [...standard];
  const network = record(p.networkApprovalContext);
  const details = kind === 'permissions' ? display(JSON.stringify(p.permissions ?? {}))
    : network ? `${display(network.protocol) ?? 'Network'}: ${display(network.host) ?? ''}`
      : kind === 'file' ? display(p.grantRoot) : null;
  return {
    key: requestKey(req.id), kind, threadId, turnId: p.turnId as string, itemId: p.itemId as string,
    reason: display(p.reason), command: display(p.command), cwd: display(p.cwd), details,
    questions, decisions: kind === 'command' || kind === 'file' ? offered : [],
  };
}

/** Derive the entire reply from the server request kept in main. Renderer
 * data can select a decision or supply question text; it cannot supply a
 * permission profile, an approval amendment, or a different request id. */
export function responseForCodexPrompt(value: unknown, answer: unknown): RecordValue | null {
  const req = asRequest(value);
  if (!req) return null;
  const view = viewCodexRequest(req, req.params.threadId as string);
  if (!view) return null;
  if (view.kind === 'command' || view.kind === 'file') {
    return typeof answer === 'string' && view.decisions.includes(answer as typeof view.decisions[number])
      ? { decision: answer } : null;
  }
  if (view.kind === 'permissions') {
    if (answer === 'deny') return { permissions: {}, scope: 'turn' };
    if (answer !== 'grantTurn' && answer !== 'grantSession') return null;
    const permissions = record(req.params.permissions);
    return permissions ? { permissions, scope: answer === 'grantSession' ? 'session' : 'turn' } : null;
  }
  const given = record(answer);
  if (!given || !view.questions || Object.keys(given).length !== view.questions.length) return null;
  const answers: Record<string, { answers: string[] }> = Object.create(null);
  for (const q of view.questions) {
    if (!Object.hasOwn(given, q.id)) return null;
    const text = given[q.id];
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || CONTROL.test(text)) return null;
    if (q.options && !q.options.some(o => o.label === text) && !q.isOther) return null;
    answers[q.id] = { answers: [text.trim()] };
  }
  return { answers };
}

/** Minimal RFC 6455 client for the app-server's local Unix socket. No new
 * package, remote host, browser WebSocket privilege, or arbitrary RPC bridge. */
class LocalWebSocket {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private opened = false;
  private closed = false;
  private fragment: Buffer[] = [];
  private key = randomBytes(16).toString('base64');

  constructor(path: string, private readonly onOpen: () => void,
    private readonly onMessage: (value: unknown) => void,
    private readonly onClose: (error?: Error) => void) {
    this.socket = createConnection(path);
    this.socket.on('connect', () => this.socket.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    this.socket.on('data', bytes => this.receive(bytes));
    this.socket.on('error', err => this.fail(err));
    this.socket.on('close', () => this.fail());
  }

  private fail(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose(error);
  }
  close(): void { this.fail(); }

  private receive(bytes: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (!this.opened) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end > 16384 || (end < 0 && this.buffer.length > 16384)) {
        this.fail(new Error('Codex WebSocket header too large')); return;
      }
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString('latin1');
      const expected = createHash('sha1').update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (!/^HTTP\/1\.1 101\b/.test(header) || !header.toLowerCase().includes('upgrade: websocket')
        || !header.toLowerCase().includes('connection: upgrade')
        || !header.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) {
        this.fail(new Error('Codex WebSocket handshake failed')); return;
      }
      this.buffer = this.buffer.subarray(end + 4);
      this.opened = true;
      this.onOpen();
    }
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      if (second & 0x80) { this.fail(new Error('Masked server frame')); return; }
      const opcode = first & 15;
      const fin = (first & 0x80) !== 0;
      let len = second & 127;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) { this.fail(new Error('Codex frame too large')); return; }
        len = Number(big); offset = 10;
      }
      if (len > MAX_FRAME) { this.fail(new Error('Codex frame too large')); return; }
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.subarray(offset, offset + len);
      this.buffer = this.buffer.subarray(offset + len);
      if (opcode === 8) { this.fail(); return; }
      if (opcode === 9) { this.frame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode !== 0 && opcode !== 1) { this.fail(new Error('Unsupported Codex frame')); return; }
      this.fragment.push(payload);
      if (!fin) continue;
      const complete = Buffer.concat(this.fragment);
      this.fragment = [];
      if (complete.length > MAX_FRAME) { this.fail(new Error('Codex message too large')); return; }
      try { this.onMessage(JSON.parse(complete.toString('utf8'))); }
      catch (err) { this.fail(err instanceof Error ? err : new Error('Invalid Codex JSON')); return; }
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    if (!this.opened || this.closed) throw new Error('Codex socket unavailable');
    const prefix = payload.length < 126 ? 2 : payload.length <= 65535 ? 4 : 10;
    const frame = Buffer.allocUnsafe(prefix + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (payload.length < 126 ? payload.length : payload.length <= 65535 ? 126 : 127);
    if (prefix === 4) frame.writeUInt16BE(payload.length, 2);
    if (prefix === 10) frame.writeBigUInt64BE(BigInt(payload.length), 2);
    const mask = randomBytes(4);
    mask.copy(frame, prefix);
    for (let i = 0; i < payload.length; i++) frame[prefix + 4 + i] = payload[i]! ^ mask[i % 4]!;
    this.socket.write(frame);
  }
  send(value: unknown): void { this.frame(1, Buffer.from(JSON.stringify(value), 'utf8')); }
}

export class CodexAppServer {
  private threadId: string | null = null;
  private state: CodexSnapshot['state'] = 'unavailable';
  private requests = new Map<string, { request: Request; sent: boolean }>();
  private socket: LocalWebSocket | null = null;
  private retry: NodeJS.Timeout | null = null;
  private generation = 0;
  private changed: () => void = () => {};

  constructor(private readonly socketPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control', 'app-server-control.sock')) {}

  watch(threadId: string, changed: () => void): void {
    if (this.threadId === threadId) { this.changed = changed; return; }
    this.stop();
    this.threadId = threadId;
    this.changed = changed;
    this.connect();
  }
  stop(): void {
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
    this.threadId = null;
    this.state = 'unavailable';
    this.requests.clear();
    this.changed = () => {};
  }
  snapshot(threadId: string): CodexSnapshot | null {
    if (threadId !== this.threadId) return null;
    return { state: this.state, prompts: [...this.requests.values()]
      .map(({ request }) => viewCodexRequest(request, threadId)).filter((p): p is CodexPrompt => p !== null) };
  }
  answer(threadId: unknown, key: unknown, answer: unknown): CodexAnswerResult {
    if (typeof threadId !== 'string' || typeof key !== 'string' || threadId !== this.threadId)
      return { status: 'refused', reason: 'stale' };
    if (!this.socket || this.state !== 'ready') return { status: 'refused', reason: 'unavailable' };
    const entry = this.requests.get(key);
    if (!entry || entry.sent || entry.request.params.threadId !== threadId) return { status: 'refused', reason: 'stale' };
    const result = responseForCodexPrompt(entry.request, answer);
    if (!result) return { status: 'refused', reason: 'invalid' };
    try {
      this.socket.send({ id: entry.request.id, result });
      entry.sent = true;
      return { status: 'sent' };
    } catch (err) {
      console.error('Codex answer failed:', err);
      return { status: 'refused', reason: 'unavailable' };
    }
  }

  private connect(): void {
    const threadId = this.threadId;
    if (!threadId) return;
    const generation = ++this.generation;
    this.state = 'connecting';
    this.changed();
    this.socket = new LocalWebSocket(this.socketPath,
      () => this.socket?.send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'fleet', title: 'Fleet', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      } }),
      value => { if (this.generation === generation) this.message(value, threadId); },
      error => {
        if (this.generation !== generation) return;
        if (error && this.state === 'ready') console.error('Codex app-server connection closed:', error);
        this.socket = null;
        this.state = 'unavailable';
        this.requests.clear();
        this.changed();
        this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 5000);
      });
  }

  private message(value: unknown, threadId: string): void {
    const m = record(value);
    if (!m) return;
    // Server requests may use the same numeric IDs as our setup calls.
    // Only a JSON-RPC response (which has no method) can complete setup.
    const isResponse = !Object.hasOwn(m, 'method');
    if (m.id === 1 && isResponse) {
      if (m.error) { this.socket?.close(); return; }
      this.socket?.send({ method: 'initialized', params: {} });
      this.socket?.send({ id: 2, method: 'thread/resume', params: { threadId, excludeTurns: true } });
      return;
    }
    if (m.id === 2 && isResponse) {
      const result = record(m.result);
      const thread = record(result?.thread);
      if (m.error || thread?.id !== threadId) { this.socket?.close(); return; }
      this.state = 'ready';
      this.changed();
      return;
    }
    if (m.method === 'serverRequest/resolved') {
      const params = record(m.params);
      if (params?.threadId === threadId
        && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
        this.requests.delete(requestKey(params.requestId));
        this.changed();
      }
      return;
    }
    if (m.method === 'turn/completed') {
      const params = record(m.params);
      const turn = record(params?.turn);
      if (params?.threadId === threadId && typeof turn?.id === 'string') {
        for (const [key, entry] of this.requests) if (entry.request.params.turnId === turn.id) this.requests.delete(key);
        this.changed();
      }
      return;
    }
    const request = asRequest(m);
    if (request && viewCodexRequest(request, threadId)) {
      this.requests.set(requestKey(request.id), { request, sent: false });
      this.changed();
    }
  }
}

export const codexAppServer = new CodexAppServer();
