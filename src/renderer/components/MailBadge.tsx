import type { MailBadge as Badge } from '../../mail/badges.ts';
import { Icon } from './Icon.tsx';
import './MailBadge.css';

/** Fleet Mail on a session card. Option B of the "Fleet Mail badges"
 *  mockups (David, 2026-09-29): a plane on a session that started reviews,
 *  a tray on a reviewer, and a dot for what is happening now -- gold while
 *  a reviewer writes, green while a reply waits unread. Terse on purpose:
 *  the card's metrics row has overflowed its card before (see the agents
 *  count beside it). */
export function MailBadges({ badges }: { badges: Badge[] }) {
  if (badges.length === 0) return null;
  return <>{badges.map(b => <MailBadge key={b.kind} badge={b} />)}</>;
}

function MailBadge({ badge }: { badge: Badge }) {
  return (
    <span className={`mailbadge ${badge.kind} ${badge.state}`} title={badge.tip}>
      {badge.kind === 'sender' ? <Icon name="paper-plane" size={12} weight="fill" /> : <Icon name="tray" size={12} />}
      <span className="mailbadge-n" aria-hidden="true">{badge.count}</span>
      {badge.state !== 'idle' && <span className={`mailbadge-dot ${badge.state}`} aria-hidden="true" />}
      {/* The digits and dot are decoration; this is the accessible name. */}
      <span className="mailbadge-name">{badge.tip}</span>
    </span>
  );
}
