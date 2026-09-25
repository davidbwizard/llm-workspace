import { useEffect, useRef, useState } from 'react';
import type { CodexPrompt } from '../../core/codexPrompt.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './PromptCard.css';

/** Codex's own app-server request, separate from Claude's tmux prompt path. */
export function CodexPromptCard({ pid, prompt, onOpenTerminal }: {
  pid: number; prompt: CodexPrompt; onOpenTerminal: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function submit(answer: string | Record<string, string>): Promise<void> {
    if (sending) return;
    setSending(true);
    setMessage(null);
    try {
      const api = window.fleet;
      if (!api) throw new Error('Fleet bridge unavailable');
      const result = await api.answerCodexPrompt(pid, prompt.key, answer);
      if (!mounted.current) return;
      if (result.status === 'sent') {
        setMessage('Sending…');
        setTimeout(() => {
          if (!mounted.current) return;
          setSending(false);
          setMessage('Codex has not cleared this request. Check Terminal.');
        }, 3000);
      } else {
        setSending(false);
        setMessage(result.reason === 'stale' ? 'This request has already changed.' : 'Could not send this answer.');
      }
    } catch (err) {
      console.error('Codex answer failed:', err);
      if (mounted.current) { setSending(false); setMessage('Could not reach Codex.'); }
    }
  }

  const title = prompt.kind === 'command' ? 'Allow this command?'
    : prompt.kind === 'file' ? 'Allow these file changes?'
      : prompt.kind === 'permissions' ? 'Grant these permissions?'
        : 'Answer Codex';
  const allAnswered = prompt.questions?.every(q => Boolean(answers[q.id]?.trim())) ?? false;
  return (
    <section className="prompt" aria-live="polite">
      <div className="p-head">
        <span className="eyebrow"><ProviderMark provider="codex" size={12} />Codex is waiting on you</span>
        <h3>{title}</h3>
      </div>
      <div className="p-body">
        {prompt.reason && <p>{prompt.reason}</p>}
        {prompt.details && <pre className="cmd">{prompt.details}</pre>}
        {prompt.command && <pre className="cmd">{prompt.command}</pre>}
        {prompt.cwd && <p className="hint">In {prompt.cwd}</p>}
        {prompt.kind === 'file' && !prompt.reason && !prompt.details &&
          <p className="hint">Codex requests approval to change files in this session.</p>}
        {prompt.questions?.map(q => (
          <fieldset className="q" key={q.id}>
            <legend>{q.question}</legend>
            {q.options?.map(option => (
              <label className="opt" key={option.label}>
                <input type="radio" name={`${prompt.key}-${q.id}`} value={option.label} aria-label={option.label}
                  checked={answers[q.id] === option.label} disabled={sending}
                  onChange={() => setAnswers(a => ({ ...a, [q.id]: option.label }))} />
                <b>{option.label}</b><small>{option.description}</small>
              </label>
            ))}
            {(!q.options || q.isOther) && (
              <label className="feedback">
                {q.options ? 'Other answer' : q.header || 'Your answer'}
                <input type={q.isSecret ? 'password' : 'text'} maxLength={2000}
                  value={answers[q.id] ?? ''} disabled={sending}
                  onChange={event => setAnswers(a => ({ ...a, [q.id]: event.target.value }))} />
              </label>
            )}
          </fieldset>
        ))}
        {message && <p className="hint" role="status">{message}</p>}
      </div>
      <div className="p-foot">
        {prompt.kind === 'questions' ? (
          <button type="button" className="btn primary" disabled={!allAnswered || sending}
            onClick={() => void submit(answers)}>Send answer</button>
        ) : prompt.kind === 'permissions' ? <>
          <button type="button" className="btn primary" disabled={sending}
            onClick={() => void submit('grantTurn')}>Grant for turn</button>
          <button type="button" className="btn" disabled={sending}
            onClick={() => void submit('grantSession')}>Grant for session</button>
          <button type="button" className="btn quiet" disabled={sending}
            onClick={() => void submit('deny')}>Deny</button>
        </> : <>
          {prompt.decisions.includes('accept') &&
            <button type="button" className="btn primary" disabled={sending}
              onClick={() => void submit('accept')}>Allow once</button>}
          {prompt.decisions.includes('acceptForSession') &&
            <button type="button" className="btn" disabled={sending}
              onClick={() => void submit('acceptForSession')}>Allow for session</button>}
          {prompt.decisions.includes('decline') &&
            <button type="button" className="btn quiet" disabled={sending}
              onClick={() => void submit('decline')}>Deny</button>}
          {prompt.decisions.includes('cancel') &&
            <button type="button" className="btn quiet" disabled={sending}
              onClick={() => void submit('cancel')}>Cancel turn</button>}
        </>}
        <span className="spacer" />
        <button type="button" className="btn quiet" onClick={onOpenTerminal}>Open Terminal</button>
      </div>
    </section>
  );
}
