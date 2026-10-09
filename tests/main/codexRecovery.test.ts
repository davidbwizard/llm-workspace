import { describe,it,expect,vi } from 'vitest';
import { CodexRecovery, parseRecoveryMetadata, type RecoveryDeps } from '../../src/main/codexRecovery.ts';
const ID='01a0da03-b7a1-7542-a9b9-e325e92c221f';
const OTHER='01a0da04-34c5-7ba0-9266-524ffaa5d2fc';
const OLD='llmws-codex-relay-aaaaaaaa', NEXT='llmws-codex-relay-bbbbbbbb';
function fixture(threadId: string|null=ID) {
  let now=1000;
  const sessions=new Map<string,any>([[OLD,{pid:11,name:OLD,cwd:'/repo',binding:{name:OLD,threadId,ready:false,relayAlive:false,binding:null}}]]);
  const metadata=new Map<string,string>();
  const launched:string[]=[];
  const deps:RecoveryDeps={
    resolve:p=>[...sessions.values()].find(x=>x.pid===p)??null,
    resolveName:n=>sessions.get(n)??null,
    read:n=>metadata.get(n)??null,write:(n,v)=>{metadata.set(n,v);return true;},
    repair:async n=>{sessions.get(n).binding.relayAlive=true;},
    launch:async(n,_cwd,_id,previous)=>{launched.push(n); metadata.set(n,JSON.stringify({v:1,predecessor:previous,expectedThreadId:ID}));sessions.set(n,{pid:22,name:n,cwd:'/repo',binding:{name:n,threadId:null,ready:false,relayAlive:true,binding:null}}); return {status:'launched',pid:22};},
    exhausted:()=>false,now:()=>now,newName:()=>NEXT,
  };
  return {deps,sessions,metadata,launched,setNow:(n:number)=>{now=n;}};
}
describe('retired Codex successor recovery',()=>{
  const RETRY='llmws-codex-relay-cccccccc';
  function retired(conflict=false) {
    const f=fixture();f.sessions.get(OLD).binding.relayAlive=true;
    f.deps.names=()=>[...f.sessions.keys()];f.setNow(130000);
    f.deps.newName=vi.fn(()=>RETRY);
    f.metadata.set(OLD,JSON.stringify({v:1,successor:NEXT,expectedThreadId:ID,nativeSince:1000,
      ...(conflict?{candidate:RETRY,candidateSince:1000,launchSince:1000}:{})}));
    return f;
  }
  it('retires a proven absent successor before persisting a new candidate intent',async()=>{
    const f=retired();const r=new CodexRecovery(f.deps);
    expect(await r.recover(11)).toMatchObject({status:'recovering'});
    expect(parseRecoveryMetadata(f.metadata.get(OLD)!)).toMatchObject({candidate:RETRY,expectedThreadId:ID});
    expect(JSON.parse(f.metadata.get(OLD)!)).not.toHaveProperty('successor');
    expect(f.launched).toEqual([RETRY]);expect(f.sessions.has(OLD)).toBe(true);
  });
  it('repairs only the known successor/candidate conflict and reuses its durable allocation across restart',async()=>{
    const f=retired(true);const original=f.metadata.get(OLD)!;
    expect(parseRecoveryMetadata(original)).toBeNull();
    expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'recovering'});
    expect(f.launched).toEqual([RETRY]);expect(f.deps.newName).not.toHaveBeenCalled();
    expect(parseRecoveryMetadata(f.metadata.get(OLD)!)).toMatchObject({candidate:RETRY,expectedThreadId:ID});
    await new CodexRecovery(f.deps).recover(11);expect(f.launched).toEqual([RETRY]);
    f.sessions.get(RETRY).binding={name:RETRY,threadId:ID,ready:true,relayAlive:true,binding:null};
    expect(await new CodexRecovery(f.deps).recover(11)).toEqual({status:'ready',pid:22,sessionId:ID});
    expect(f.sessions.has(OLD)).toBe(true);
  });
  it('confirms a surviving exact candidate without allocating or launching another terminal',async()=>{
    const f=retired(true);
    f.sessions.set(RETRY,{pid:22,name:RETRY,cwd:'/repo',binding:{name:RETRY,threadId:ID,ready:true,relayAlive:true,binding:null}});
    f.metadata.set(RETRY,JSON.stringify({v:1,predecessor:OLD,expectedThreadId:ID}));
    expect(await new CodexRecovery(f.deps).recover(11)).toEqual({status:'ready',pid:22,sessionId:ID});
    expect(f.launched).toEqual([]);expect(f.deps.newName).not.toHaveBeenCalled();
  });
  for(const conflict of [false,true]) {
    for(const inventory of ['missing','failed','omits-current','successor-present'] as const)
      it(`preserves ${conflict?'conflicting':'valid'} intent when inventory is ${inventory}`,async()=>{
        const f=retired(conflict);const original=f.metadata.get(OLD);
        if(inventory==='missing')delete f.deps.names;
        else f.deps.names=()=>{if(inventory==='failed')throw new Error('tmux unavailable');return inventory==='omits-current'?[]:[OLD,NEXT];};
        expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'failed'});
        expect(f.metadata.get(OLD)).toBe(original);expect(f.launched).toEqual([]);
      });
    it(`refuses ${conflict?'conflicting':'valid'} intent after exact current identity changes`,async()=>{
      const f=retired(conflict);const original=f.metadata.get(OLD);f.sessions.get(OLD).binding.threadId=OTHER;
      expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'failed'});
      expect(f.metadata.get(OLD)).toBe(original);expect(f.launched).toEqual([]);
    });
  }
  for(const bad of [{candidateSince:'bad'},{predecessor:NEXT},{candidate:NEXT},{candidate:OLD},{successor:OLD},{expectedThreadId:OTHER}])
    it(`does not normalize other malformed/ambiguous state ${JSON.stringify(bad)}`,async()=>{
      const f=retired(true);f.metadata.set(OLD,JSON.stringify({...JSON.parse(f.metadata.get(OLD)!),...bad}));
      const original=f.metadata.get(OLD);
      expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'failed'});
      expect(f.metadata.get(OLD)).toBe(original);expect(f.launched).toEqual([]);
    });
  it('rechecks the owned PID and exact identity after the absence inventory',async()=>{
    const f=retired(true);const original=f.metadata.get(OLD);
    f.deps.names=()=>{f.sessions.set(OLD,{...f.sessions.get(OLD),pid:99});return [OLD];};
    expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'failed'});
    expect(f.metadata.get(OLD)).toBe(original);expect(f.launched).toEqual([]);
  });
  it('does not overwrite metadata that changed during the absence inventory',async()=>{
    const f=retired(true);const changed=JSON.stringify({v:1,expectedThreadId:OTHER});
    f.deps.names=()=>{f.metadata.set(OLD,changed);return [OLD];};
    expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'failed'});
    expect(f.metadata.get(OLD)).toBe(changed);expect(f.launched).toEqual([]);
  });
  it('preserves pending-input transfer refusal while normalizing the retired link',async()=>{
    const f=retired(true);f.deps.transferInput=vi.fn(()=>false);
    f.sessions.set(RETRY,{pid:22,name:RETRY,cwd:'/repo',binding:{threadId:ID,ready:true,relayAlive:true}});
    f.metadata.set(RETRY,JSON.stringify({v:1,predecessor:OLD,expectedThreadId:ID}));
    const r=new CodexRecovery(f.deps);expect(await r.recover(11)).toMatchObject({status:'failed'});
    expect(r.replacements()).toEqual([]);expect(r.connection(22)?.state).not.toBe('ready');
    expect(f.deps.transferInput).toHaveBeenCalledWith(OLD,RETRY,ID);expect(f.sessions.has(OLD)).toBe(true);
  });
});
describe('Codex automatic recovery lifecycle',()=>{
  it('repairs unknown legacy TUI at same endpoint before refusing an exact replacement',async()=>{
    const f=fixture(null);const recovery=new CodexRecovery(f.deps);
    expect(await recovery.recover(11)).toMatchObject({status:'recovering'});
    expect(f.sessions.get(OLD).binding.relayAlive).toBe(true);expect(f.launched).toEqual([]);
    f.setNow(130000);expect(await recovery.recover(11)).toMatchObject({status:'failed'});expect(f.launched).toEqual([]);
  });
  it('coalesces concurrent repairs and persists one exact candidate across app restarts',async()=>{
    const f=fixture();let release!:()=>void;
    f.deps.repair=()=>new Promise<void>(resolve=>{release=resolve;});
    const recovery=new CodexRecovery(f.deps);const a=recovery.recover(11), b=recovery.recover(11);
    await Promise.resolve(); release();await Promise.all([a,b]);
    f.sessions.get(OLD).binding.relayAlive=true;f.setNow(130000);
    expect(await recovery.recover(11)).toMatchObject({status:'recovering'});
    expect(f.launched).toEqual([NEXT]);
    const restarted=new CodexRecovery(f.deps);await restarted.recover(11);expect(f.launched).toEqual([NEXT]);
    f.sessions.get(NEXT).binding={name:NEXT,threadId:ID,ready:true,relayAlive:true,binding:null};
    expect(await restarted.recover(11)).toEqual({status:'ready',pid:22,sessionId:ID});
    expect(restarted.replacements()).toEqual([{previousPid:11,pid:22,sessionId:ID}]);
    expect(f.sessions.has(OLD)).toBe(true);
  });
  it('never hides a wrong-thread candidate or launches another',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);await r.recover(11);
    f.sessions.get(NEXT).binding={name:NEXT,threadId:OTHER,ready:true,relayAlive:true,binding:null};
    expect(await r.recover(11)).toMatchObject({status:'failed'});expect(r.replacements()).toEqual([]);
    await new CodexRecovery(f.deps).recover(11);expect(f.launched).toEqual([NEXT]);
  });
  it('fails candidate confirmation honestly at deadline, retaining both terminals',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);await r.recover(11);
    f.setNow(170000);expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'failed'});
    expect(f.sessions.size).toBe(2);expect(f.launched).toEqual([NEXT]);
  });
  it('bounds later failure to same-TUI repair while a predecessor remains',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);await r.recover(11);
    f.sessions.get(NEXT).binding={name:NEXT,threadId:ID,ready:true,relayAlive:true,binding:null};await r.recover(11);
    f.sessions.get(NEXT).binding.ready=false;f.sessions.get(NEXT).binding.relayAlive=false;
    await r.recover(22);f.setNow(270000);
    expect(await r.recover(22)).toMatchObject({status:'failed'});expect(f.launched).toEqual([NEXT]);
  });
  it('rejects recycled PIDs and malformed or unpaired success links',async()=>{
    const f=fixture();f.metadata.set(OLD,JSON.stringify({v:1,successor:NEXT,expectedThreadId:ID}));
    const r=new CodexRecovery(f.deps);expect(r.replacements()).toEqual([]);
    f.deps.resolve=()=>null;expect(await r.recover(11)).toMatchObject({status:'failed'});
    expect(f.launched).toEqual([]);
  });
  it('does not replace while a switch invalidated the previous exact identity',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);
    f.sessions.get(OLD).binding.threadId=null;expect(await r.recover(11)).toMatchObject({status:'failed'});
    expect(f.launched).toEqual([]);
  });
  it('keeps a confirmed successor sendable after the predecessor closes or switches',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);await r.recover(11);
    f.sessions.get(NEXT).binding={name:NEXT,threadId:ID,ready:true,relayAlive:true,binding:null};await r.recover(11);
    f.sessions.get(OLD).binding.threadId=OTHER;
    expect(r.connection(22)).toMatchObject({state:'ready'});expect(r.replacements()).toEqual([]);
    f.sessions.delete(OLD);expect(new CodexRecovery(f.deps).connection(22)).toMatchObject({state:'ready'});
  });
  it('reuses a failed allocation after backoff rather than making Retry inert',async()=>{
    const f=fixture();const launch=f.deps.launch;let calls=0;
    f.deps.launch=async(...args)=>++calls===1?{status:'failed',reason:'transient'}:launch(...args);
    const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);
    expect(await r.recover(11)).toMatchObject({status:'failed'});
    f.setNow(150000);expect(await new CodexRecovery(f.deps).recover(11)).toMatchObject({status:'recovering'});
    expect(f.launched).toEqual([NEXT]);expect(calls).toBe(2);
  });
  it('exposes the freshly verified candidate terminal without granting readiness',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);await r.recover(11);
    expect(r.connection(11)).toMatchObject({state:'recovering',recoveryTerminalPid:22});
    expect(r.connection(22)?.state).not.toBe('ready');
  });

  it('starts a fresh native grace period after same-TUI recovery settled',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);
    f.sessions.get(OLD).binding.ready=true;f.setNow(50000);await r.recover(11);
    f.sessions.get(OLD).binding.ready=false;f.setNow(130000);
    expect(await r.recover(11)).toMatchObject({status:'recovering'});expect(f.launched).toEqual([]);
  });
  it('settles recovered readiness and releases a closed predecessor on later sweeps',async()=>{
    const f=fixture();const r=new CodexRecovery(f.deps);await r.recover(11);
    f.sessions.get(OLD).binding.ready=true;expect(r.needsAdvance(11)).toBe(true);await r.recover(11);expect(r.needsAdvance(11)).toBe(false);
    f.sessions.get(OLD).binding.ready=false;f.setNow(130000);await r.recover(11);f.setNow(260000);await r.recover(11);
    f.sessions.get(NEXT).binding={name:NEXT,threadId:ID,ready:true,relayAlive:true,binding:null};await r.recover(11);
    f.sessions.delete(OLD);expect(r.needsAdvance(22)).toBe(true);await r.recover(22);
    expect(JSON.parse(f.metadata.get(NEXT)!)).toEqual({v:1});expect(r.connection(22)).toMatchObject({state:'ready'});
  });

  it('does not confirm or hide a replacement if prior input uncertainty cannot transfer',async()=>{
    const f=fixture();f.deps.transferInput=()=>false;const r=new CodexRecovery(f.deps);
    await r.recover(11);f.setNow(130000);await r.recover(11);
    f.sessions.get(NEXT).binding={name:NEXT,threadId:ID,ready:true,relayAlive:true,binding:null};
    expect(await r.recover(11)).toMatchObject({status:'failed'});expect(r.replacements()).toEqual([]);
    expect(r.connection(22)?.state).not.toBe('ready');
  });

});

