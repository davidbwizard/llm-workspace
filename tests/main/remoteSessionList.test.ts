import { expect, it, vi } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { refreshLiveProcesses } from '../../src/discovery/live.ts';
import { registerSession, clearRegistry } from '../../src/main/sessions.ts';
import { codexDisplay } from '../../src/main/codexRecoveryRuntime.ts';
import { registerIpc, refreshPushEnrichment, fleetSessionOperations } from '../../src/main/ipc.ts';

vi.mock('electron', () => ({ ipcMain: { handle() {}, on() {} }, app: { on() {}, setBadgeCount() {} }, BrowserWindow: {}, dialog: {}, nativeTheme: {}, shell: {} }));
// Registration sweeps attachment folders; this test must not touch user files.
vi.mock('../../src/main/staging.ts', () => ({ createStager: () => ({ sweep: async () => {} }), createFileStager: () => ({ sweep: async () => {} }) }));
vi.mock('../../src/providers/codex/stateDb.ts', () => ({ readCodexThreadNames: () => new Map([['01a13b4c-8e5d-7c50-b19e-5027fee72eb6', 'Phone session']]) }));

it('remote polling includes the verified Codex thread and name from discovery enrichment', async () => {
  const db = openDb(':memory:');
  const threadId = '01a13b4c-8e5d-7c50-b19e-5027fee72eb6';
  const tmux = 'llmws-codex-relay-01234567';
  const thread = vi.spyOn(codexDisplay, 'thread').mockReturnValue(threadId);
  const connection = vi.spyOn(codexDisplay, 'connection').mockReturnValue(undefined);
  try {
    const processes = await refreshLiveProcesses(async (bin, args) => {
      if (bin === 'ps' && args[0] === '-axo') return '4242 codex\n';
      if (bin === 'lsof') return 'p4242\nfcwd\nn/repo/mobile\n';
      return '';
    });
    registerSession(4242, tmux);
    refreshPushEnrichment(db, processes, Date.now(), { statusLineDir: '/nonexistent-fleet-statusline', codexSessions: '/nonexistent-fleet-codex' });
    registerIpc(db);
    const operations = fleetSessionOperations!;
    const identity = vi.spyOn(operations.dependencies, 'identity').mockReturnValue({ pid: 4242, provider: 'codex', sessionId: threadId, started: 'start', tmux });
    const prepare = vi.spyOn(db, 'prepare');
    const row = operations.list()[0]!;
    expect(row).toMatchObject({ pid: 4242, sessionId: threadId, name: 'Phone session', controllable: true });
    expect(row.handle).toEqual(expect.any(String));
    expect(prepare).not.toHaveBeenCalled();
    identity.mockReturnValue({ pid: 4242, provider: 'codex', sessionId: 'different-thread', started: 'start', tmux });
    expect(operations.list()[0]).toMatchObject({ handle: null, controllable: false });
  } finally {
    thread.mockRestore(); connection.mockRestore(); clearRegistry(); db.close();
  }
});
