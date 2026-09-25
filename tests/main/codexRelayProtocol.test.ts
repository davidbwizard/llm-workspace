import { describe, expect, it, vi } from 'vitest';
import { CodexThreadTracker, WebSocketRpcObserver } from '../../src/main/codexRelayProtocol.ts';

const OLD = '01a0da03-b7a1-7542-a9b9-e325e92c221f';
const NEXT = '01a0da04-34c5-7ba0-9266-524ffaa5d2fc';

function frame(value: unknown, masked: boolean, opcode = 1, final = true): Buffer {
  const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = payload.length < 126
    ? Buffer.from([opcode | (final ? 0x80 : 0), payload.length | (masked ? 0x80 : 0)])
    : Buffer.from([opcode | (final ? 0x80 : 0), 126 | (masked ? 0x80 : 0), payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, ...(masked ? [mask] : []),
    masked ? Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!)) : payload]);
}

describe('CodexThreadTracker', () => {
  it('binds only a successful TUI switch response and fails closed while switching', () => {
    const changed = vi.fn();
    const tracker = new CodexThreadTracker(changed);
    tracker.fromTui({ id: 1, method: 'thread/start', params: {} });
    expect(changed).toHaveBeenLastCalledWith(null);
    tracker.fromServer({ id: 1, result: { thread: { id: OLD } } });
    expect(changed).toHaveBeenLastCalledWith(OLD);
    const priorCalls = changed.mock.calls.length;
    tracker.fromTui({ id: 'temporary-structured', method: 'thread/start', params: { ephemeral: true } });
    tracker.fromServer({ id: 'temporary-structured', result: { thread: { id: NEXT } } });
    expect(changed).toHaveBeenCalledTimes(priorCalls);
    expect(changed).toHaveBeenLastCalledWith(OLD);
    tracker.fromTui({ id: 'resume', method: 'thread/resume', params: { threadId: NEXT } });
    expect(changed).toHaveBeenLastCalledWith(null);
    tracker.fromServer({ id: 'resume', error: { code: -32600, message: 'missing' } });
    expect(changed).toHaveBeenLastCalledWith(null);
    tracker.fromTui({ id: 3, method: 'thread/resume', params: { threadId: NEXT } });
    tracker.fromServer({ id: 3, result: { thread: { id: NEXT } } });
    expect(changed).toHaveBeenLastCalledWith(NEXT);
    tracker.disconnected();
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it('ignores notifications, unrelated responses, malformed ids, and stale responses', () => {
    const changed = vi.fn();
    const tracker = new CodexThreadTracker(changed);
    tracker.fromTui({ id: 1, method: 'thread/start', params: {} });
    tracker.fromTui({ id: 2, method: 'thread/fork', params: { threadId: OLD } });
    tracker.fromServer({ id: 2, method: 'item/tool/requestUserInput', params: {} });
    tracker.fromServer({ id: 1, result: { thread: { id: OLD } } });
    tracker.fromServer({ method: 'thread/started', params: { thread: { id: OLD } } });
    tracker.fromServer({ id: 9, result: { thread: { id: OLD } } });
    tracker.fromServer({ id: 2, result: { thread: { id: 'bad\nvalue' } } });
    expect(changed.mock.calls.every(([id]) => id === null)).toBe(true);
  });
});

describe('WebSocketRpcObserver', () => {
  it('reads masked and fragmented client JSON across arbitrary chunks', () => {
    const messages: unknown[] = [];
    const errors = vi.fn();
    const observer = new WebSocketRpcObserver(true, value => messages.push(value), errors);
    const request = JSON.stringify({ id: 7, method: 'thread/resume', params: { threadId: OLD } });
    const bytes = Buffer.concat([
      Buffer.from('GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n'),
      frame(request.slice(0, 14), true, 1, false),
      frame(request.slice(14), true, 0, true),
    ]);
    for (let i = 0; i < bytes.length; i += 3) observer.feed(bytes.subarray(i, i + 3));
    expect(messages).toEqual([{ id: 7, method: 'thread/resume', params: { threadId: OLD } }]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('rejects a masked server frame and stops observing', () => {
    const messages = vi.fn();
    const errors = vi.fn();
    const observer = new WebSocketRpcObserver(false, messages, errors);
    observer.feed(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'),
      frame({ id: 1 }, true)]));
    observer.feed(frame({ id: 2 }, false));
    expect(errors).toHaveBeenCalledTimes(1);
    expect(messages).not.toHaveBeenCalled();
  });
});
