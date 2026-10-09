import { describe, expect, it, vi } from 'vitest';
import { codexRelayThreadForPid, waitForCodexThreadId, codexRelayInputRefusal } from '../../src/main/codexRelayControl.ts';

const THREAD = '01a0da0c-2964-76a2-bf2e-dbcbb26243df';

describe('codexRelayThreadForPid', () => {
  const deps = {
    nameForPid: () => 'llmws-codex-relay-857a5c44',
    pidForName: () => 4821,
    hasSession: () => true,
    readOption: (_name: string, option: string) =>
      option === '@llmws-codex-binding' ? null : option === '@llmws-codex-connected' ? '1' : THREAD,
  };

  it('returns an exact ID only while the TUI and its own relay are connected', () => {
    expect(codexRelayThreadForPid(4821, deps)).toBe(THREAD);
    expect(codexRelayThreadForPid(4821, { ...deps, hasSession: name => name !== 'fleet-codex-relay-857a5c44' })).toBe(THREAD);
    expect(codexRelayThreadForPid(4821, { ...deps, readOption: () => '0' })).toBe(false);
    expect(codexRelayThreadForPid(4821, { ...deps, nameForPid: () => 'llmws-claude-857a5c44' })).toBeNull();
  });

  it('rejects malformed IDs from tmux', () => {
    expect(codexRelayThreadForPid(4821, { ...deps, readOption: (_name, option) =>
      option === '@llmws-codex-binding' ? null : option === '@llmws-codex-connected' ? '1' : 'old-id\nmalicious' })).toBe(false);
  });
});

// The thread id does not exist when the TUI is spawned: it appears only
// once the TUI has connected through the relay and the App Server has
// answered its thread/start. Anything that needs the id at launch time has
// to wait for it.
describe('waitForCodexThreadId', () => {
  it('resolves the moment the relay publishes an exact id', async () => {
    const answers: (string | false | null)[] = [false, false, THREAD];
    const thread = vi.fn(() => answers.shift() ?? THREAD);
    expect(await waitForCodexThreadId(4821, 1000, { thread, intervalMs: 1 })).toBe(THREAD);
    expect(thread).toHaveBeenCalledTimes(3);
    expect(thread).toHaveBeenCalledWith(4821);
  });

  // Bounded, and a timeout is a plain null rather than a throw -- the
  // caller decides what a missing id costs, and for a launch it costs the
  // name, never the session.
  it('gives up at the timeout instead of waiting forever', async () => {
    const started = Date.now();
    expect(await waitForCodexThreadId(4821, 60, { thread: () => false, intervalMs: 10 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // `false` is "Fleet relay TUI whose exact thread is not available yet",
  // which is worth waiting through; `null` is "not a Fleet relay TUI at
  // all", which no amount of waiting will change.
  it('stops immediately when the pid is not a Fleet relay TUI', async () => {
    const thread = vi.fn(() => null);
    expect(await waitForCodexThreadId(4821, 1000, { thread, intervalMs: 1 })).toBeNull();
    expect(thread).toHaveBeenCalledTimes(1);
  });
});


describe('asynchronous final native input binding sample',()=>{
  const name='llmws-codex-relay-857a5c44';
  function read(raw: string,pid=4821,live=true){return vi.fn(async(args:string[])=>
    args[0]==='has-session'?{ok:live}:{ok:true,stdout:`${pid}\n${raw}\n1\n${THREAD}\n`});}
  const ready=JSON.stringify({v:1,state:'ready',threadId:THREAD,updatedAt:1});
  it('samples the current exact pane and atomic binding after checking relay liveness',async()=>{
    const exec=read(ready);expect(await codexRelayInputRefusal(4821,name,THREAD,exec)).toBeNull();
    expect(exec.mock.calls.map(([args])=>args[0])).toEqual(['has-session','display-message']);
    expect(exec.mock.calls[1]![0]).toContain(`=${name}:`);
  });
  it('fails closed for a recycled pane, missing relay, malformed binding and switched identity',async()=>{
    expect(await codexRelayInputRefusal(4821,name,THREAD,read(ready,999))).toBe('codex_not_ready');
    expect(await codexRelayInputRefusal(4821,name,THREAD,read(ready,4821,false))).toBe('codex_not_ready');
    expect(await codexRelayInputRefusal(4821,name,THREAD,read('{bad'))).toBe('codex_not_ready');
    expect(await codexRelayInputRefusal(4821,name,THREAD,read(JSON.stringify({v:1,state:'switching',threadId:null,updatedAt:1}))))
      .toBe('codex_identity_changed');
    expect(await codexRelayInputRefusal(4821,name,THREAD,async()=>({ok:false}))).toBe('codex_not_ready');
  });
  it('allows only exact connected legacy identity when no atomic value exists',async()=>{
    expect(await codexRelayInputRefusal(4821,name,THREAD,read(''))).toBeNull();
    expect(await codexRelayInputRefusal(4821,name,'01a0da03-b7a1-7542-a9b9-e325e92c221f',read(''))).toBe('codex_identity_changed');
  });
});
