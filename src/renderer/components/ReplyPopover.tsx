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
};

export function ReplyPopover({ pid, prompt, onClose }: {
  pid: number; prompt: string | null; onClose: () => void;
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
      <input className="replyinput" type="text" value={text} aria-label="Reply"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void send(); }} />
      <button type="button" className="replysend" onClick={() => void send()}>Send</button>
      {message && <p className="replymsg">{message}</p>}
    </div>
  );
}
