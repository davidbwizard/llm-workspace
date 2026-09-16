import { useEffect, useState } from 'react';
import type { KeysResult, KeysRefusalReason } from '../../main/ipc.ts';
import './ReplyPopover.css';

/** Keyed by pid and nothing else, so a rail card and a game-view farmer can
 *  both open it (spec section 14). Never owned by the rail: this component
 *  takes no position or rail-shaped prop at all, only pid/prompt/onClose --
 *  the caller decides where to render it (anchoring is its job, not this
 *  component's). */
const REFUSAL_TEXT: Record<KeysRefusalReason, string> = {
  not_tmux: 'This session is not running inside tmux, so it cannot be typed into. Reattach it to reply.',
  session_gone: 'That session has ended.',
  invalid_pid: 'Could not reach that session.',
  empty: 'Nothing to send.',
  too_long: 'That reply is too long to send as keystrokes.',
  contains_newline: 'Send one line at a time -- a line break would submit early.',
  // Reply guard (measured 2026-09-15): a choice ignores typed text and Enter
  // picks whichever option is highlighted -- "blue" was recorded as "Red".
  // This is the backstop for a popover that believed choice was false (a
  // race between the card's own status and main's fresher check); the
  // ordinary case never reaches sendKeys at all -- see `choice` below.
  prompt_open: 'Claude is showing a choice right now. Answer it in the Terminal view -- a typed reply would just pick the highlighted option.',
};

export function ReplyPopover({ pid, prompt, choice, tmux, hostLabel, onOpenTerminal, onReveal, onClose }: {
  pid: number; prompt: string | null;
  /** True when this pid is showing a choice (a question picker or a
   *  permission prompt) as far as the caller can tell -- a waiting session,
   *  today (SessionRail's own doc comment). A typed reply can never answer
   *  one (see REFUSAL_TEXT.prompt_open above), so this popover offers no
   *  text box at all rather than one that would just misfire; the guard in
   *  sendKeysFor (src/main/ipc.ts) is the backstop, not the primary defence
   *  -- it only fires if this ever opens onto a choice believing it isn't
   *  one. */
  choice: boolean;
  /** Whether this session is tmux-backed -- Open Terminal only makes sense
   *  for one that is; otherwise the only way in is revealing the host app. */
  tmux: boolean;
  hostLabel: string | null;
  /** Selects this pid and switches the main pane to the Terminal view. */
  onOpenTerminal: () => void;
  /** Brings the host application forward. null when the caller has nothing
   *  to call (no onReveal wired, or no host known) -- the button is omitted
   *  entirely rather than rendered disabled. */
  onReveal: (() => void) | null;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function send(): Promise<void> {
    if (text.trim() === '') return;
    setMessage(null);
    const r: KeysResult | undefined = await window.fleet?.sendKeys(pid, text);
    if (r?.status === 'sent') { setText(''); onClose(); return; }
    setMessage(r ? REFUSAL_TEXT[r.reason] : 'Could not reach the app.');
  }

  return (
    <div className="replypop" role="dialog" aria-label={`Reply to session ${pid}`}>
      {prompt && <p className="replyprompt">{prompt}</p>}
      {choice ? (
        <>
          <p className="replyexplain">
            Claude is showing a choice. Answer it in the terminal -- a typed reply would just pick the
            highlighted option.
          </p>
          {tmux ? (
            <button type="button" className="replysend" onClick={() => { onOpenTerminal(); onClose(); }}>
              Open Terminal
            </button>
          ) : onReveal && (
            <button type="button" className="replysend" onClick={() => { onReveal(); onClose(); }}>
              Show in {hostLabel ?? 'its terminal'}
            </button>
          )}
        </>
      ) : (
        <>
          <input className="replyinput" type="text" value={text} aria-label="Reply"
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void send(); }} />
          <button type="button" className="replysend" onClick={() => void send()}>Send</button>
        </>
      )}
      {message && <p className="replymsg">{message}</p>}
    </div>
  );
}
