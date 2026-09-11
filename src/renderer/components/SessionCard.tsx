import type { SessionState } from '../../fleet/state.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './SessionCard.css';

// A mapped type over the same closed union `state.host` draws from (see
// below), not an index signature -- adding a HostApp member without adding
// it here is now a compile error, the same protection ACTIVITY_WORD already
// had. Kept even though nothing renders HOST_LABEL.unknown today (see
// hostLabel below) -- Phase 5's process discovery is what starts producing
// real values here, and this table is its target, not something to shrink
// in the meantime.
type Host = NonNullable<SessionState['host']>;

const HOST_LABEL: Record<Host, string> = {
  iterm2:'iTerm2', terminal:'Terminal', vscode:'VS Code',
  'claude-app':'Claude', 'codex-app':'Codex', unknown:'unknown host',
};

const ACTIVITY_WORD: Record<SessionState['activity'], string> = {
  working:'working', waiting_permission:'waiting on you',
  waiting_input:'waiting on you', idle:'idle', error:'error',
};

/** Formats a running process's elapsed time for a human ("9d", not
 *  "777600s"). Coarsest unit that keeps at least one significant digit --
 *  a card is a glance, not a stopwatch. */
function formatProcessAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Formats resident memory for a human ("206 MB"). rssBytes is already
 *  normalized to bytes by src/discovery/parse.ts's parseRss. */
function formatProcessMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function SessionCard({ state, onOpen, showProcessMeta }: {
  state: SessionState; onOpen: (sessionId: string) => void;
  /** Judgeable process info (age, memory) is only useful -- and only
   *  requested -- on the "Waiting for you" tier: a session whose process
   *  is known alive but idling. Elsewhere (working, blocked, history) it's
   *  just noise, so FleetView opts a card in rather than this component
   *  deciding from `state.alive` alone. */
  showProcessMeta?: boolean;
}) {
  const blocked = state.activity === 'waiting_permission' || state.activity === 'waiting_input';
  // `null` (no process discovery ran at all -- true of every card today,
  // since buildFleetPayload calls fleetState with no `processes`, so
  // discovery never runs on the app's path) and `'unknown'` (classifyHost's
  // own "found a process, couldn't name its host app" case) both mean the
  // same thing to the user: we have nothing to say here. Saying "unknown
  // host" on every single card claims we looked and failed, when the truth
  // is closer to never having looked -- worse than saying nothing. An
  // out-of-union value (stale persisted state, a bug elsewhere) also falls
  // through to `undefined` here, the same as `null` -- there is no
  // genuinely different case: HOST_LABEL is a closed Record<Host, string>,
  // so a value not `!== 'unknown'` that ALSO doesn't match one of its keys
  // was never a real HostApp value to begin with. Real values (Phase 5's
  // job to start producing) still render their label as before.
  const hostLabel = state.host && state.host !== 'unknown' ? HOST_LABEL[state.host] : undefined;
  // Age and memory are what make an alive-but-idling process judgeable
  // ("is this the 9-day-old 206 MB one I should kill?") -- gated on
  // showProcessMeta (see the prop doc above), and on each value actually
  // being known: `ps` can fail per-field even for a genuinely alive match.
  const procMeta = showProcessMeta
    ? [
        state.processAgeSeconds != null ? formatProcessAge(state.processAgeSeconds) : null,
        state.processRssBytes != null ? formatProcessMemory(state.processRssBytes) : null,
      ].filter((part): part is string => part !== null).join(' · ') || null
    : null;
  // The dial caps at 10 pips by design -- it's a sparkline, not a counter.
  // The exact count sits right beside it (the "2/44" label below), so above
  // ten live agents the dial and the number are meant to disagree.
  const pips = Math.min(state.agents, 10);
  const activityWord = ACTIVITY_WORD[state.activity];
  const stateWord = `${activityWord}${state.stale ? ' (stale)' : ''}`;
  const providerLabel = state.provider === 'claude' ? 'Claude' : 'Codex';
  // The card's whole job is surfacing the last meaningful thing an agent
  // said -- the noise problem this app exists to fix. Unconditional: a
  // blocker replaces it (same precedence as the visible ".said" paragraph
  // below), but every other session -- working, idle, error, no blocker --
  // still needs this in the accessible name, not just on screen.
  const said = state.blocker ? state.blocker.text : (state.lastProse ?? 'No output yet');
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
  // the wording that could drift from it. The provider disambiguates two
  // sessions that share a project name across providers (SessionState
  // carries `match`/`candidates`/`sharesWorktreeWith` for exactly that
  // scenario); host and counts stay out -- noise in a label meant for
  // triage, not a full transcript of the card.
  const label = [
    `Open ${state.project} (${providerLabel})`,
    stateWord,
    said,
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

      {/* The badge above is absolutely positioned over this row's top-right
          corner; "hasbadge" reserves room for it so a longer host label
          (e.g. "VS Code") runs under its own margin-left:auto space rather
          than under the badge. See .crow.hasbadge in SessionCard.css. */}
      <div className={`crow${blocked ? ' hasbadge' : ''}`}>
        <span className={`prov ${state.provider}`}>
          <ProviderMark provider={state.provider} size={11} />
          {providerLabel}
        </span>
        {(hostLabel || procMeta) && (
          <span className="crow-meta">
            {hostLabel && <span className="host">{hostLabel}</span>}
            {procMeta && <span className="procmeta">{procMeta}</span>}
          </span>
        )}
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
        {said}
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
