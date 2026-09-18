import { Fragment, useEffect, useRef, useState } from 'react';
import type { Answer, PromptChoice, PromptQuestion, PromptView } from '../../core/prompt.ts';
// Type-only: src/renderer/** must never import a VALUE out of src/main/**
// (ConversationView.tsx's own MAX_REPLY_CHARS doc comment carries the full
// reasoning) -- this is erased at build, same as types.d.ts's own
// `AnswerResult` import.
import type { AnswerResult } from '../../main/answer.ts';
import { ProviderMark } from './ProviderMark.tsx';
import { MarkdownText } from './ConversationView.tsx';
import './PromptCard.css';

/** The interactive prompt card -- questions, command permission and plan
 *  approval (quick-answers design §9-10). Renders above the composer
 *  whenever the open session has a live prompt (`live.prompt`,
 *  ConversationView.tsx); the plain WaitingCard stays the fallback for
 *  everything else (hooks off, not our tmux session's kind, no match).
 *
 *  Quick answers is Claude-only (design §2: "Codex out"), so the eyebrow's
 *  wording and glyph are fixed to Claude rather than taking a `provider`
 *  prop -- there is no other agent this card is ever shown for.
 *
 *  Main re-derives and re-validates every answer this card sends
 *  (src/main/answer.ts's `session:answer` guards, spec §7.2) -- nothing
 *  here needs to duplicate that logic, only build the exact `Answer` shape
 *  guard 3 expects and show whatever main hands back. */

const MAX_TEXT_LEN = 2000; // mirrors src/main/answer.ts's own MAX_TEXT

const REASON_LINE: Record<'not_tmux' | 'screen_unread', string> = {
  not_tmux: "This session isn't running in the app's terminal, so it can't be answered here.",
  screen_unread: "Couldn't read Claude's choices from the screen.",
};

/** One line, non-empty once trimmed, and within the cap -- the same shape
 *  src/main/answer.ts's cleanText enforces main-side (this is a UX
 *  convenience only; main is the actual guard). */
function textOk(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TEXT_LEN && text.trim().length > 0;
}

/** A single line: strips any newline a paste could introduce. Real control
 *  characters besides newline are vanishingly unlikely from a text input
 *  and are refused main-side regardless (guard 3) -- this only handles the
 *  one thing send-keys itself cannot tolerate (spec §7.2: "A newline sent
 *  by send-keys would submit early"). */
function oneLine(text: string): string {
  return text.replace(/[\r\n]/g, '');
}

function titleFor(prompt: PromptView): string {
  if (prompt.kind === 'question') {
    const n = prompt.questions?.length ?? 0;
    return n === 1 ? 'Claude has a question' : `Claude has ${n} questions`;
  }
  if (prompt.kind === 'plan') return "Claude's plan is ready";
  if (prompt.command !== undefined) return 'Claude wants to run a command';
  if (prompt.filePath !== undefined) return 'Claude wants to edit a file';
  return `Claude wants to use ${prompt.toolName || 'a tool'}`;
}

/** One question's local answer, in exactly the shape `session:answer`
 *  expects for it (validateAnswer, src/main/answer.ts): `other` is present
 *  only for a single-select "Something else" pick, never alongside
 *  `options`, and never at all for a multi-select question (Task 3's
 *  option-B ruling -- the multi-select free-text key sequence was never
 *  measured, so main refuses it outright). */
type Picked = { options: number[]; other?: string };

function isAnswered(q: PromptQuestion, picked: Picked | undefined): boolean {
  if (!picked) return false;
  if (q.multiSelect) return picked.options.length > 0;
  return picked.other !== undefined ? textOk(picked.other) : picked.options.length === 1;
}

