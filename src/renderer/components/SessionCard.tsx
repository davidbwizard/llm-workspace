import type { SessionState } from '../../fleet/state.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './SessionCard.css';

const HOST_LABEL: Record<string, string> = {
  iterm2:'iTerm2', terminal:'Terminal', vscode:'VS Code',
  'claude-app':'Claude', 'codex-app':'Codex', unknown:'unknown host',
};

const ACTIVITY_WORD: Record<SessionState['activity'], string> = {
  working:'working', waiting_permission:'waiting on you',
  waiting_input:'waiting on you', idle:'idle', error:'error',
};

export function SessionCard({ state, onOpen }:
  { state: SessionState; onOpen: (sessionId: string) => void }) {
  const blocked = state.activity === 'waiting_permission' || state.activity === 'waiting_input';
  // The dial caps at 10 pips by design -- it's a sparkline, not a counter.
  // The exact count sits right beside it (the "2/44" label below), so above
  // ten live agents the dial and the number are meant to disagree.
  const pips = Math.min(state.agents, 10);
  const activityWord = ACTIVITY_WORD[state.activity];
  const stateWord = `${activityWord}${state.stale ? ' (stale)' : ''}`;
  const sharedText = state.sharesWorktreeWith.length === 0 ? null
    : state.sharesWorktreeWith.length === 1
      ? 'Another session shares this directory'
      : `${state.sharesWorktreeWith.length} other sessions share this directory`;

  // role="button" makes this element a leaf to assistive tech: everything
  // rendered inside it (project, blocker, stale marker, shared-directory
  // warning -- the same signals visual design doc section 7 requires never
  // depend on colour alone) is replaced by the accessible name, not
  // announced alongside it. So the name has to carry that state itself,
  // built from the same values rendered below rather than a second copy of
  // the wording that could drift from it.
  const label = [
    `Open ${state.project}`,
    stateWord,
    state.blocker?.text,
    sharedText,
  ].filter((part): part is string => Boolean(part)).join('. ');

  return (
    <article
      className={`card ${blocked ? 'attn' : state.activity === 'working' ? 'live' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={label}
      onClick={() => onOpen(state.sessionId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(state.sessionId); } }}
    >
      {/* A bare "1" carries no context of its own -- the accessible name
          above already says what this session is blocked on. */}
      {blocked && <span className="badge" aria-hidden="true">1</span>}

      <div className="crow">
        <span className={`prov ${state.provider}`}>
          <ProviderMark provider={state.provider} size={11} />
          {state.provider === 'claude' ? 'Claude' : 'Codex'}
        </span>
        <span className="host">{HOST_LABEL[state.host ?? 'unknown'] ?? 'unknown host'}</span>
      </div>

      <div>
        {/* "display" opts into Fraunces's SOFT/WONK push (theme.css's
            h1, h2, h3, .display rule) -- the project name is the most
            prominent type on the card, but a <p> rather than a heading. */}
        <p className="proj display">{state.project}</p>
        <p className="path">{state.cwd ?? 'no working directory'}</p>
      </div>

      {/* Provider text. React escapes it; it was also stripped of control
          characters at the IPC boundary. Never dangerouslySetInnerHTML. */}
      <p className={`said ${blocked ? 'wait' : ''}`}>
        {state.blocker ? state.blocker.text : (state.lastProse ?? 'No output yet')}
      </p>

      {sharedText && <p className="shared">{sharedText}</p>}

      <div className="metrics">
        <svg className="dial" width={5 + pips * 10} height={9} aria-hidden="true">
          {Array.from({ length: pips }, (_, i) => (
            <circle key={i} cx={4.5 + i * 10} cy={4.5} r={3.4}
              fill={i < state.liveAgents ? 'var(--accent)' : 'var(--faint)'}
              opacity={i < state.liveAgents ? 1 : 0.4} />
          ))}
        </svg>
        <span>{state.liveAgents}/{state.agents}</span>
        <span>{state.events.toLocaleString()}</span>
        <span className={`state ${state.activity}`}>
          <span className="dot" aria-hidden="true" />
          {stateWord}
        </span>
      </div>
    </article>
  );
}
