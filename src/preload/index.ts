import { contextBridge, ipcRenderer } from 'electron';
import type { ConversationCursor } from '../store/conversation.ts';
import type { Answer } from '../core/prompt.ts';

/** The complete surface the renderer can reach. Every channel is named here
 *  and validated in main; there is deliberately no generic invoke, because one
 *  would let any renderer bug call any handler (spec §11.1). */
const api = {
  listFleet: () => ipcRenderer.invoke('fleet:list'),
  listHistory: (offset: number, limit: number) => ipcRenderer.invoke('fleet:history', offset, limit),
  // The app's first destructive channel. pid is the only argument -- main
  // (src/main/ipc.ts's killSession) revalidates it against a fresh
  // discovery sweep itself; this is not a trust boundary the preload can
  // narrow by typing the argument as `number`, since a compromised or
  // buggy renderer can call ipcRenderer.invoke directly regardless of what
  // TypeScript says here.
  killSession: (pid: number) => ipcRenderer.invoke('session:kill', pid),
  // Brings the session's terminal app forward. main picks WHICH app from its
  // own discovery data; the pid is the only thing the renderer gets to say.
  revealSession: (pid: number) => ipcRenderer.invoke('session:reveal', pid),
  onFleet: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('fleet:update', handler);
    return () => ipcRenderer.off('fleet:update', handler);
  },
  // Free-form text from the renderer: the first channel of its kind here.
  // Main sanitises and revalidates; the typing below narrows nothing.
  sendKeys: (pid: number, text: string, attach?: { images: string[]; files: string[] }) =>
    ipcRenderer.invoke('session:keys', pid, text, attach),
  // Answers the prompt Claude is waiting on (quick answers). Main
  // re-derives the prompt, checks the answer against it and the pane, and
  // presses nothing it cannot confirm; this typing narrows nothing.
  answerPrompt: (pid: number, promptId: string, answer: Answer) =>
    ipcRenderer.invoke('session:answer', pid, promptId, answer),
  // Switches the session's permission mode (mode-switcher design §4). The
  // pid and the mode name are the renderer's whole say: main resolves the
  // provider itself, checks the mode against that provider's own list,
  // refuses mid-turn or with a prompt card up, and presses only BTab. This
  // typing narrows nothing at the trust boundary. There is no matching
  // getter -- the chip's state rides the session:live push instead, so it
  // follows a mode changed in the terminal as well as one changed here.
  setMode: (pid: number, mode: string) => ipcRenderer.invoke('session:mode:set', pid, mode),
  // An image's bytes, for main to check and hold until sent; returns an id.
  stageImage: (bytes: ArrayBuffer) => ipcRenderer.invoke('session:stage-image', bytes),
  // Any other file's bytes and name, held the same way.
  stageFile: (bytes: ArrayBuffer, name: string) => ipcRenderer.invoke('session:stage-file', bytes, name),
  // Raw keystrokes from the terminal widget itself -- arrow keys, Ctrl-C, the
  // TUI menu navigation the reply box deliberately refuses. Separate channel
  // from sendKeys precisely because the rules differ: this one MUST pass
  // control bytes through, so it is only ever reachable from a focused
  // TerminalView, never from the popover.
  sendRaw: (pid: number, data: string) => ipcRenderer.invoke('session:raw', pid, data),
  // cursor pages backward (older) from a prior page's nextCursor; omitted
  // for the first, newest page. Typed here for the renderer's own benefit
  // only -- same as pid/text elsewhere in this file, main
  // (parseConversationCursor) is what actually validates this, not this
  // signature, since ipcRenderer.invoke is callable with any shape
  // regardless of what TypeScript says here.
  conversation: (sessionId: string, cursor?: ConversationCursor) =>
    ipcRenderer.invoke('session:conversation', sessionId, cursor),
  // An image a reply links to; main validates everything (src/main/images.ts).
  image: (sessionId: string, src: string) => ipcRenderer.invoke('session:image', sessionId, src),
  // Images attached to one of your prompts; main finds and checks them.
  attachments: (turnId: number) => ipcRenderer.invoke('session:attachments', turnId),
  // A file an agent's reply names. This is the only channel where a string
  // a MODEL wrote reaches an OS call, so main decides everything: the pid
  // is the only session-identifying argument, and main looks the session's
  // working directory up in its own discovery data from it (the renderer
  // never names a folder). fileProbe only stats -- it is what lets a path
  // that does not resolve stay plain text instead of becoming a dead link.
  // fileOpen reads a small markdown file back as text, or reveals anything
  // else in Finder; `reveal` asks for Finder regardless. Nothing is ever
  // handed to the OS default application. These typings narrow nothing at
  // the trust boundary -- see src/main/files.ts for every actual check.
  fileProbe: (pid: number, candidates: string[]) => ipcRenderer.invoke('session:file:probe', pid, candidates),
  fileOpen: (pid: number, candidate: string, reveal?: boolean) =>
    ipcRenderer.invoke('session:file:open', pid, candidate, reveal),
  attach: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:attach', pid, cols, rows),
  detach: (pid: number) => ipcRenderer.invoke('session:detach', pid),
  resize: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:resize', pid, cols, rows),
  // Which session's conversation is on screen. Main validates the pid and
  // refuses anything it does not already know as a live process; the
  // `number | null` typing below narrows nothing at that trust boundary,
  // same as every other channel here -- pid: null means "nothing is open,
  // stop watching". Resolves to whether a session is now being watched.
  watchSession: (pid: number | null) => ipcRenderer.invoke('session:watch', pid),
  onSessionLive: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('session:live', handler);
    return () => ipcRenderer.off('session:live', handler);
  },
  // Opens the native folder picker (LaunchBar's "Choose…" button). Returns
  // the chosen absolute path, or null on cancel -- main still revalidates
  // whatever comes back through isAbsolutePath in session:launch, same as
  // every other channel here.
  chooseDirectory: () => ipcRenderer.invoke('dialog:directory'),
  // provider/cwd/cols/rows are the renderer's whole say in what starts --
  // main (src/main/launch.ts) generates the tmux session name and reads the
  // pid itself, the same "renderer names a pid or an explicit directory,
  // main re-derives everything else" boundary every other channel here
  // keeps.
  launch: (provider: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.invoke('session:launch', provider, cwd, cols, rows),
  // pid is the only session-identifying argument -- main resolves which
  // session it is, ends it, and relaunches it under `claude --resume`
  // itself, as one call (src/main/launch.ts's reattachSession). A
  // 'killed_not_relaunched' result means exactly what it says: the old
  // process is gone and the new one did not start -- resume (below) is the
  // recovery path for that, not another reattach (there is no pid left to
  // reattach from).
  reattach: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:reattach', pid, cols, rows),
  // Relaunches a session from its own id/cwd, with no pid and no kill step
  // -- the only way to retry after 'killed_not_relaunched', since the old
  // pid is already gone from every discovery cache by the time that state
  // is reachable. contextBridge exposes this to the whole renderer scope,
  // callable with any string, not only the sessionId/cwd a prior
  // reattach/resume actually returned -- this is not a trust boundary the
  // preload can narrow by typing the arguments as `string` here, same as
  // every other channel in this file. What actually constrains sessionId
  // is main's own SESSION_ID_SAFE check (src/main/launch.ts) before it is
  // ever interpolated into a command; cwd is checked for an absolute path;
  // the provider is hardcoded to 'claude', never taken from the renderer.
  resume: (sessionId: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.invoke('session:resume', sessionId, cwd, cols, rows),
  onTerminalData: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.off('terminal:data', handler);
  },
  // The appearance choice, so the WINDOW follows it too -- nativeTheme
  // drives native scrollbars, the folder picker and the title bar, none of
  // which a data-theme attribute on the page can reach. Main checks the
  // value against its own three literals (applyThemeChoice); this typing
  // narrows nothing at the trust boundary, same as every other channel here.
  setTheme: (theme: string) => ipcRenderer.invoke('app:theme', theme),
  // Quick answers (Settings): the switch's own state and its toggle. Main
  // re-probes settings.json fresh on every call (src/hooks/switch.ts) --
  // this typing narrows nothing at the trust boundary, same as every other
  // channel here.
  hooksGet: () => ipcRenderer.invoke('hooks:get'),
  hooksSet: (on: boolean) => ipcRenderer.invoke('hooks:set', on),
  // Usage and context (Settings switch, Usage button). The switch is
  // re-read from settings.json on every call, like Quick answers -- this
  // typing narrows nothing at the trust boundary.
  usageSwitchGet: () => ipcRenderer.invoke('usage:switch:get'),
  usageSwitchSet: (on: boolean) => ipcRenderer.invoke('usage:switch:set', on),
  usageGet: () => ipcRenderer.invoke('usage:get'),
};

contextBridge.exposeInMainWorld('fleet', api);
export type FleetApi = typeof api;
