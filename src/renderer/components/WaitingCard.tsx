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
 *  This is the plain "go answer it in the Terminal" shell -- the mockup's
 *  richer per-scenario cards (questions, permission, plan, folder trust)
 *  render the actual prompt content and its own choices; the design spec
 *  (2026-09-17-live-conversation-feedback-design.md §6.2) is explicit that
 *  Part 4 is what replaces this card's body with that. Until then every
 *  waiting session gets the same generic card and the same one remedy. */
export function WaitingCard({ provider, onOpenTerminal }: { provider: Provider; onOpenTerminal: () => void }) {
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
      </div>
      <div className="p-foot">
        <button type="button" className="btn primary" onClick={onOpenTerminal}>Open Terminal</button>
      </div>
    </section>
  );
}
