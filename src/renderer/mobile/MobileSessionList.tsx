import { useId, useState } from 'react';
import { StatusIcon } from '../components/StatusIcon.tsx';
import type { Activity } from '../../fleet/state.ts';
import { groupByFolder } from '../../fleet/order.ts';
import type { MobileSession } from './MobileApp.tsx';

export function MobileSessionList({ sessions, selected, onSelect, ready = true }: {
  sessions: MobileSession[];
  selected?: MobileSession;
  ready?: boolean;
  onSelect(session: MobileSession): void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const id = useId();
  const groups = groupByFolder(sessions);
  const folderName = (cwd: string) => cwd.split('/').filter(Boolean).pop() || '/';
  const names = new Map<string, number>();
  for (const group of groups) {
    const cwd = group.kind === 'stack' ? group.cwd : group.session.cwd;
    if (cwd) names.set(folderName(cwd), (names.get(folderName(cwd)) ?? 0) + 1);
  }
  const labels: Record<Activity, string> = { working: 'Working', waiting_input: 'Waiting on you', waiting_permission: 'Waiting on you', idle: 'Idle', error: 'Error' };
  const activityFor = (row: MobileSession): Activity | null => ready && row.activity && Object.hasOwn(labels, row.activity) ? row.activity as Activity : null;
  const sessionButton = (row: MobileSession) => <button className="mobile-session-row" data-activity={activityFor(row) ?? 'unknown'} key={row.pid} aria-current={row === selected} onClick={() => onSelect(row)}>
    <strong>{row.name || (row.cwd ? folderName(row.cwd) : row.provider)}</strong>
    <span className="mobile-session-meta"><span>{row.provider === 'codex' ? 'Codex' : 'Claude'}</span><span className="mobile-activity" data-activity={activityFor(row) ?? 'unknown'}>{activityFor(row) && <StatusIcon activity={activityFor(row)!} size={18} />}{activityFor(row) ? labels[activityFor(row)!] : ready ? 'Status unknown' : 'Status unavailable'}</span></span>
    {!row.controllable && <small>View only</small>}
  </button>;
  return <>{groups.map(group => {
    if (group.kind === 'session') return sessionButton(group.session);
    const open = !collapsed.has(group.key);
    const name = folderName(group.cwd);
    const waiting = ready ? group.members.filter(row => row.activity === 'waiting_input' || row.activity === 'waiting_permission').length : 0;
    const working = ready ? group.members.filter(row => row.activity === 'working').length : 0;
    const membersId = `${id}-${encodeURIComponent(group.key)}`;
    return <section key={group.key} className="mobile-folder" aria-label={group.cwd} data-selected={!!selected && group.members.includes(selected)}>
      <h3><button className="mobile-folder-toggle" aria-label={`${name}, ${group.members.length} sessions`} aria-expanded={open} aria-controls={membersId} title={group.cwd} onClick={() => setCollapsed(previous => {
        const next = new Set(previous); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next;
      })}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{name}</strong><small>{group.members.length}</small>
      </button></h3>
      {(names.get(name) ?? 0) > 1 && <p className="mobile-folder-path">{group.cwd}</p>}
      {waiting > 0 && <p className="mobile-folder-waiting">{waiting} waiting on you</p>}
      {working > 0 && <p className="mobile-folder-working">{working} working</p>}
      <div id={membersId} className="mobile-folder-members" hidden={!open}>{group.members.map(sessionButton)}</div>
    </section>;
  })}</>;
}
