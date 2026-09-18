import type { FleetListPayload, FleetHistoryPayload, KillResult, KeysResult } from '../main/ipc.ts';
import type { ConversationPage, ConversationCursor } from '../store/conversation.ts';
import type { TerminalDataPayload } from '../main/stream.ts';
import type { LaunchResult } from '../main/launch.ts';
import type { ImageResult } from '../main/images.ts';
import type { AttachmentResult } from '../main/attachments.ts';
import type { StageResult } from '../main/staging.ts';
import type { SessionLivePayload } from '../main/sessionLive.ts';
import type { AnswerResult } from '../main/answer.ts';
import type { Answer } from '../core/prompt.ts';
import type { HooksResult } from '../hooks/switch.ts';
import type { UsageSwitchResult } from '../hooks/usageSwitch.ts';
import type { CompactsAtResult } from '../main/usage.ts';
import type { UsagePayload } from '../core/usage.ts';

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
      sendKeys: (pid: number, text: string, attach?: { images: string[]; files: string[] }) => Promise<KeysResult>;
      // Answers the prompt Claude is waiting on. Main re-derives the prompt
      // and checks the answer and the pane itself; this typing narrows
      // nothing at the trust boundary.
      answerPrompt: (pid: number, promptId: string, answer: Answer) => Promise<AnswerResult>;
      // An image's bytes, checked and held by main until sent.
      stageImage: (bytes: ArrayBuffer) => Promise<StageResult>;
      // Any other file's bytes and name, held by main until sent.
      stageFile: (bytes: ArrayBuffer, name: string) => Promise<StageResult>;
      // cursor pages backward (older) from a prior page's nextCursor;
      // omitted for the first, newest page.
      conversation: (sessionId: string, cursor?: ConversationCursor) => Promise<ConversationPage>;
      // An image a reply links to, read and checked by main.
      image: (sessionId: string, src: string) => Promise<ImageResult>;
      // Images attached to one of your prompts, read back by main.
      attachments: (turnId: number) => Promise<AttachmentResult>;
      // attach/detach/resize/sendRaw: Tasks 6b/10's streaming bridge. Left as
      // `unknown` here rather than guessed at when this file was written --
      // TerminalView.tsx (Task 10) narrows each with its own local cast
      // instead. Out of this task's scope to revisit.
      attach: (pid: number, cols: number, rows: number) => Promise<unknown>;
      detach: (pid: number) => Promise<unknown>;
      resize: (pid: number, cols: number, rows: number) => Promise<unknown>;
      sendRaw: (pid: number, data: string) => Promise<unknown>;
      // Which session's conversation is on screen; pid: null stops
      // watching. Main revalidates pid itself (src/main/sessionLive.ts's
      // watchSessionFor) -- this typing narrows nothing at the trust
      // boundary. Resolves to whether a session is now being watched.
      watchSession: (pid: number | null) => Promise<boolean>;
      onSessionLive: (cb: (payload: SessionLivePayload) => void) => () => void;
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
      // Quick answers (Settings): the switch's real state, re-read fresh
      // from settings.json on every call, and the toggle itself. Main
      // never trusts the renderer's own copy of `installed` -- this typing
      // narrows nothing at the trust boundary itself.
      hooksGet: () => Promise<HooksResult>;
      hooksSet: (on: boolean) => Promise<HooksResult>;
      // Usage and context: the Settings switch (re-read from settings.json
      // on every call; `error` is the refusal to show, e.g. "You already
      // have a status line in settings.json -- not replaced."), the Usage
      // button's rate limits, and the Compacts at setting (main is its only
      // copy; a refused value changes nothing).
      usageSwitchGet: () => Promise<UsageSwitchResult>;
      usageSwitchSet: (on: boolean) => Promise<UsageSwitchResult>;
      usageGet: () => Promise<UsagePayload>;
      compactsAtGet: () => Promise<{ compactsAt: number }>;
      compactsAtSet: (value: number) => Promise<CompactsAtResult>;
    };
  }
}
export {};
