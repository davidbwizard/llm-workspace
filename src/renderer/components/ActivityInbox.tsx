import type { InboxItem, InboxKind, InboxSession } from '../state/activityInbox.ts';
import './ActivityInbox.css';
export type InboxDestination = 'fleet' | InboxKind;
export function InboxNav({ active, needsCount, updatesCount, onChange, fleetLabel = 'Fleet' }: { active: InboxDestination; needsCount: number; updatesCount: number; onChange: (destination: InboxDestination) => void; fleetLabel?: string }) {
  return <nav className="inbox-nav" aria-label="Fleet views">
    {([['fleet', fleetLabel, null], ['needs-you', 'Needs you', needsCount], ['updates', 'Updates', updatesCount]] as const).map(([key, label, count]) =>
      <button type="button" key={key} aria-pressed={active === key} aria-label={count === null ? label : `${label} (${count})`} onClick={() => onChange(key)}>{label}{count !== null && <span className={`inbox-count${count > 0 ? ' has-items' : ''}`} aria-hidden="true">{count}</span>}</button>)}
  </nav>;
}
export function ActivityInbox({ kind, items, onOpen, onNotifications }: { kind: InboxKind; items: InboxItem[]; onOpen: (session: InboxSession) => void; onNotifications?: () => void }) {
  const needs = kind === 'needs-you';
  return <section className="activity-inbox" aria-label={needs ? 'Needs you' : 'Updates'}>
    <header className="inbox-heading"><div><h1>{needs ? 'Needs you' : 'Updates'}</h1><p>{needs ? 'Sessions waiting for your answer or approval.' : 'New agent replies since you last viewed them.'}</p></div>{onNotifications && <button type="button" onClick={onNotifications}>Notifications</button>}</header>
    {items.length === 0 ? <p className="inbox-empty">{needs ? 'Nothing needs your attention.' : 'You’re caught up.'}</p> : <ul className="inbox-list">
      {items.map(({ session, key, waitingSince, snippet }) => <li key={key} className={`inbox-card ${needs ? 'waiting' : 'update'}`}>
        <div className="inbox-card-meta"><span>{session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude' : session.provider}</span><span>{session.project || session.cwd?.split('/').filter(Boolean).pop() || 'Unknown project'}</span></div>
        <h2>{session.name || session.project || session.cwd?.split('/').filter(Boolean).pop() || 'Session'}</h2>
        {needs && <p className="inbox-status">{session.activity === 'waiting_permission' ? 'Approval needed' : 'Answer needed'}{waitingSince !== null && <> · First seen {new Date(waitingSince).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}</p>}
        {snippet && <p className="inbox-snippet">{snippet}</p>}
        <button type="button" aria-label={`${needs ? 'Review' : 'Open latest'} ${session.name || session.project || 'session'}`} onClick={() => onOpen(session)}>{needs ? 'Review' : 'Open latest'}<span className="sr-only"> {session.name || session.project || 'session'}</span></button>
      </li>)}
    </ul>}
  </section>;
}
