import type { OpenSession } from '../../fleet/state.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './OpenSessionCard.css';

// One card per live process (David: "ALL OPEN SESSIONS should show. And
// the source. So I can close if they are actually dead.") -- the model
// correction that replaced grouping by transcript recency. A genuinely
// different thing from a transcript session -- the card IS a process, not
// a conversation -- so this is its own component rather than a second mode
// on SessionCard: OpenSession has no agents/sharesWorktreeWith/stale/
// confidence, and forcing it through SessionCard's prop contract would
// produce fields with no meaning here. What's genuinely shared with
// SessionCard is reused directly: ProviderMark, the design tokens
// (theme.css, loaded globally) and base card classes (.card/.crow/.prov/
// etc., defined in SessionCard.css and relied on here without a second
// import -- see the note at the top of OpenSessionCard.css), and the same
// interaction/accessibility standard: the accessible name carries the
// card's state, not just its project name.

// A mapped type over the closed HostApp union, not an index signature --
// adding a HostApp member without adding it here is a compile error. Small
// deliberate duplicate of SessionCard's own HOST_LABEL: the two components
// are independent files by design (see the file-level comment above), and
// this map is a handful of lines, not worth a shared module for.
type Host = NonNullable<OpenSession['host']>;

const HOST_LABEL: Record<Host, string> = {
  iterm2:'iTerm2', terminal:'Terminal', vscode:'VS Code',
  'claude-app':'Claude', 'codex-app':'Codex', unknown:'unknown host',
};

type Activity = NonNullable<OpenSession['activity']>;

const ACTIVITY_WORD: Record<Activity, string> = {
  working:'working', waiting_permission:'waiting on you',
  waiting_input:'waiting on you', idle:'idle', error:'error',
};

/** Formats a running process's elapsed time for a human ("9d", not
 *  "777600s"). Coarsest unit that keeps at least one significant digit --
 *  a card is a glance, not a stopwatch. Duplicate of SessionCard's own
 *  formatProcessAge -- see the file-level comment above. */
function formatProcessAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Formats resident memory for a human ("206 MB"). rssBytes is already
 *  normalized to bytes by src/discovery/parse.ts's parseRss. Duplicate of
 *  SessionCard's own formatProcessMemory -- see the file-level comment
 *  above. */
function formatProcessMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function OpenSessionCard({ state, onOpen }: {
  state: OpenSession; onOpen: (pid: number) => void;
}) {
  // Same "say nothing rather than guess" rule as SessionCard's hostLabel --
  // unknown and null both mean the same thing to the user.
  const hostLabel = state.host && state.host !== 'unknown' ? HOST_LABEL[state.host] : undefined;
  // Age and memory are NEVER gated on match quality here: the card IS the
  // process, so its own age/memory are always attributable, even when no
  // transcript session can be matched to it at all (see src/fleet/state.ts's
  // OpenSession doc comment on ageSeconds/rssBytes).
  const procMeta = [
    state.ageSeconds != null ? formatProcessAge(state.ageSeconds) : null,
    state.rssBytes != null ? formatProcessMemory(state.rssBytes) : null,
  ].filter((part): part is string => part !== null).join(' · ') || null;
  // provider is NOT gated on match quality either -- it comes straight
  // from the process (discovery already knows which pgrep found it), so
  // it is always known and never null (OpenSession.provider: Provider, no
  // union with null). lastProse/events/activity ARE match-gated
  // enrichment -- see openSessions' doc comment in src/fleet/state.ts.
  const providerLabel = state.provider === 'claude' ? 'Claude' : 'Codex';
  const blocked = state.activity === 'waiting_permission' || state.activity === 'waiting_input';
  const activityWord = state.activity ? ACTIVITY_WORD[state.activity] : null;

  // Same reasoning as SessionCard's label: role="button" replaces this
  // element's content with its accessible name, so every signal rendered
  // below has to be carried in the name too. pid is included -- it is
  // this card's actual identity (two open sessions can share a project
  // name), the same job sessionId/provider do in SessionCard's label.
  const label = [
    `Open ${state.project} (${providerLabel}), pid ${state.pid}`,
    activityWord,
    state.lastProse,
    hostLabel ? `Running in ${hostLabel}` : null,
  ].filter((part): part is string => Boolean(part)).join('. ');

  return (
    <article
      className={`card ${blocked ? 'attn' : state.activity === 'working' ? 'live' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={label}
      onClick={() => onOpen(state.pid)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(state.pid); } }}
    >
      {blocked && <span className="badge" aria-hidden="true">1</span>}

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
        <p className="proj display">{state.project}</p>
        <p className="path">{state.cwd ?? 'no working directory'}</p>
      </div>

      {/* No fallback text (unlike SessionCard's "No output yet"): a blank
          last-message is honest on an ambiguous or unmatched card, where
          there is no session to say anything came from. */}
      {state.lastProse && (
        <p className={`said ${blocked ? 'wait' : ''}`}>{state.lastProse}</p>
      )}

      <div className="metrics">
        {/* Always present -- pid is what makes a future close action safe
            (one card, one process, no guessing), so it stays visible even
            when nothing else on the card is known. */}
        <span className="pid">pid {state.pid}</span>
        {state.events != null && <span>{state.events.toLocaleString()}</span>}
        {activityWord && (
          <span className={`state ${state.activity}`}>
            <span className="dot" aria-hidden="true" />
            {activityWord}
          </span>
        )}
      </div>
    </article>
  );
}
