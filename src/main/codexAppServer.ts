import { createHash, randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import type { CodexPrompt, CodexQuestion, CodexSnapshot } from '../core/codexPrompt.ts';
// The one definition of where the App Server daemon listens, shared with
// the relay that Fleet's own Codex launches go through.
import { codexDaemonSocket as defaultCodexSocketPath } from './codexRelayControl.ts';
import { SESSION_NAME_HELP, SESSION_NAME_MAX, SESSION_NAME_SAFE } from '../core/sessionName.ts';

/** One read-only subscription to the already-running Codex app-server. Only
 * an explicit answer from the conversation is sent back. The socket never
 * comes from the renderer, and no thread settings are changed on resume.
 *
 * setCodexThreadName at the foot of this file is the one exception to
 * "read-only", and is not part of the subscription: a separate, short-lived
 * connection that sets the name on ONE thread the person just named, then
 * closes. It lives here so the WebSocket client below has exactly one
 * implementation in this app. */
type RecordValue = Record<string, unknown>;
type RequestId = string | number;
type Request = { id: RequestId; method: string; params: RecordValue };
export type CodexAnswerResult = { status: 'sent' } | { status: 'refused'; reason: 'invalid' | 'stale' | 'unavailable' };

const MAX_FRAME = 4 * 1024 * 1024;
/** How long to wait between reconnection attempts once the app-server is
 *  unreachable. Matches the original cadence; named so the log line can
 *  quote it rather than repeat the number. */
const RETRY_MS = 5_000;
/** How long a connection may sit accepted-but-not-upgraded before it is
 *  given up on. Generous against a busy daemon, finite against one that
 *  will never answer. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
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
  private handshake: NodeJS.Timeout | null = null;
  private generation = 0;
  private changed: () => void = () => {};
  /** Whether the current outage has already been reported. An absent daemon
   *  is the DEFAULT state on any machine that has not launched Codex
   *  through Fleet, so a line per retry would be several an hour, forever;
   *  silence, which is what this replaced, meant the feature could be dead
   *  for the life of the app with nothing to find. One line when it breaks
   *  and one when it comes back is the whole signal. */
  private outageReported = false;
  private readonly retryMs: number;
  private readonly handshakeMs: number;

  constructor(private readonly socketPath = defaultCodexSocketPath(),
  timings: { retryMs?: number; handshakeMs?: number } = {}) {
    this.retryMs = timings.retryMs ?? RETRY_MS;
    this.handshakeMs = timings.handshakeMs ?? HANDSHAKE_TIMEOUT_MS;
  }

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
    if (this.handshake) clearTimeout(this.handshake);
    this.handshake = null;
    this.outageReported = false;
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

  /** Moves to `next` and pushes ONLY on a real change. Every failed retry
   *  used to re-announce 'unavailable', and each push rebuilds the whole
   *  session-live payload and sends it over IPC -- twice per 5s cycle, for
   *  as long as the daemon is absent, which is indefinitely. */
  private setState(next: CodexSnapshot['state']): void {
    if (this.state === next) return;
    this.state = next;
    this.changed();
  }

  private connect(): void {
    const threadId = this.threadId;
    if (!threadId) return;
    const generation = ++this.generation;
    // 'connecting' only while there is still hope of a first connection.
    // Once an outage is under way the honest state is 'unavailable', and
    // saying so continuously -- rather than flipping unavailable ->
    // connecting -> unavailable every cycle -- is what stops a retry from
    // rebuilding and pushing the whole session-live payload twice per
    // cycle for as long as the daemon is absent.
    if (!this.outageReported) this.setState('connecting');
    // A socket that accepts the connection and then never completes the
    // upgrade leaves this in 'connecting' with nothing scheduled -- no
    // retry, no log, no end. Measured: stuck for the whole observation
    // window. This is where a changed `initialize` contract would land.
    if (this.handshake) clearTimeout(this.handshake);
    this.handshake = setTimeout(() => {
      if (this.generation !== generation || this.state === 'ready') return;
      this.report('Codex app-server did not complete its handshake');
      this.socket?.close();
    }, this.handshakeMs);
    this.socket = new LocalWebSocket(this.socketPath,
      () => this.socket?.send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'fleet', title: 'Fleet', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      } }),
      value => { if (this.generation === generation) this.message(value, threadId); },
      error => {
        if (this.generation !== generation) return;
        // Reported whatever the state was. The old guard only spoke when
        // the connection had already reached 'ready', so the two cases that
        // matter most said nothing: a daemon that was never there (state
        // 'connecting'), and a daemon that died -- which closes with NO
        // error argument at all, so it failed the guard even when ready.
        this.report(error instanceof Error ? `Codex app-server unavailable: ${error.message}`
          : 'Codex app-server connection closed');
        this.socket = null;
        this.requests.clear();
        this.setState('unavailable');
        this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.retryMs);
      });
  }

  /** One line per outage, not one per retry. */
  private report(message: string): void {
    if (this.outageReported) return;
    this.outageReported = true;
    console.error(`${message} -- retrying every ${this.retryMs / 1000}s. `
      + 'Codex prompts will not reach the conversation until it is back '
      + `(socket: ${this.socketPath}).`);
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
      if (this.handshake) { clearTimeout(this.handshake); this.handshake = null; }
      // Closing the loop the outage line opened: without this, the only
      // record is a failure that appears never to have been resolved.
      if (this.outageReported) console.error('Codex app-server reconnected.');
      this.outageReported = false;
      this.setState('ready');
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

export type CodexNameResult = { ok: true } | { ok: false; reason: string };

/** The thread ids the App Server issues, same shape codexRelayControl.ts
 *  accepts from tmux. Checked again here because this is the last place
 *  before the id goes back out to the daemon. */
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long the whole connect/initialize/set exchange may take. A daemon
 *  that accepts the socket and then says nothing must not leave the caller
 *  on a promise that never settles -- a launch is waiting on this one. */
const SET_NAME_TIMEOUT_MS = 10_000;
/** Enough of the daemon's own wording to be useful in a sentence the person
 *  reads, and not enough to fill the launch bar. */
const REASON_MAX = 200;

const errorReason = (error: unknown): string => {
  const message = display(record(error)?.message);
  return message && message.trim() !== '' ? message.slice(0, REASON_MAX) : 'the Codex app-server refused it';
};

/** Sets the name Codex keeps for one thread (its `threads.name` column in
 *  ~/.codex/state_5.sqlite -- the name the session card already displays).
 *
 *  `thread/name/set`, params `{ threadId, name }`, read from the generated
 *  protocol schema (`codex app-server generate-json-schema`, checked
 *  2026-09-28 against codex-cli 0.157.0) rather than guessed; its response
 *  carries no fields, so success is "answered without an error".
 *
 *  A separate, short-lived connection, not the subscription above: it
 *  belongs to a launch, not to whichever thread happens to be on screen,
 *  and it must not disturb the watch the Conversation pane depends on.
 *
 *  The name is validated HERE as well as by the caller. This is the last
 *  code that runs before it leaves this app for another tool's own state,
 *  so it holds to exactly the rule a name on a command line does
 *  (SESSION_NAME_SAFE) -- no looser, and nothing is opened at all when it
 *  fails. */
export function setCodexThreadName(threadId: string, name: string, opts: {
  socketPath?: string; timeoutMs?: number;
} = {}): Promise<CodexNameResult> {
  if (!CODEX_THREAD_ID.test(threadId)) {
    return Promise.resolve({ ok: false, reason: 'that thread id has an unexpected shape' });
  }
  if (name.length > SESSION_NAME_MAX || !SESSION_NAME_SAFE.test(name)) {
    return Promise.resolve({ ok: false, reason: SESSION_NAME_HELP });
  }
  const socketPath = opts.socketPath ?? defaultCodexSocketPath();
  const timeoutMs = opts.timeoutMs ?? SET_NAME_TIMEOUT_MS;
  return new Promise<CodexNameResult>(resolve => {
    let settled = false;
    let socket: LocalWebSocket | null = null;
    // Every exit runs through here: the socket is closed exactly once, the
    // timer is cleared, and a second outcome (the close that follows our
    // own close(), say) is dropped rather than resolving twice.
    const finish = (result: CodexNameResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      ok: false, reason: `the Codex app-server did not answer within ${timeoutMs / 1000}s`,
    }), timeoutMs);
    const send = (value: unknown): boolean => {
      try { socket?.send(value); return true; }
      catch (err) {
        finish({ ok: false, reason: err instanceof Error ? err.message : 'the Codex app-server socket failed' });
        return false;
      }
    };
    // A constructor that throws would otherwise REJECT this promise rather
    // than resolving it, which is a different contract from every other
    // exit here -- one result type, never a throw.
    try {
      socket = new LocalWebSocket(socketPath,
        () => { send({ id: 1, method: 'initialize', params: {
          clientInfo: { name: 'fleet', title: 'Fleet', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        } }); },
        value => {
          const m = record(value);
          // Only a JSON-RPC response can advance this exchange. Server
          // requests and notifications share the id space and are ignored
          // -- the same trap the subscription's own `isResponse` guard
          // exists for.
          if (!m || Object.hasOwn(m, 'method')) return;
          if (m.id === 1) {
            if (m.error) { finish({ ok: false, reason: errorReason(m.error) }); return; }
            if (!send({ method: 'initialized', params: {} })) return;
            send({ id: 2, method: 'thread/name/set', params: { threadId, name } });
            return;
          }
          if (m.id === 2) finish(m.error ? { ok: false, reason: errorReason(m.error) } : { ok: true });
        },
        error => finish({
          ok: false,
          reason: error instanceof Error ? error.message : 'the Codex app-server closed the connection',
        }));
    } catch (err) {
      finish({ ok: false, reason: err instanceof Error ? err.message : 'the Codex app-server could not be reached' });
    }
  });
}
