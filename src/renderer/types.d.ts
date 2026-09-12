import type { FleetListPayload, FleetHistoryPayload, KillResult, KeysResult } from '../main/ipc.ts';
import type { ConversationTurn } from '../store/conversation.ts';
import type { TerminalDataPayload } from '../main/stream.ts';

declare global {
  interface Window {
    // Optional, not asserted: Task 5 established that a failed preload
    // still leaves a normal-looking window, so this can genuinely be
    // undefined at runtime (the preload script errored or never ran).
    // Declaring it non-optional would let FleetView dereference it
    // straight through and throw at mount with no user-visible signal --
    // marking it optional forces every call site to check first.
    fleet?: {
      listFleet: () => Promise<FleetListPayload>;
      listHistory: (offset: number, limit: number) => Promise<FleetHistoryPayload>;
      killSession: (pid: number) => Promise<KillResult>;
      revealSession: (pid: number) => Promise<RevealResult>;
      onFleet: (cb: (payload: FleetListPayload) => void) => () => void;
      // Main sanitises and revalidates pid and text on every call; this
      // typing narrows nothing at the trust boundary itself.
      sendKeys: (pid: number, text: string) => Promise<KeysResult>;
      conversation: (sessionId: string) => Promise<ConversationTurn[]>;
      // attach/detach/resize/sendRaw/launch/reattach: the streaming and
      // launch/reattach logic behind these lands in Tasks 10 and 13, which
      // is what actually defines their result shapes. Left as `unknown`
      // here rather than guessed at, so this task does not invent a
      // contract those tasks then have to conform to (or silently diverge
      // from).
      attach: (pid: number, cols: number, rows: number) => Promise<unknown>;
      detach: (pid: number) => Promise<unknown>;
      resize: (pid: number, cols: number, rows: number) => Promise<unknown>;
      sendRaw: (pid: number, data: string) => Promise<unknown>;
      launch: (provider: string, cwd: string, cols: number, rows: number) => Promise<unknown>;
      reattach: (pid: number, cols: number, rows: number) => Promise<unknown>;
      onTerminalData: (cb: (payload: TerminalDataPayload) => void) => () => void;
    };
  }
}
export {};
