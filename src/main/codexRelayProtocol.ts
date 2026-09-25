/** Observe only the TUI's thread-switch RPCs. The relay forwards bytes
 * independently of this observer, so losing observation never changes the
 * native TUI protocol. A lost observation does, however, unbind Conversation. */

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const requestKey = (id: unknown): string | null =>
  typeof id === 'string' ? `s:${id}` : typeof id === 'number' && Number.isSafeInteger(id) ? `n:${id}` : null;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWITCH_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);

export class CodexThreadTracker {
  private pending = new Set<string>();

  constructor(private readonly changed: (threadId: string | null) => void) {}

  fromTui(value: unknown): void {
    const message = object(value);
    const key = requestKey(message?.id);
    if (!message || key === null || !SWITCH_METHODS.has(String(message.method))) return;
    // The native TUI also starts ephemeral threads for background structured
    // requests. They share this socket but never become the visible thread.
    if (object(message.params)?.ephemeral === true) return;
    // A later switch supersedes any request that has not answered yet.
    this.pending.clear();
    this.pending.add(key);
    this.changed(null);
  }

  fromServer(value: unknown): void {
    const message = object(value);
    const key = requestKey(message?.id);
    // Server-initiated approval/question requests use their own ID space.
    // An equal numeric ID is not a response to the TUI's switch request.
    if (!message || typeof message.method === 'string' || key === null || !this.pending.delete(key)) return;
    const id = object(object(message.result)?.thread)?.id;
    this.changed(typeof id === 'string' && THREAD_ID.test(id) ? id : null);
  }

  disconnected(): void {
    this.pending.clear();
    this.changed(null);
  }
}

/** A bounded WebSocket frame decoder for observation. It does not write to
 * either socket. `masked` is true for client (TUI) frames, false for App
 * Server frames; accepting the wrong direction would corrupt correlation. */
export class WebSocketRpcObserver {
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private invalid = false;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmented = false;
  private static readonly MAX_HEADER = 16 * 1024;
  private static readonly MAX_MESSAGE = 16 * 1024 * 1024;

  constructor(
    private readonly masked: boolean,
    private readonly onMessage: (message: unknown) => void,
    private readonly onError: () => void,
  ) {}

  private fail(): void {
    if (this.invalid) return;
    this.invalid = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onError();
  }

  feed(bytes: Buffer): void {
    if (this.invalid) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (!this.handshakeDone) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > WebSocketRpcObserver.MAX_HEADER) this.fail();
        return;
      }
      if (end > WebSocketRpcObserver.MAX_HEADER) { this.fail(); return; }
      const line = this.buffer.subarray(0, this.buffer.indexOf('\r\n')).toString('latin1');
      if (!(this.masked ? /^GET \S+ HTTP\/1\.1$/.test(line) : /^HTTP\/1\.1 101\b/.test(line))) {
        this.fail(); return;
      }
      this.buffer = this.buffer.subarray(end + 4);
      this.handshakeDone = true;
    }

    while (this.buffer.length >= 2 && !this.invalid) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      if ((first & 0x70) !== 0 || !!(second & 0x80) !== this.masked) { this.fail(); return; }
      const opcode = first & 15;
      const final = (first & 0x80) !== 0;
      let length = second & 127;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const long = this.buffer.readBigUInt64BE(2);
        if (long > BigInt(WebSocketRpcObserver.MAX_MESSAGE)) { this.fail(); return; }
        length = Number(long);
        offset = 10;
      }
      if (length > WebSocketRpcObserver.MAX_MESSAGE) { this.fail(); return; }
      const control = opcode >= 8;
      if (control && (!final || length > 125)) { this.fail(); return; }
      const maskOffset = offset;
      if (this.masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (this.masked) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ this.buffer[maskOffset + (i % 4)]!;
      }
      this.buffer = this.buffer.subarray(offset + length);
      if (control) continue;
      if (opcode === 1) {
        if (this.fragmented) { this.fail(); return; }
        this.fragmented = !final;
      } else if (opcode !== 0 || !this.fragmented) { this.fail(); return; }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > WebSocketRpcObserver.MAX_MESSAGE) { this.fail(); return; }
      if (!final) continue;
      const complete = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmented = false;
      try { this.onMessage(JSON.parse(complete.toString('utf8'))); }
      catch { this.fail(); return; }
    }
  }
}
