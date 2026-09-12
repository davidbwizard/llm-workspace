import { useState } from 'react';
import type { OpenSession } from '../../fleet/state.ts';
import type { KillResult } from '../../main/ipc.ts';
import type { LaunchResult } from '../../main/launch.ts';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import { ReplyPopover } from './ReplyPopover.tsx';
import './SessionRail.css';

/** The card grid, collapsed to one column. Deliberately reuses
 *  OpenSessionCard rather than a slimmer variant: the whole point is that the
 *  fleet stays readable while you work in one session, which means the cards
 *  keep their content and their attention state.
 *
 *  onKill is now a real prop (Task 12 ruling): a Close button reachable in
 *  the live UI that always answers `already_gone` lies to the user, which is
 *  worse than no button at all -- the stub was acceptable only while this
 *  component was unmounted (Task 8). The caller (MainPane) passes the real
 *  window.fleet.killSession through.
 *
 *  Also opens the reply popover for whichever card is currently waiting on
 *  you -- spec: "click shows the prompt". This is a SEPARATE trigger from
 *  the card's own onOpen (which still just selects it, per the existing,
 *  already-reviewed "reports the pid when a card is chosen" test): opening a
 *  waiting session's popover must never be confused with switching the main
 *  pane to it, since the entire point is answering it WITHOUT losing your
 *  place. ReplyPopover itself stays untouched -- keyed by pid, no rail-shaped
 *  prop -- this component owns only the "which pid, if any" state and the
 *  anchoring markup around it. */
export function SessionRail({ sessions, selectedPid, onSelect, onKill, onReattach, onResume, side }: {
  sessions: OpenSession[];
  selectedPid: number | null;
  onSelect: (pid: number) => void;
  onKill: (pid: number) => Promise<KillResult>;
  onReattach: (pid: number, cols: number, rows: number) => Promise<LaunchResult>;
  onResume: (sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>;
  side: 'left' | 'right';
}) {
  const [replyPid, setReplyPid] = useState<number | null>(null);

  return (
    <nav className={`rail ${side}`} aria-label="Open sessions">
      {sessions.map(s => {
        const waiting = s.activity === 'waiting_permission' || s.activity === 'waiting_input';
        return (
          <div key={s.pid} className={s.pid === selectedPid ? 'railitem sel' : 'railitem'}>
            <OpenSessionCard state={s} onOpen={onSelect} onKill={onKill}
              onReattach={onReattach} onResume={onResume} />
            {waiting && (
              <button type="button" className="railreply" onClick={() => setReplyPid(s.pid)}>
                Reply
              </button>
            )}
            {replyPid === s.pid && (
              <ReplyPopover pid={s.pid} prompt={s.lastProse} onClose={() => setReplyPid(null)} />
            )}
          </div>
        );
      })}
    </nav>
  );
}
