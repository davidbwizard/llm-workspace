import { expect, it, vi } from 'vitest';
import { TerminalClients } from '../../src/main/terminalClients.ts';
function fixture() {
  const outputs = new Map<string, (event: string, payload: unknown) => void>();
  const deps = {
    identity: (pid: number): string | null => pid === 10 ? 'exact-process' : null,
    attach: vi.fn(async (client: string, _pid: number, _cols: number, _rows: number, emit: (event: string, payload: unknown) => void) => { outputs.set(client, emit); return { status: 'attached' }; }),
    detach: vi.fn(), resize: vi.fn(), size: vi.fn(), input: vi.fn(), busy: () => false,
  };
  return { manager: new TerminalClients(deps), deps, outputs };
}
it('releases only the disconnected viewer, and rejects input after takeover', async () => {
  const { manager, deps } = fixture(); const desktop = vi.fn(); const phone = vi.fn();
  await manager.attach('desktop', 10, 100, 30, desktop);
  await manager.attach('phone', 10, 40, 20, phone);
  expect(manager.input('phone', 10, 'x')).toMatchObject({ status: 'refused', reason: 'not_controller' });
  manager.takeControl('phone', 10);
  expect(manager.input('desktop', 10, 'x')).toMatchObject({ status: 'refused' });
  expect(manager.input('phone', 10, 'x')).toMatchObject({ status: 'sent' });
  manager.release('phone');
  expect(deps.detach).toHaveBeenCalledWith('phone', 10);
  expect(deps.detach).not.toHaveBeenCalledWith('desktop', 10);
  manager.close();
});
it('observers cannot resize the pane and new viewers use the owner size', async () => {
  const { manager, deps } = fixture();
  await manager.attach('desktop', 10, 100, 30, () => {});
  await manager.attach('phone', 10, 40, 20, () => {});
  expect(deps.attach.mock.calls[1]?.slice(1, 4)).toEqual([10, 100, 30]);
  expect(manager.resize('phone', 10, 40, 20)).toMatchObject({ status: 'refused' });
  manager.resize('desktop', 10, 120, 40);
  expect(deps.size).toHaveBeenLastCalledWith(10, 120, 40);
  expect(deps.resize).toHaveBeenCalledWith('phone', 10, 120, 40);
  manager.close();
});
it('rejects a changed process identity and an operation still awaiting approval settlement', async () => {
  const { manager, deps } = fixture();
  await manager.attach('phone', 10, 80, 24, () => {});
  deps.busy = () => true;
  expect(manager.input('phone', 10, 'x')).toMatchObject({ status: 'refused', reason: 'busy' });
  deps.busy = () => false; deps.identity = () => 'reused-pid';
  expect(manager.input('phone', 10, 'x')).toMatchObject({ status: 'refused', reason: 'stale' });
  expect(deps.input).not.toHaveBeenCalled(); manager.close();
});
