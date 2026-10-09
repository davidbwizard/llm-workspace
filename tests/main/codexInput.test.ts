import { describe,it,expect } from 'vitest';
import { CodexInput } from '../../src/main/codexInput.ts';
const ID='01a0da03-b7a1-7542-a9b9-e325e92c221f',NAME='llmws-codex-relay-aaaaaaaa',NEXT='llmws-codex-relay-bbbbbbbb';
function fixture(){
  const marker=new Map<string,string>();
  const sessions=new Map<string,any>([[NAME,{pid:11,name:NAME,binding:{threadId:ID}}],[NEXT,{pid:22,name:NEXT,binding:{threadId:ID}}]]);
  const deps={resolve:(pid:number)=>[...sessions.values()].find(s=>s.pid===pid)??null,resolveName:(name:string)=>sessions.get(name)??null,
    read:(name:string)=>marker.get(name)??null,write:(name:string,value:string)=>{marker.set(name,value);return true;},
    related:()=>[NAME,NEXT]};
  return {marker,sessions,deps,input:new CodexInput(deps)};
}
describe('durable native input uncertainty',()=>{
  it('preserves pending input across app restart until explicit exact-thread acknowledgement',()=>{
    const f=fixture();expect(f.input.begin(11,ID)).toBe(true);
    expect(new CodexInput(f.deps).pending(11)).toBe(true);
    expect(f.input.clear(11,'wrong')).toBe(false);expect(f.input.pending(11)).toBe(true);
    expect(f.input.clear(11,ID)).toBe(true);expect(f.input.pending(11)).toBe(false);
  });
  it('carries uncertainty forward before confirming a replacement and retains it if old closes',()=>{
    const f=fixture();f.input.begin(11,ID);
    expect(f.input.transfer(NAME,NEXT,ID)).toBe(true);f.sessions.delete(NAME);
    expect(new CodexInput(f.deps).pending(22)).toBe(true);
    expect(f.input.clear(22,ID)).toBe(true);expect(f.input.pending(22)).toBe(false);
  });
  it('fails before native input when tracking cannot persist, and never clears another thread',()=>{
    const f=fixture();f.deps.write=()=>false;expect(f.input.begin(11,ID)).toBe(false);
    expect(f.input.clear(11,ID)).toBe(false);expect(f.input.begin(11,'bad')).toBe(false);
  });
});
