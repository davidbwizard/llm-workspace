import { contextBridge, ipcRenderer } from 'electron';

/** The complete surface the renderer can reach. Every channel is named here
 *  and validated in main; there is deliberately no generic invoke, because one
 *  would let any renderer bug call any handler (spec §11.1). */
const api = {
  listFleet: () => ipcRenderer.invoke('fleet:list'),
  listHistory: () => ipcRenderer.invoke('fleet:history'),
  onFleet: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('fleet:update', handler);
    return () => ipcRenderer.off('fleet:update', handler);
  },
};

contextBridge.exposeInMainWorld('fleet', api);
export type FleetApi = typeof api;
