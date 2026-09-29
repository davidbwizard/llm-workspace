import { useSyncExternalStore } from 'react';
import type { MailBadge } from '../../mail/badges.ts';

// Fleet Mail badges for every card, held once for the whole window: one
// listener on 'mail:update', however many cards read from it.

type BadgeMap = Record<number, MailBadge[]>;

let badges: BadgeMap = {};
const listeners = new Set<() => void>();
let started = false;
const NONE: MailBadge[] = [];

function set(next: BadgeMap | null | undefined): void {
  badges = next ?? {};
  for (const listener of listeners) listener();
}

function start(): void {
  if (started || typeof window === 'undefined' || !window.fleet?.onMail) return;
  started = true;
  window.fleet.onMail(set);
  window.fleet.mailBadges().then(set, (e: unknown) => console.error('Fleet Mail: could not load badges:', e));
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The badges for the card whose process is `pid`. */
export function useMailBadges(pid: number | null | undefined): MailBadge[] {
  return useSyncExternalStore(subscribe, () => (pid != null ? badges[pid] ?? NONE : NONE));
}
