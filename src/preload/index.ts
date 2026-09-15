import { contextBridge, ipcRenderer } from 'electron';
import type { ConversationCursor } from '../store/conversation.ts';

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
  sendKeys: (pid: number, text: string) => ipcRenderer.invoke('session:keys', pid, text),
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
  attach: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:attach', pid, cols, rows),
  detach: (pid: number) => ipcRenderer.invoke('session:detach', pid),
  resize: (pid: number, cols: number, rows: number) => ipcRenderer.invoke('session:resize', pid, cols, rows),
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
};

contextBridge.exposeInMainWorld('fleet', api);
export type FleetApi = typeof api;
