import { contextBridge, ipcRenderer } from 'electron';

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
};

contextBridge.exposeInMainWorld('fleet', api);
export type FleetApi = typeof api;
