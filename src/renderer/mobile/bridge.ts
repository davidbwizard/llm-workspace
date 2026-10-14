import type { MobileConnection } from './connection.ts';
import type { TerminalBridge } from '../components/TerminalView.tsx';
import type { OperationResult } from '../../core/remote.ts';
export function unwrap<T>(result: OperationResult): T {
  if (!result.ok) throw new Error(result.reason === 'uncertain' ? 'Connection lost. The action may have been sent. Check the session before trying again.' : `Could not complete the action (${result.reason}).`);
  return result.value as T;
}
export function terminalBridge(connection: MobileConnection, handle: string): TerminalBridge {
  const request = async (op: string, payload: object = {}) => unwrap(await connection.request('terminal:' + op, { handle, ...payload }));
  const subscribe = <T,>(event: string, callback: (payload: T) => void) => connection.onEvent((name, payload) => { if (name === event) callback(payload as T); });
  return {
    attach: (_pid, cols, rows) => request('attach', { cols, rows }), detach: () => request('detach'),
    resize: (_pid, cols, rows) => request('resize', { cols, rows }), sendRaw: (_pid, data) => request('input', { data }),
    takeTerminalControl: () => request('control'),
    onTerminalData: cb => subscribe('terminal:data', cb), onTerminalExit: cb => subscribe('terminal:exit', cb),
    onTerminalControl: cb => subscribe('terminal:control', cb),
  };
}
