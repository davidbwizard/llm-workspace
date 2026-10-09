import { expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: bridge.expose }, ipcRenderer: {
  invoke: bridge.invoke, sendSync: () => ({}), on: vi.fn(), off: vi.fn() } }));
import '../../src/preload/index.ts';
it('forwards exact expected session after attachment argument and exposes PID-only recovery', () => {
  const api = bridge.expose.mock.calls[0]![1];
  const id = '11111111-1111-4111-8111-111111111111', attachments = { images: ['image'], files: ['file'] };
  api.sendKeys(12, 'draft', attachments, id);
  expect(bridge.invoke).toHaveBeenLastCalledWith('session:keys', 12, 'draft', attachments, id);
  api.recoverCodex(12);
  expect(bridge.invoke).toHaveBeenLastCalledWith('session:codex:recover', 12);
  api.clearCodexInput(12, id);
  expect(bridge.invoke).toHaveBeenLastCalledWith('session:codex:input:clear', 12, id);
});