describe('reverse candidate intent quarantine',()=>{
  it('does not admit a confirmed candidate until the reciprocal parent link persists',async()=>{
    const f=fixture();f.deps.names=()=>[...f.sessions.keys()];const r=new CodexRecovery(f.deps);
    await r.recover(11);f.setNow(130000);await r.recover(11);
    f.sessions.get(NEXT).binding={threadId:ID,ready:true,relayAlive:true};
    const write=f.deps.write;f.deps.write=(n,v)=>n===OLD&&JSON.parse(v).successor?false:write(n,v);
    expect(await r.recover(11)).toMatchObject({status:'failed'});
    expect(new CodexRecovery(f.deps).connection(22)?.state).not.toBe('ready');
    f.deps.write=write;expect(await new CodexRecovery(f.deps).recover(22)).toEqual({status:'ready',pid:22,sessionId:ID});
    expect(f.launched).toEqual([NEXT]);
  });
  it('quarantines a live candidate missing its own option across restart, then safely completes it',async()=>{
    const f=fixture();const originalLaunch=f.deps.launch;let writesFail=true;
    f.deps.names=()=>[...f.sessions.keys()];
    f.deps.launch=async(...args)=>{await originalLaunch(...args);f.metadata.delete(NEXT);
      f.sessions.get(NEXT).binding={name:NEXT,threadId:ID,ready:true,relayAlive:true,binding:null};
      return {status:'failed',reason:'option failed after live launch'};};
    const originalWrite=f.deps.write;f.deps.write=(n,v)=>n===NEXT&&writesFail?false:originalWrite(n,v);
    const transferred:string[]=[];f.deps.transferInput=(old,next,id)=>{transferred.push(`${old}:${next}:${id}`);return true;};
    f.deps.inputPending=pid=>pid===11;
    const r=new CodexRecovery(f.deps);await r.recover(11);f.setNow(130000);await r.recover(11);
    const restart=new CodexRecovery(f.deps);
    expect(restart.connection(22)).toMatchObject({inputPending:true});expect(restart.connection(22)?.state).not.toBe('ready');
    expect(restart.inputRefusal(22,ID)).toBe('codex_not_ready');
    writesFail=false;expect(await restart.recover(22)).toEqual({status:'ready',pid:22,sessionId:ID});
    expect(f.launched).toEqual([NEXT]);expect(transferred).toEqual([`${OLD}:${NEXT}:${ID}`]);
    expect(restart.replacements()).toEqual([{previousPid:11,pid:22,sessionId:ID}]);
  });
});

