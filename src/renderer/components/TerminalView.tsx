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

    // xterm measures its cell width by drawing to a canvas 2D context, which
    // -- unlike CSS -- never resolves a custom property: passing the literal
    // string 'var(--f-mono)' as fontFamily measures against a fallback font
    // (usually a generic monospace), giving every cell the wrong width. That
    // mismatch is what produced the huge letter-spacing, wrapped/overlapping
    // lines and blank-glyph rectangles this fix addresses. Resolving the
    // real value at runtime, rather than duplicating theme.css's font list
    // here, keeps this in sync with the token instead of two sources of
    // truth drifting apart. The fallback stack matters on its own -- an
    // early mount, before the stylesheet has applied, can read back ''.
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--f-mono').trim();
    const fontFamily = mono || 'ui-monospace, SFMono-Regular, Menlo, monospace';
    const term = new Terminal({ scrollback: 5000, fontFamily, fontSize: 13, convertEol: false });
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

    // That first fit measures whatever width this element has on the mount
    // tick, which is before the rail beside it has taken its share of the row
    // -- so it reads too wide. The ResizeObserver below does correct it, but
    // only on a later frame, which means the first paint (and the size attach
    // is told about) is wrong. Re-fit once layout has settled, so the terminal
    // is right on the frame the user actually sees.
    //
    // Attaching happens HERE, after that corrected fit, rather than on the
    // mount tick -- see attachOnce below for why the order is load-bearing.
    // attachOnce is a hoisted function declaration, so it is callable from
    // here despite being written further down next to the code it owns.
    const firstFrame = requestAnimationFrame(() => {
      if (!alive) return;
      fit.fit();
      attachOnce();
    });

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

    // A real tmux client -- attach spawns `tmux attach` inside a pty --
    // learns our size the moment the pty is created at it, and pty.resize
    // (main) makes tmux follow every resize after that on its own.
    const onResize = term.onResize(({ cols, rows }) => { void api.resize(pid, cols, rows); });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);

    // Nothing to queue any more: tmux redraws its own full screen the
    // moment this pty attaches, already at the right size, so there is no
    // backlog to wait for and no ordering race between it and live bytes.
    const unsub = api.onTerminalData(payload => {
      const p = payload as TerminalDataPayload;
      // The push channel is broadcast to every attached view -- without
      // this filter, one session's output would land in another's terminal.
      if (p.pid !== pid) return;
      applyPayload(p);
    });
    let recentExits = 0;
    let lastExitAt = 0;
    const unsubExit = api.onTerminalExit(({ pid: exitedPid }) => {
      if (exitedPid !== pid) return;
      // The replacement coalescer starts its own sequence at zero. tmux
      // redraws the screen on attach, so the old stream has no gap to carry.
      lastSeq = null;
      setGapDetected(false);
      const now = Date.now();
      if (now - lastExitAt > 30_000) recentExits = 0;
      lastExitAt = now;
      if (++recentExits > 3) {
        setRefusalText('Terminal connection lost. Switch to Conversation and back to retry.');
        return;
      }
      attachOnce();
    });

    /** Attaching is what spawns the pty at this size, so it MUST NOT run
     *  until the fit is trustworthy. Called from the animation frame above,
     *  never on the mount tick: the mount-tick fit measures this element
     *  before the rail beside it has taken its share of the row, so
     *  attaching there would tell main a width that is too large, and
     *  tmux's own redraw would then be laid out at that wrong width. */
    function attachOnce(): void {
      // Re-read rather than closing over the narrowed `api`: this is a hoisted
      // declaration, so TypeScript will not carry the outer null-check into it.
      const bridge = window.fleet;
      if (!bridge) return;
      void bridge.attach(pid, term.cols, term.rows).then(r => {
        const res = r as AttachResult;
        if (!alive) return;
        if (res.status === 'refused') setRefusalText(ATTACH_REFUSAL_TEXT[res.reason]);
      }).catch(err => {
        if (!alive) return;
        console.error('Terminal attach failed:', err);
        setRefusalText('Could not reach the app.');
      });
    }

    const onData = term.onData(text => { void api.sendRaw(pid, text); });

    return () => {
      alive = false;
      unsub();
      unsubExit();
      onData.dispose();
      onResize.dispose();
      cancelAnimationFrame(firstFrame);
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
