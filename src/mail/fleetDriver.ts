import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchSession } from '../main/launch.ts';
import { codexBusyFromTail, ROLLOUT_TAIL_BYTES } from '../main/codexBusy.ts';
import {
  cancelCopyMode, capturePane, deleteBuffer, hasSession, loadBuffer, paneInMode, pasteBuffer, sendKeyName, type TmuxExec,
} from '../main/tmux.ts';
import { projectDir } from '../providers/claude/projectKey.ts';
import { findCodexRollout, readReply, type SessionDriver } from './session.ts';

export interface FleetDriverOptions {
  exec?: TmuxExec;
  panePid?: (name: string) => number | null;
  now?: () => number;
  /** Blocking wait between paste-settle checks. Injectable for tests. */
  sleepSync?: (ms: number) => void;
}

// Buffer names from their own range, so they never meet ipc.ts's.
let bufferSeq = 1_000_000_000;
const SETTLE_LINES = 8;
const SETTLE_ATTEMPTS = 10;
const SETTLE_MS = 30;
const blockFor = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Specialist sessions go through Fleet's own launch and tmux helpers, so
 *  they appear as ordinary Fleet sessions and share their name guard. */
export function createFleetDriver(o: FleetDriverOptions): SessionDriver {
  const now = o.now ?? Date.now;
  const sleepSync = o.sleepSync ?? blockFor;
  return {
    open: (runsOn, project, command, tmux) => {
      const r = launchSession(runsOn, project, 120, 40, { exec: o.exec, panePid: o.panePid }, command, tmux);
      return r.status === 'launched' ? null : r.reason;
    },
    alive: tmux => hasSession(tmux, o.exec),
    typeLine: (tmux, line, queue) => {
      // A pane left in scroll mode would swallow the keys.
      const mode = paneInMode(tmux, o.exec);
      if (mode.ok && mode.stdout.trim() === '1') {
        const left = cancelCopyMode(tmux, o.exec);
        if (!left.ok) return left.error;
      }
      // A bracketed paste, never typed keys: Codex reads a burst of typed
      // keys plus Enter as one paste and leaves it unsubmitted (measured by
      // Fleet, see sendKeysFor in src/main/ipc.ts).
      const before = capturePane(tmux, SETTLE_LINES, o.exec);
      if (!before.ok) return before.error;
      const buffer = `llmws-p${process.pid}-${(bufferSeq += 1)}`;
      const loaded = loadBuffer(tmux, buffer, line, o.exec);
      if (!loaded.ok) return loaded.error;
      const pasted = pasteBuffer(tmux, buffer, o.exec);
      if (!pasted.ok) {
        const dropped = deleteBuffer(buffer, o.exec);
        if (!dropped.ok) console.error('Fleet Mail: tmux delete-buffer failed:', dropped.error);
        return pasted.error;
      }
      // Let the TUI finish taking the paste, or it swallows the key that follows.
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
        if (attempt > 0) sleepSync(SETTLE_MS);
        const screen = capturePane(tmux, SETTLE_LINES, o.exec);
        if (!screen.ok || screen.stdout !== before.stdout) break;
      }
      const key = sendKeyName(tmux, queue ? 'Tab' : 'Enter', o.exec);
      return key.ok ? null : key.error;
    },
    codexBusy: file => {
      let fd: number;
      try {
        fd = openSync(file, 'r');
      } catch (e) {
        if (isMissing(e)) return false;
        throw e;
      }
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, ROLLOUT_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        return codexBusyFromTail(buf.toString('utf8'));
      } finally {
        closeSync(fd);
      }
    },
    claudeTranscript: (project, sessionId) => join(projectDir(project), `${sessionId}.jsonl`),
    findCodexRollout: (marker, sinceMs) => findCodexRollout(join(homedir(), '.codex/sessions'), marker, sinceMs, now()),
    size: file => {
      try {
        return statSync(file).size;
      } catch (e) {
        if (isMissing(e)) return 0;
        throw e;
      }
    },
    readReply,
  };
}
