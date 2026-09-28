import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchSession } from '../main/launch.ts';
import { cancelCopyMode, hasSession, paneInMode, sendKeyName, sendLiteral, type TmuxExec } from '../main/tmux.ts';
import { projectDir } from '../providers/claude/projectKey.ts';
import { findCodexRollout, readReply, type SessionDriver } from './session.ts';

export interface FleetDriverOptions {
  exec?: TmuxExec;
  panePid?: (name: string) => number | null;
  now?: () => number;
}

/** Specialist sessions go through Fleet's own launch and tmux helpers, so
 *  they appear as ordinary Fleet sessions and share their name guard. */
export function createFleetDriver(o: FleetDriverOptions): SessionDriver {
  const now = o.now ?? Date.now;
  return {
    open: (runsOn, project, command, tmux) => {
      const r = launchSession(runsOn, project, 120, 40, { exec: o.exec, panePid: o.panePid }, command, tmux);
      return r.status === 'launched' ? null : r.reason;
    },
    alive: tmux => hasSession(tmux, o.exec),
    typeLine: (tmux, line) => {
      // A pane left in scroll mode would swallow the keys.
      const mode = paneInMode(tmux, o.exec);
      if (mode.ok && mode.stdout.trim() === '1') {
        const left = cancelCopyMode(tmux, o.exec);
        if (!left.ok) return left.error;
      }
      const typed = sendLiteral(tmux, line, o.exec);
      if (!typed.ok) return typed.error;
      const entered = sendKeyName(tmux, 'Enter', o.exec);
      return entered.ok ? null : entered.error;
    },
    claudeTranscript: (project, sessionId) => join(projectDir(project), `${sessionId}.jsonl`),
    findCodexRollout: (marker, sinceMs) => findCodexRollout(join(homedir(), '.codex/sessions'), marker, sinceMs, now()),
    size: file => {
      try {
        return statSync(file).size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw e;
      }
    },
    readReply,
  };
}
