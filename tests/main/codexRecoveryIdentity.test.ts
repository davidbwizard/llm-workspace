import { describe, it, expect } from 'vitest';
import { CodexThreadTracker } from '../../src/main/codexRelayProtocol.ts';
import { codexRelayBindingForPid } from '../../src/main/codexRelayControl.ts';
const ID = '01a0da03-b7a1-7542-a9b9-e325e92c221f';
const NAME = 'llmws-codex-relay-857a5c44';
describe('exact identity and readiness', () => {
  it('retains a verified ID on physical disconnect but invalidates it before switching', () => {
    const states: any[] = [];
    const tracker = new CodexThreadTracker(() => {}, state => states.push(state));
    tracker.fromTui({ id: 1, method: 'thread/start' });
    tracker.fromServer({ id: 1, result: { thread: { id: ID } } });
    tracker.disconnected();
    expect(states.at(-1)).toMatchObject({ state: 'disconnected', threadId: ID });
    tracker.fromTui({ id: 2, method: 'thread/resume' });
    expect(states.at(-1)).toMatchObject({ state: 'switching', threadId: null });
    tracker.disconnected();
    expect(states.at(-1).threadId).toBeNull();
  });
  it('invalid observation cannot preserve a recoverable identity', () => {
    const states: any[] = [];
    const tracker = new CodexThreadTracker(() => {}, state => states.push(state));
    tracker.fromTui({ id: 1, method: 'thread/start' });
    tracker.fromServer({ id: 1, result: { thread: { id: ID } } });
    tracker.invalidated(); tracker.disconnected();
    expect(states.at(-1)).toMatchObject({ state: 'unknown', threadId: null });
  });
  const deps = (options: Record<string,string>, relay = false) => ({
    nameForPid: () => NAME, pidForName: () => 21, hasSession: (name: string) => name === NAME || relay,
    readOption: (_name: string, option: string) => options[option] ?? null,
  });
  it('keeps exact atomic identity when its relay vanishes, without claiming ready', () => {
    const binding = codexRelayBindingForPid(21, deps({ '@llmws-codex-binding': JSON.stringify({ v:1,state:'ready',threadId:ID,updatedAt:1 }) }));
    expect(binding).toMatchObject({ name:NAME, threadId:ID, ready:false, relayAlive:false });
  });
  it('accepts legacy connected1 with missing relay, never legacy connected0', () => {
    expect(codexRelayBindingForPid(21, deps({ '@llmws-codex-connected':'1','@llmws-codex-thread':ID })))
      .toMatchObject({ threadId:ID,ready:false });
    expect(codexRelayBindingForPid(21, deps({ '@llmws-codex-connected':'0','@llmws-codex-thread':ID })))
      .toMatchObject({ threadId:null,ready:false });
  });
  it('never falls back to legacy options when atomic metadata is malformed', () => {
    expect(codexRelayBindingForPid(21, deps({ '@llmws-codex-binding':'{broken','@llmws-codex-connected':'1','@llmws-codex-thread':ID }, true)))
      .toMatchObject({ threadId:null,ready:false });
  });
  it('does not expose a remembered thread on a recycled PID that no longer owns the pane',()=>{
    expect(codexRelayBindingForPid(21,{...deps({'@llmws-codex-connected':'1','@llmws-codex-thread':ID},true),pidForName:()=>99}))
      .toMatchObject({threadId:null,ready:false});
  });

});
