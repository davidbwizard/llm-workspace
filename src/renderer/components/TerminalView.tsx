import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { AttachRefusalReason, AttachResult } from '../../main/ipc.ts';
import type { TerminalDataPayload } from '../../main/stream.ts';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

// One message per AttachRefusalReason, so this is a compile error -- not a
// silent `undefined` -- if main ever adds a reason and this map is not
// updated to match (same convention as OpenSessionCard's KILL_REFUSAL_TEXT
// and ReplyPopover's REFUSAL_TEXT). invalid_pid/invalid_size are computed
// from the terminal's own cols/rows and this component's own pid prop, so
// reaching either would mean a bug elsewhere handed this view a bad pid --
// not something to word for a person specifically, same as those two files.
const ATTACH_REFUSAL_TEXT: Record<AttachRefusalReason, string> = {
  not_tmux: 'This session is not running inside tmux, so its output cannot be streamed live.',
  session_gone: 'That session has ended.',
  invalid_pid: 'Could not attach to this session.',
  invalid_size: 'Could not attach to this session.',
};

/** Bounds the pre-backlog queue (below) against the stream's own measured
 *  ceiling of ~30 MB/s (src/main/stream.ts) -- unbounded, a contended main
 *  process (attach's own IPC round trip, or the capture-pane it waits on)
 *  turns an ordinary delay into unbounded renderer memory. 64 coalesced
 *  frames is generous headroom over how long attach should ever actually
 *  take (capture-pane alone measures under 10ms against a real index --
 *  spec S3) while still bounding the worst case to tens of MB, not an
 *  open-ended stream. Exported so the overflow path is testable against
 *  the real number, not a duplicated guess of it. */
export const MAX_QUEUED_TERMINAL_PAYLOADS = 64;

/** The raw half of the toggle. Bytes are written IMPERATIVELY -- a setState
 *  per chunk would re-render the card tree at stream rate, which is the
 *  mistake FleetView's own un-debounced subscription would invite copying.
 *  The stream is measured at up to ~30 MB/s (src/main/stream.ts). */
export function TerminalView({ pid }: { pid: number }) {
  const host = useRef<HTMLDivElement | null>(null);
  // Only two things ever go through React state: whether attach refused
  // (so a refusal renders why instead of an empty black terminal -- an
  // empty terminal reads as broken, not as "not applicable") and whether a
  // seq gap was ever seen (a visible admission that output may be missing,
  // rather than silently rendering corrupted-looking output). Neither
  // fires at stream rate -- both are rare, one-time-per-attachment events.
  const [refusalText, setRefusalText] = useState<string | null>(null);
  const [gapDetected, setGapDetected] = useState(false);

  useEffect(() => {
    setRefusalText(null);
    setGapDetected(false);
    const el = host.current;
    if (!el) return;

    const api = window.fleet;
    if (!api) { setRefusalText('Could not reach the app.'); return; }

    const term = new Terminal({ scrollback: 5000, fontFamily: 'var(--f-mono)', convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // WebGL rendering is an optimization for the ~30 MB/s stream, not a
    // requirement -- xterm's canvas/DOM renderer is a perfectly correct
    // fallback, so a WebGL init failure (no GPU context available) must
    // not take the whole view down with it.
    try { term.loadAddon(new WebglAddon()); } catch { /* canvas/DOM fallback is fine */ }
    term.open(el);
    fit.fit();

    let alive = true;

    // The live-data subscription is registered before attach's own promise
    // resolves (below), and the two race: main can start pushing bytes the
    // instant it sets up the pipe attachment, which may be before this
    // invoke's reply lands back here. Subscribing only after attach
    // resolves would risk losing exactly those bytes (ipcRenderer drops a
    // send with no listener yet, rather than queuing it) -- so the
    // subscription is live from the start, and anything it sees before
    // backlog has been written is queued here instead of written straight
    // through. That is what keeps scrollback and live output from ever
    // interleaving out of order (spec'd behaviour, not a style choice).
    let backlogWritten = false;
    let queued: TerminalDataPayload[] = [];
    let lastSeq: number | null = null;

    function applyPayload(p: TerminalDataPayload): void {
      // seq increments by exactly one per message (src/main/stream.ts's
      // makeCoalescer). A skip means a message was lost in transit -- say
      // so visibly rather than rendering the resulting gap as if nothing
      // happened. lastSeq starts null (no baseline yet for this
      // attachment), so the very first message never counts as a gap.
      if (lastSeq !== null && p.seq !== lastSeq + 1) setGapDetected(true);
      lastSeq = p.seq;
      term.write(p.data);
    }

    // tmux has no attached client, so it never learns our size on its own:
    // without this the window keeps its creation size and output wraps wrong.
    const onResize = term.onResize(({ cols, rows }) => { void api.resize(pid, cols, rows); });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);

    const unsub = api.onTerminalData(payload => {
      const p = payload as TerminalDataPayload;
      // The push channel is broadcast to every attached view -- without
      // this filter, one session's output would land in another's terminal.
      if (p.pid !== pid) return;
      if (!backlogWritten) {
        // Chosen over the alternative (force backlog's own write early and
        // drain): that would mean writing whatever we have BEFORE the
        // snapshot attach actually asked for has arrived, breaking the
        // ordering guarantee this whole queue exists for. Dropping instead
        // -- newest first, i.e. simply refusing to grow further -- keeps
        // that guarantee intact and produces one clean, visible gap at a
        // known point, rather than silently ballooning memory or silently
        // rendering as if nothing were missing.
        if (queued.length >= MAX_QUEUED_TERMINAL_PAYLOADS) { setGapDetected(true); return; }
        queued.push(p);
        return;
      }
      applyPayload(p);
    });

    void api.attach(pid, term.cols, term.rows).then(r => {
      const res = r as AttachResult;
      if (!alive) return;
      if (res.status === 'refused') {
        setRefusalText(ATTACH_REFUSAL_TEXT[res.reason]);
        return;
      }
      term.write(res.backlog);
      backlogWritten = true;
      for (const p of queued) applyPayload(p);
      queued = [];
    });

    const onData = term.onData(text => { void api.sendRaw(pid, text); });

    return () => {
      alive = false;
      unsub();
      onData.dispose();
      onResize.dispose();
      ro.disconnect();
      void api.detach(pid);
      term.dispose();
    };
  }, [pid]);

  if (refusalText) {
    return <p className="term-refused" role="status">{refusalText}</p>;
  }

  return (
    <div className="term-wrap">
      {gapDetected && (
        <p className="term-gap" role="status">Some output may be missing -- a message was dropped.</p>
      )}
      <div className="term" ref={host} />
    </div>
  );
}
