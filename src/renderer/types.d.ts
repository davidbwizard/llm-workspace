import type { FleetListPayload, FleetHistoryPayload, KillResult, KeysResult } from '../main/ipc.ts';
import type { ConversationPage, ConversationCursor } from '../store/conversation.ts';
import type { TerminalDataPayload } from '../main/stream.ts';
import type { LaunchResult } from '../main/launch.ts';

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
      // cursor pages backward (older) from a prior page's nextCursor;
      // omitted for the first, newest page.
      conversation: (sessionId: string, cursor?: ConversationCursor) => Promise<ConversationPage>;
      // attach/detach/resize/sendRaw: Tasks 6b/10's streaming bridge. Left as
      // `unknown` here rather than guessed at when this file was written --
      // TerminalView.tsx (Task 10) narrows each with its own local cast
      // instead. Out of this task's scope to revisit.
      attach: (pid: number, cols: number, rows: number) => Promise<unknown>;
      detach: (pid: number) => Promise<unknown>;
      resize: (pid: number, cols: number, rows: number) => Promise<unknown>;
      sendRaw: (pid: number, data: string) => Promise<unknown>;
      // Opens the native folder picker; resolves to the chosen absolute
      // path, or null if the user cancelled. main still revalidates
      // whatever comes back (isAbsolutePath in session:launch) -- this
      // typing narrows nothing at the trust boundary itself.
      chooseDirectory: () => Promise<string | null>;
      // launch/reattach (Task 13, src/main/launch.ts): real result shapes
      // now that main actually answers them instead of the not_implemented
      // stub.
      launch: (provider: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>;
      reattach: (pid: number, cols: number, rows: number) => Promise<LaunchResult>;
      // The recovery path for reattach's 'killed_not_relaunched' state --
      // see preload/index.ts's own comment on it.
      resume: (sessionId: string, cwd: string, cols: number, rows: number) => Promise<LaunchResult>;
      onTerminalData: (cb: (payload: TerminalDataPayload) => void) => () => void;
      // Main validates the value against its own three literals
      // (applyThemeChoice); this typing narrows nothing at the trust
      // boundary itself.
      setTheme: (theme: string) => Promise<unknown>;
    };
  }
}
export {};