describe('candidate quarantine when fresh ownership inventory is unavailable',()=>{
  function candidate(){const f=fixture();f.sessions.set(NEXT,{pid:22,name:NEXT,cwd:'/repo',binding:{threadId:ID,ready:true,relayAlive:true}});
    f.metadata.set(OLD,JSON.stringify({v:1,candidate:NEXT,candidateSince:1000,expectedThreadId:ID}));return f;}
  it('does not admit a candidate when inventory fails or omits the owned current terminal',()=>{
    const f=candidate();f.deps.names=()=>[];const r=new CodexRecovery(f.deps);
    expect(r.connection(22)?.state).not.toBe('ready');expect(r.inputRefusal(22,ID)).toBe('codex_not_ready');
    f.deps.names=()=>{throw new Error('tmux unavailable');};expect(r.connection(22)?.state).not.toBe('ready');
  });
  it('retains matching parent intent when its process cannot be resolved',async()=>{
    const f=candidate();f.deps.names=()=>[OLD,NEXT];const resolve=f.deps.resolveName;
    f.deps.resolveName=n=>n===OLD?null:resolve(n);const r=new CodexRecovery(f.deps);
    expect(r.connection(22)?.state).not.toBe('ready');expect(r.inputRefusal(22,ID)).toBe('codex_not_ready');
    expect(await r.recover(22)).toMatchObject({status:'failed'});expect(f.launched).toEqual([]);
  });
});
