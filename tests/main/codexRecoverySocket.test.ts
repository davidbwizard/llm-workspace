import { mkdtempSync, mkdirSync, chmodSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,it,expect } from 'vitest';
import { validateRelaySocketNode } from '../../src/main/codexRecoveryRuntime.ts';
describe('private relay socket validation',()=>{
  const stat=(socket=true,uid=42,mode=0o600,symlink=false)=>({isSocket:()=>socket,isSymbolicLink:()=>symlink,isDirectory:()=>!socket,uid,mode});
  it('accepts only an owned private directory and owned socket inode',()=>{
    expect(()=>validateRelaySocketNode(stat() as any,42,false)).not.toThrow();
    expect(()=>validateRelaySocketNode(stat(false,42,0o700) as any,42,true)).not.toThrow();
    for(const s of [stat(false),stat(true,99),stat(true,42,0o666),stat(true,42,0o600,true)])
      expect(()=>validateRelaySocketNode(s as any,42,false)).toThrow();
    expect(()=>validateRelaySocketNode(stat(false,42,0o777) as any,42,true)).toThrow();
  });
  it('accepts an actual owned0755 parent around a private0700 relay directory',()=>{
    const root=mkdtempSync(join(tmpdir(),'fleet-private-directory-'));
    try {
      chmodSync(root,0o755);const child=join(root,'codex-relays');mkdirSync(child,{mode:0o700});
      const uid=process.getuid!();
      expect(()=>validateRelaySocketNode(lstatSync(root),uid,true,false)).not.toThrow();
      expect(()=>validateRelaySocketNode(lstatSync(child),uid,true)).not.toThrow();
      chmodSync(root,0o777);expect(()=>validateRelaySocketNode(lstatSync(root),uid,true,false)).toThrow();
    } finally {rmSync(root,{recursive:true});}
  });

});
