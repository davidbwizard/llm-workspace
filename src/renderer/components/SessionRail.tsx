import type { OpenSession } from '../../fleet/state.ts';
import { OpenSessionCard } from './OpenSessionCard.tsx';
import './SessionRail.css';

/** The card grid, collapsed to one column. Deliberately reuses
 *  OpenSessionCard rather than a slimmer variant: the whole point is that the
 *  fleet stays readable while you work in one session, which means the cards
 *  keep their content and their attention state.
 *
 *  onKill is stubbed to `already_gone` rather than wired to the real
 *  session:kill channel -- this component's own Interfaces contract has no
 *  onKill prop, and Task 12 (which mounts this alongside the pane it wires
 *  a real callback into) is what decides whether Close belongs in the rail
 *  at all. The stub keeps OpenSessionCard's contract satisfied without
 *  silently no-op'ing a destructive action the person thinks fired. */
export function SessionRail({ sessions, selectedPid, onSelect, side }: {
  sessions: OpenSession[];
  selectedPid: number | null;
  onSelect: (pid: number) => void;
  side: 'left' | 'right';
}) {
  return (
    <nav className={`rail ${side}`} aria-label="Open sessions">
      {sessions.map(s => (
        <div key={s.pid} className={s.pid === selectedPid ? 'railitem sel' : 'railitem'}>
          <OpenSessionCard
            state={s}
            onOpen={onSelect}
            onKill={async () => ({ status: 'already_gone' as const })}
          />
        </div>
      ))}
    </nav>
  );
}
