import { basename } from 'node:path';
import type { LetterStatus, Verdict } from './files.ts';
import type { MailDb } from './log.ts';

// Option B of the "Fleet Mail badges" mockups (David, 2026-09-29): a plane on
// the card of a session that started reviews, a tray on a reviewer's card.

export type BadgeState = 'writing' | 'fresh' | 'idle';
export interface MailBadge { kind: 'sender' | 'reviewer'; count: string; state: BadgeState; tip: string }

export interface BadgeOptions {
  /** Whether the sender has already collected this letter's reply. */
  isRead: (letterId: string) => boolean;
  pidOfTmux: (tmux: string) => number | null;
  passLimit: number;
  /** Loops untouched since this time are left out. */
  since: number;
}

interface Row {
  specialist: string; project: string; fromTool: string; tmux: string | null;
  letterId: string; pass: number; status: LetterStatus; verdict: Verdict | null; senderPid: number | null;
}

// Each recent loop's latest pass, with the process that started the loop.
const LATEST = `
SELECT l.specialist, l.project, l.from_tool AS fromTool, l.tmux,
       t.id AS letterId, t.pass, t.status, t.verdict,
       (SELECT f.from_pid FROM letters f WHERE f.loop_id = l.id AND f.pass = 1) AS senderPid
FROM loops l JOIN letters t ON t.loop_id = l.id
WHERE l.updated_at > ? AND t.pass = (SELECT MAX(m.pass) FROM letters m WHERE m.loop_id = l.id)
ORDER BY l.created_at, l.rowid`;

const busy = (s: LetterStatus): boolean => s === 'queued' || s === 'running';
const word = (r: Row): string => (busy(r.status) ? 'writing'
  : r.status === 'replied' ? (r.verdict === 'approved' ? 'approved' : 'changes requested')
  : r.status.replace('_', ' '));

/** The badges for each card, keyed by the card's process id. */
export function mailBadges(db: MailDb, o: BadgeOptions): Record<number, MailBadge[]> {
  const rows = db.prepare(LATEST).all(o.since) as Row[];
  const out: Record<number, MailBadge[]> = {};
  const add = (pid: number, badge: MailBadge): void => { (out[pid] ??= []).push(badge); };
  const bySender = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.senderPid !== null) bySender.set(r.senderPid, [...(bySender.get(r.senderPid) ?? []), r]);
    const pid = r.tmux ? o.pidOfTmux(r.tmux) : null;
    if (pid === null) continue;
    const what = busy(r.status) ? 'Writing' : r.status === 'replied' ? 'Answered' : `Stopped (${word(r)}) at`;
    add(pid, {
      kind: 'reviewer', count: `${r.pass}/${o.passLimit}`, state: busy(r.status) ? 'writing' : 'idle',
      tip: `${what} pass ${r.pass} of ${o.passLimit} for ${r.fromTool} · ${basename(r.project)}`,
    });
  }
  for (const [pid, loops] of bySender) {
    const state: BadgeState = loops.some(r => busy(r.status)) ? 'writing'
      : loops.some(r => r.status === 'replied' && !o.isRead(r.letterId)) ? 'fresh' : 'idle';
    const n = loops.length;
    add(pid, {
      kind: 'sender', count: `×${n}`, state,
      tip: [`${n} review${n === 1 ? '' : 's'}`, ...loops.map(r => `${r.specialist}, pass ${r.pass} of ${o.passLimit}, ${word(r)}`)].join(' · '),
    });
  }
  return out;
}
