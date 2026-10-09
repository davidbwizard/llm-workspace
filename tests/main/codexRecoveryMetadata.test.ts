import { expect, it } from 'vitest';
import { codexConnectionForPid } from '../../src/main/codexRecoveryRuntime.ts';
const managed = 'llmws-codex-relay-857a5c44';
it('publishes explicit unknown metadata for a managed PID when ownership cannot resolve', () => {
  expect(codexConnectionForPid(21, { connection: () => undefined, nameForPid: () => managed }))
    .toMatchObject({ state: 'unknown', recoverable: false });
});
it('does not classify an ordinary Codex tmux name as managed or disconnected', () => {
  expect(codexConnectionForPid(21, { connection: () => undefined, nameForPid: () => 'adopted-codex' })).toBeUndefined();
  expect(codexConnectionForPid(21, { connection: () => undefined, nameForPid: () => null })).toBeUndefined();
});
it('preserves resolved connection identity, native access and input uncertainty metadata', () => {
  const connection = { state: 'ready' as const, recoverable: true, previousTerminalPid: 10, inputPending: true };
  expect(codexConnectionForPid(21, { connection: () => connection, nameForPid: () => managed })).toBe(connection);
});
