import { useEffect, useState } from 'react';
import type { Provider } from '../../core/types.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './WaitingCard.css';

const AGENT_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

/** The card shown above the composer while the open session's agent is
 *  waiting on a choice -- the `.prompt` block from the Conversation Pane
 *  Mockup, David's own artifact and, per his own ruling, exactly what he
 *  wants for this state. Values are copied from that artifact's CSS rather
 *  than inferred from a screenshot: an earlier screen in this project was
 *  built from one instead and got six corner radii wrong.
 *
 *  Only Claude reports a `waiting` activity today, but the name and logo
 *  come from the session's own provider rather than being hard-coded to
 *  Claude, the same as everywhere else in this pane.
 *
 *  This is the fallback shell for everything PromptCard.tsx (Task 5)
 *  doesn't cover: hooks off, a prompt kind with no hook (e.g. folder
 *  trust), or no open prompt main could match. ConversationView.tsx
 *  renders WaitingFallback (below) whenever the session is waiting but
 *  `live.prompt` is null, which shows this card once its reading frame is
 *  done, and PromptCard otherwise -- see that file's own render for the
 *  choice.
 *
 *  `hooksOn` (quick-answers design §9/§10) is a real fact read from main
 *  (window.fleet.hooksGet), never inferred from `live.prompt` being null
 *  -- a session that IS hooked up but simply has nothing open right now
 *  must not be told to go turn a switch on that is already on. */
export function WaitingCard({ provider, hooksOn, onOpenTerminal }: {
  provider: Provider;
  hooksOn: boolean;
  onOpenTerminal: () => void;
}) {
  const name = AGENT_NAME[provider];
  return (
    <section className="prompt" aria-live="polite">
      <div className="p-head">
        <span className="eyebrow">
          <ProviderMark provider={provider} size={12} />
          {`${name} is waiting on you`}
        </span>
        <h3>Answer in the Terminal</h3>
      </div>
      <div className="p-body">
        <p className="hint">{`${name} is showing a question or a permission prompt.`}</p>
        {provider === 'claude' && !hooksOn &&
          <p className="hint">Turn on Quick answers in Settings to answer here.</p>}
      </div>
      <div className="p-foot">
        <button type="button" className="btn primary" onClick={onOpenTerminal}>Open Terminal</button>
      </div>
    </section>
  );
}

/** How long a waiting session with no prompt yet shows the reading frame
 *  before falling back to WaitingCard (Task 6 flash fix). Main pushes the
 *  prompt within ~250 ms of the wait starting (the status-file push ingests
 *  the spool first, src/main/sessionLive.ts); 2 s leaves room for a slow
 *  pane read, and past it the prompt is not coming. */
export const READING_PROMPT_MS = 2000;

/** What ConversationView shows while the session is waiting and main has no
 *  prompt for it. With Quick answers on, the first READING_PROMPT_MS show
 *  the prompt card's frame and a reading line, with no buttons, so the
 *  fallback card does not flash before the real prompt card; after that,
 *  or at once with the switch off (or for Codex, which Quick answers does
 *  not cover), WaitingCard.
 *
 *  Mounted for exactly one waiting-without-prompt stretch --
 *  ConversationView renders it only then, keyed by pid -- so the 2 s count
 *  starts when that stretch does. `hooksOn` is null until main has
 *  answered (the read starts with the wait): unknown shows the neutral
 *  reading frame, a read that says off swaps in the fallback at once, and
 *  the fallback's "turn on" line shows unless the switch is confirmed on. */
export function WaitingFallback({ provider, hooksOn, onOpenTerminal }: {
  provider: Provider;
  hooksOn: boolean | null;
  onOpenTerminal: () => void;
}) {
  const [reading, setReading] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setReading(false), READING_PROMPT_MS);
    return () => clearTimeout(timer);
  }, []);
  if (reading && provider === 'claude' && hooksOn !== false) {
    return (
      <section className="prompt" aria-live="polite">
        <div className="p-head">
          <span className="eyebrow">
            <ProviderMark provider="claude" size={12} />
            Claude is waiting on you
          </span>
        </div>
        <div className="p-body">
          <p className="hint">Reading Claude's prompt…</p>
        </div>
      </section>
    );
  }
  return <WaitingCard provider={provider} hooksOn={hooksOn === true} onOpenTerminal={onOpenTerminal} />;
}
