import { useEffect, useRef, useState } from 'react';
import { validCodexFormContent, type CodexFormValue } from '../../core/codexForm.ts';
import type { CodexPrompt, CodexPromptAnswer } from '../../core/codexPrompt.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './PromptCard.css';

/** Codex's own app-server request, separate from Claude's tmux prompt path. */
export function CodexPromptCard({ pid, prompt, onOpenTerminal, answerPrompt = window.fleet?.answerCodexPrompt }: {
  answerPrompt?: NonNullable<Window['fleet']>['answerCodexPrompt'];
  pid: number; prompt: CodexPrompt; onOpenTerminal: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fieldInputs, setFieldInputs] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const currentKey = useRef(prompt.key);
  currentKey.current = prompt.key;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    setAnswers({}); setFieldInputs({}); setSending(false); setMessage(null);
  }, [prompt.key]);

  async function submit(answer: CodexPromptAnswer): Promise<void> {
    if (sending) return;
    const key = prompt.key;
    setSending(true);
    setMessage(null);
    try {
      if (!answerPrompt) throw new Error('Fleet bridge unavailable');
      const result = await answerPrompt(pid, prompt.key, answer);
      if (!mounted.current || currentKey.current !== key) return;
      if (result.status === 'sent') {
        setMessage('Sending…');
        timer.current = setTimeout(() => {
          if (!mounted.current || currentKey.current !== key) return;
          setMessage('Codex has not cleared this request. Check Terminal.');
        }, 3000);
      } else {
        setSending(false);
        setMessage(result.reason === 'stale' ? 'This request has already changed.' : 'Could not send this answer.');
      }
    } catch (err) {
      console.error('Codex answer failed:', err);
      if (mounted.current && currentKey.current === key) { setSending(false); setMessage('Could not reach Codex.'); }
    }
  }

  const title = prompt.kind === 'command' ? 'Allow this command?'
    : prompt.kind === 'file' ? 'Allow these file changes?'
      : prompt.kind === 'permissions' ? 'Grant these permissions?'
        : prompt.kind === 'fallback' ? 'Continue in Codex'
          : prompt.kind === 'elicitation' ? 'Codex requests your approval' : 'Answer Codex';
  const questionAnswer = (id: string): string => Object.hasOwn(answers, id) ? answers[id]! : '';
  const allAnswered = prompt.questions?.every(q => Boolean(questionAnswer(q.id).trim())) ?? false;
  const fields = prompt.fields ?? [];
  const content: Record<string, CodexFormValue> = Object.create(null);
  for (const field of fields) {
    const input = Object.hasOwn(fieldInputs, field.id) ? fieldInputs[field.id] : undefined;
    if (input === undefined) { if (field.default !== undefined) content[field.id] = field.default; continue; }
    if (field.type === 'boolean') { if (input !== '') content[field.id] = input === 'true'; }
    else if (field.type === 'number' || field.type === 'integer') { if (input.trim() !== '') content[field.id] = Number(input); }
    else content[field.id] = input;
  }
  const formValid = validCodexFormContent(fields, content);
  const decisionLabels = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Deny', cancel: 'Cancel turn' };
  const actions = prompt.actions ?? prompt.decisions.map(id => ({ id, label: decisionLabels[id] }));
  return (
    <section className="prompt" aria-live="polite">
      <div className="p-head">
        <span className="eyebrow"><ProviderMark provider="codex" size={12} />{prompt.isBlocking === false ? 'Codex has a question' : 'Codex is waiting on you'}</span>
        <h3>{title}</h3>
      </div>
      <div className="p-body">
        {prompt.fallback && <p>{prompt.fallback}</p>}
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
                  checked={questionAnswer(q.id) === option.label} disabled={sending}
                  onChange={() => setAnswers(a => ({ ...a, [q.id]: option.label }))} />
                <b>{option.label}</b><small>{option.description}</small>
              </label>
            ))}
            {(!q.options || q.isOther) && (
              <label className="feedback">
                {q.options ? 'Other answer' : q.header || 'Your answer'}
                <input type={q.isSecret ? 'password' : 'text'} maxLength={2000}
                  value={questionAnswer(q.id)} disabled={sending}
                  onChange={event => setAnswers(a => ({ ...a, [q.id]: event.target.value }))} />
              </label>
            )}
          </fieldset>
        ))}
        {prompt.kind === 'elicitation' && fields.map(field => {
          const value = Object.hasOwn(fieldInputs, field.id) ? fieldInputs[field.id]!
            : field.default !== undefined ? String(field.default) : '';
          const change = (next: string) => setFieldInputs(a => ({ ...a, [field.id]: next }));
          return <label className="feedback" key={field.id}>
            <span>{field.label}</span>
            {field.description && <small>{field.description}</small>}
            {field.options || field.type === 'boolean' ?
              <select aria-label={field.label} value={value} disabled={sending} required={field.required}
                onChange={e => change(e.target.value)}>
                <option value="">Choose…</option>
                {field.type === 'boolean' ? <><option value="true">Yes</option><option value="false">No</option></>
                  : field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select> :
              <input aria-label={field.label} value={value} disabled={sending} required={field.required}
                type={field.secret ? 'password' : field.type === 'string' ? 'text' : 'number'}
                minLength={field.minLength} maxLength={field.maxLength ?? 2000}
                min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : 'any'}
                onChange={e => change(e.target.value)} />}
          </label>;
        })}
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
        </> : prompt.kind === 'fallback' ? null : <>
          {actions.map(action => <button key={action.id} type="button"
            className={`btn ${action.id === 'accept' || action.id.startsWith('offered:') ? 'primary' : 'quiet'}`}
            disabled={sending || (prompt.kind === 'elicitation' && action.id === 'accept' && !formValid)}
            onClick={() => void submit(prompt.kind === 'elicitation'
              ? { action: action.id as 'accept' | 'acceptForSession' | 'decline' | 'cancel',
                ...(action.id === 'accept' && fields.length ? { content } : {}) }
              : action.id)}>{action.label}</button>)}
        </>}
        <span className="spacer" />
        <button type="button" className="btn quiet" onClick={onOpenTerminal}>Open Terminal</button>
      </div>
    </section>
  );
}
