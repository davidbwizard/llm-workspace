/** tmux pipe-pane measured at ~30 MB/s on this machine (18.6 MB in 0.59s).
 *  That is far faster than anyone reads and fast enough to drown the renderer:
 *  one IPC message per line would be millions of messages. Bound it here, by
 *  design rather than by luck. Nothing about pushFleet (src/main/ipc.ts:622)
 *  is reusable -- that sends a whole snapshot and throttles at its call sites,
 *  which does not generalise to an append-only stream. */

export const COALESCE_MS = 16;
export const MAX_FLUSH_CHARS = 262_144;

export type TerminalDataPayload = { version: 1; pid: number; seq: number; data: string };

export type Coalescer = { push(chunk: string): void; flushNow(): void };

export function makeCoalescer(
  pid: number,
  emit: (payload: TerminalDataPayload) => void,
  schedule: (fn: () => void) => void = fn => { setTimeout(fn, COALESCE_MS); },
): Coalescer {
  let buffer = '';
  let seq = 0;
  let armed = false;

  function flushNow(): void {
    armed = false;
    if (buffer.length === 0) return;
    const data = buffer.slice(0, MAX_FLUSH_CHARS);
    buffer = buffer.slice(MAX_FLUSH_CHARS);
    emit({ version: 1, pid, seq: seq++, data });
    // A burst larger than one flush keeps its remainder and re-arms, rather
    // than dropping it or sending an unbounded message.
    if (buffer.length > 0) arm();
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    schedule(flushNow);
  }

  return {
    push(chunk: string): void { buffer += chunk; arm(); },
    flushNow,
  };
}
