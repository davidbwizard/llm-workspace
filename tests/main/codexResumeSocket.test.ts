import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { launchCodexResume, startCodexRelay } from '../../src/main/launch.ts';
import { codexRelaySocket } from '../../src/main/codexRelayControl.ts';
const NAME='llmws-codex-relay-aaaaaaaa', OLD='llmws-codex-relay-bbbbbbbb';
const ID='01a0da03-b7a1-7542-a9b9-e325e92c221f';
function fixture() {
  // macOS Unix socket paths must fit104 bytes including this directory tree.
  const home=mkdtempSync('/tmp/fr-');
  mkdirSync(join(home,'.llm-workspace','codex-relays'),{recursive:true,mode:0o700});
  const socket=codexRelaySocket(NAME,home);
  const relay=vi.fn();const exec=vi.fn((_args:string[])=>({ok:true as const,stdout:''}));
  const deps={socketHome:home,startRelay:relay,waitRelay:async()=>true,panePid:()=>42,exec};
  return {home,socket,relay,exec,deps};
}
it('removes an isolated stale socket before recreating its relay and resumes the same exact UUID',async()=>{
  const f=fixture();
  try {
    await promisify(execFile)(process.execPath,['--input-type=module','-e',
      "import { createServer } from 'node:net'; createServer().listen(process.argv[1], () => process.exit(0));",f.socket]);
    chmodSync(f.socket,0o600);expect(lstatSync(f.socket).isSocket()).toBe(true);
    f.relay.mockImplementation(()=>{expect(existsSync(f.socket)).toBe(false);});
    expect(await launchCodexResume('/repo',ID,NAME,OLD,100,30,f.deps)).toEqual({status:'launched',pid:42});
    expect(f.relay).toHaveBeenCalledTimes(1);
    expect(f.exec.mock.calls[0]![0].at(-1)).toContain(`'${ID}'`);
    expect(f.exec.mock.calls[0]![0].at(-1)).toContain(`'unix://${f.socket}'`);
  } finally {rmSync(f.home,{recursive:true,force:true});}
});
it('preserves an unsafe existing endpoint and never starts either replacement process',async()=>{
  const f=fixture();
  try {
    writeFileSync(f.socket,'keep this',{mode:0o600});
    expect(await launchCodexResume('/repo',ID,NAME,OLD,100,30,f.deps)).toMatchObject({status:'failed',reason:expect.stringContaining('unsafe ownership or permissions')});
    expect(existsSync(f.socket)).toBe(true);expect(f.relay).not.toHaveBeenCalled();expect(f.exec).not.toHaveBeenCalled();
  } finally {rmSync(f.home,{recursive:true,force:true});}
});
it('preserves a symlink endpoint and its target',async()=>{
  const f=fixture();
  try {
    const target=join(f.home,'target');writeFileSync(target,'keep');symlinkSync(target,f.socket);
    expect(await launchCodexResume('/repo',ID,NAME,OLD,100,30,f.deps)).toMatchObject({status:'failed'});
    expect(lstatSync(f.socket).isSymbolicLink()).toBe(true);expect(existsSync(target)).toBe(true);
    expect(f.relay).not.toHaveBeenCalled();
  } finally {rmSync(f.home,{recursive:true,force:true});}
});
it('preserves a live existing listener and does not create a competing relay',async()=>{
  const f=fixture();const server=createServer(socket=>socket.destroy());
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(f.socket,resolve);});
    chmodSync(f.socket,0o600);
    expect(await launchCodexResume('/repo',ID,NAME,OLD,100,30,f.deps)).toMatchObject({status:'failed',reason:expect.stringContaining('live process already owns')});
    expect(existsSync(f.socket)).toBe(true);expect(server.listening).toBe(true);expect(f.relay).not.toHaveBeenCalled();
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(f.home,{recursive:true,force:true});}
});
it('allows a fresh endpoint whose relay directory does not exist yet',async()=>{
  const f=fixture();
  try {
    rmSync(join(f.home,'.llm-workspace'),{recursive:true});
    await startCodexRelay(NAME,'/repo',f.deps);
    expect(f.relay).toHaveBeenCalledTimes(1);expect(existsSync(f.socket)).toBe(false);
  } finally {rmSync(f.home,{recursive:true,force:true});}
});
it('reuses an existing relay session without probing it before the native TUI starts',async()=>{
  const f=fixture();
  try {
    expect(await launchCodexResume('/repo',ID,NAME,OLD,100,30,{...f.deps,relayExists:()=>true})).toEqual({status:'launched',pid:42});
    expect(f.relay).not.toHaveBeenCalled();
  } finally {rmSync(f.home,{recursive:true,force:true});}
});
