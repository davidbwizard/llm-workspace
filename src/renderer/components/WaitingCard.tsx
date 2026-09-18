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
 *  renders this whenever the session is waiting but `live.prompt` is
 *  null, and PromptCard otherwise -- see that file's own render for the
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
        {!hooksOn && <p className="hint">Turn on Quick answers in Settings to answer here.</p>}
      </div>
      <div className="p-foot">
        <button type="button" className="btn primary" onClick={onOpenTerminal}>Open Terminal</button>
      </div>
    </section>
  );
}