export function PromptCard({ pid, prompt, onOpenTerminal }: {
  pid: number;
  prompt: PromptView;
  onOpenTerminal: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, Picked>>({});
  const [sending, setSending] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [showTerminalLink, setShowTerminalLink] = useState(false);
  const [noTextOpen, setNoTextOpen] = useState(false);
  const [noText, setNoText] = useState('');
  const [planFeedbackOpen, setPlanFeedbackOpen] = useState(false);
  const [planFeedback, setPlanFeedback] = useState('');

  // Guards every setState below a `setTimeout`/an awaited call against
  // firing after this card has been unmounted -- e.g. the prompt closed
  // (answered, or the terminal took over) before the async work settled.
  // Same pattern as ConversationView.tsx's own CopyButton `alive` ref.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  async function send(answer: Answer): Promise<void> {
    if (sending) return;
    setSending(true);
    setResultMsg(null);
    setShowTerminalLink(false);
    try {
      const r: AnswerResult | undefined = await window.fleet?.answerPrompt(pid, prompt.id, answer);
      if (!aliveRef.current) return;
      if (!r) {
        setResultMsg('Could not reach the app.');
        setSending(false);
        return;
      }
      if (r.status === 'sent') {
        setResultMsg('Sending…');
        // Spec §7.4: the card should have closed (the status left waiting,
        // or the prompt id changed) within 3s of a successful send. Both of
        // those replace THIS component with a different one (a fresh
        // WaitingCard, or a fresh PromptCard keyed on the new id --
        // ConversationView.tsx keys this component by prompt id for
        // exactly this reason), which unmounts it and flips aliveRef.
        // Reaching this callback while still alive means neither happened.
        setTimeout(() => {
          if (!aliveRef.current) return;
          setResultMsg("Claude didn't take the answer -- open Terminal");
          setShowTerminalLink(true);
          setSending(false);
        }, 3000);
        return;
      }
      // Refused. `stale` means Claude moved on or it was answered in the
      // terminal already -- the next payload replaces this card with
      // whatever is now true, so it shows no error of its own (spec §10).
      setSending(false);
      if (r.reason === 'stale') return;
      if (r.reason === 'unconfirmed') {
        setResultMsg("Couldn't confirm -- answer in Terminal");
        setShowTerminalLink(true);
        return;
      }
      if (r.reason === 'unconfirmed_partial') {
        setResultMsg('Answers may be partly entered -- finish in Terminal');
        setShowTerminalLink(true);
        return;
      }
      // invalid/busy/not_tmux/invalid_pid/session_gone: none of these
      // should be reachable from this card's own UI (its buttons are built
      // from the prompt main itself sent, and `sending` already blocks a
      // second click), but a refusal is never left unsaid regardless.
      setResultMsg('Could not send the answer.');
    } catch (err) {
      console.error('answerPrompt failed:', err);
      if (aliveRef.current) {
        setResultMsg('Could not reach the app.');
        setSending(false);
      }
    }
  }

  // ---- questions -----------------------------------------------------

  function pickOption(qi: number, oi: number, multi: boolean): void {
    setAnswers(prev => {
      if (!multi) return { ...prev, [qi]: { options: [oi] } };
      const cur = new Set(prev[qi]?.options ?? []);
      if (cur.has(oi)) cur.delete(oi); else cur.add(oi);
      return { ...prev, [qi]: { options: [...cur].sort((a, b) => a - b) } };
    });
  }

  function pickOther(qi: number): void {
    setAnswers(prev => ({ ...prev, [qi]: { options: [], other: prev[qi]?.other ?? '' } }));
  }

  function setOtherText(qi: number, text: string): void {
    setAnswers(prev => ({ ...prev, [qi]: { options: [], other: oneLine(text) } }));
  }

  const questions = prompt.questions ?? [];
  const allAnswered = questions.length > 0 && questions.every((q, qi) => isAnswered(q, answers[qi]));

  function sendAnswers(): void {
    const picks = questions.map((q, qi) => {
      const picked = answers[qi];
      if (q.multiSelect || !picked || picked.other === undefined) {
        return { options: [...(picked?.options ?? [])] };
      }
      return { options: [], other: picked.other.trim() };
    });
    void send({ kind: 'questions', picks });
  }

  function questionFieldset(q: PromptQuestion, qi: number) {
    const picked = answers[qi];
    const type = q.multiSelect ? 'checkbox' : 'radio';
    const otherOpen = !q.multiSelect && picked?.other !== undefined;
    const disabled = !prompt.answerable || sending;
    return (
      <fieldset className="q" key={qi} aria-label={q.question}>
        <legend>
          {q.question}
          <span className="kind">{q.multiSelect ? 'Pick any' : 'Pick one'}</span>
        </legend>
        {q.options.map((opt, oi) => (
          <label className="opt" key={oi}>
            <input type={type} aria-label={opt.label}
              checked={picked?.options.includes(oi) ?? false}
              disabled={disabled}
              onChange={() => pickOption(qi, oi, q.multiSelect)} />
            <b>{opt.label}</b>
            <small>{opt.description}</small>
          </label>
        ))}
        {q.multiSelect ? (
          // Task 3's option-B ruling: the multi-select free-text key
          // sequence was never measured, so main refuses it outright --
          // no "Other" row is offered here at all.
          <p className="hint">To type your own answer, use Terminal.</p>
        ) : (
          <label className="opt">
            <input type="radio" aria-label="Something else"
              checked={otherOpen}
              disabled={disabled}
              onChange={() => pickOther(qi)} />
            <b>Something else</b>
            <small>Type your own answer.</small>
            {otherOpen && (
              <input type="text" className="other" aria-label="Your own answer"
                maxLength={MAX_TEXT_LEN}
                value={picked?.other ?? ''}
                disabled={sending}
                onChange={e => setOtherText(qi, e.target.value)} />
            )}
          </label>
        )}
      </fieldset>
    );
  }

  // ---- permission ------------------------------------------------------

  function choiceButton(choice: PromptChoice, onPlain: () => void) {
    return (
      <button type="button" className="btn" key={choice.key} disabled={sending} onClick={onPlain}>
        <kbd>{choice.key}</kbd> {choice.label}
      </button>
    );
  }

  function permissionBody() {
    const cmdText = prompt.command ?? prompt.filePath ?? prompt.toolName ?? '';
    return (
      <>
        <pre className="cmd">{cmdText}</pre>
        {prompt.description !== undefined && (
          <p className="hint">{`Claude's description: ${prompt.description}`}</p>
        )}
        {prompt.answerable && prompt.choices && (
          <div className="choices">
            {prompt.choices.map(choice => (
              <Fragment key={choice.key}>
                {/* Task 5 ruling: the takesText choice (permission's "No")
                    is a PLAIN button -- clicking it sends {kind:'choice'}
                    directly, exactly like main's own validateAnswer allows
                    for a permission takesText key (the measured Bash/Write
                    "3" rejects with no text). The text box is a separate,
                    quiet, opt-in action below it. */}
                {choiceButton(choice, () => void send({ kind: 'choice', key: choice.key }))}
                {choice.takesText && (
                  <>
                    <button type="button" className="btn quiet" disabled={sending}
                      onClick={() => setNoTextOpen(o => !o)}>
                      and tell Claude what to do instead
                    </button>
                    {noTextOpen && (
                      <div className="feedback">
                        <input type="text" aria-label="and tell Claude what to do instead"
                          maxLength={MAX_TEXT_LEN} disabled={sending}
                          value={noText}
                          onChange={e => setNoText(oneLine(e.target.value))} />
                        <div>
                          <button type="button" className="btn primary" disabled={sending || !textOk(noText)}
                            onClick={() => void send({ kind: 'choice_text', key: choice.key, text: noText.trim() })}>
                            Send to Claude
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </Fragment>
            ))}
          </div>
        )}
      </>
    );
  }

  // ---- plan --------------------------------------------------------

  function planBody() {
    const textChoice = prompt.choices?.find(c => c.takesText);
    return (
      <>
        <div className="plan" tabIndex={0} aria-label="Plan">
          <div className="turn-text md">
            <MarkdownText text={prompt.plan ?? ''} />
          </div>
        </div>
        {prompt.answerable && prompt.choices && (
          <div className="choices">
            {prompt.choices.map(choice => (
              // Plan option 3 (the takesText choice) always opens the
              // feedback box -- main's own validateAnswer refuses a plain
              // `choice` on a takesText key unless the prompt is a
              // permission (see the doc comment above), so plan can never
              // send one for it regardless.
              choiceButton(choice, choice.takesText
                ? () => setPlanFeedbackOpen(true)
                : () => void send({ kind: 'choice', key: choice.key }))
            ))}
          </div>
        )}
        {planFeedbackOpen && textChoice && (
          <div className="feedback">
            <label className="hint" htmlFor="prompt-plan-feedback">What should change?</label>
            <textarea id="prompt-plan-feedback" maxLength={MAX_TEXT_LEN} disabled={sending}
              value={planFeedback}
              onChange={e => setPlanFeedback(oneLine(e.target.value))} />
            <div>
              <button type="button" className="btn primary" disabled={sending || !textOk(planFeedback)}
                onClick={() => void send({ kind: 'choice_text', key: textChoice.key, text: planFeedback.trim() })}>
                Send to Claude
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  // ---- render ------------------------------------------------------

  const footer = !prompt.answerable
    ? <button type="button" className="btn primary" onClick={onOpenTerminal}>Open Terminal</button>
    : prompt.kind === 'question'
      ? (
        <>
          <button type="button" className="btn quiet" disabled={sending} onClick={() => void send({ kind: 'chat' })}>
            Chat about this instead
          </button>
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!allAnswered || sending} onClick={sendAnswers}>
            Send answers
          </button>
        </>
      )
      : null;

  return (
    <section className="prompt" aria-live="polite">
      <div className="p-head">
        <span className="eyebrow">
          <ProviderMark provider="claude" size={12} />
          Claude is waiting on you
        </span>
        <h3>{titleFor(prompt)}</h3>
      </div>
      <div className="p-body">
        {prompt.kind === 'question' && questions.map((q, qi) => questionFieldset(q, qi))}
        {prompt.kind === 'permission' && permissionBody()}
        {prompt.kind === 'plan' && planBody()}
        {!prompt.answerable && (
          <p className="hint">{REASON_LINE[prompt.reason ?? 'not_tmux']}</p>
        )}
        {resultMsg !== null && (
          <p className="hint" role="status">
            {resultMsg}
            {showTerminalLink && (
              <>
                {' '}
                <button type="button" className="btn quiet" onClick={onOpenTerminal}>Open Terminal</button>
              </>
            )}
          </p>
        )}
      </div>
      {footer && <div className="p-foot">{footer}</div>}
    </section>
  );
}
