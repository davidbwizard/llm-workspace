import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPrefs, readAllPrefs, type PrefsDb } from '../../src/main/prefs.ts';
import { DEFAULT_NOTIFICATIONS, NOTIFICATION_PREF_KEY, type NotificationSession } from '../../src/core/notifications.ts';
const mocks = vi.hoisted(()=>({handlers:new Map<string,(...args:any[])=>any>(),shown:[] as any[]}));
vi.mock('electron',()=>({
  ipcMain:{handle:(name:string,handler:(...args:any[])=>any)=>mocks.handlers.set(name,handler)},
  Notification:class extends EventEmitter {
    static isSupported(){return true;}
    constructor(public options:unknown){super();mocks.shown.push(this);}
    show(){}
    close(){this.emit('close');}
  },
}));
import { registerNotifications } from '../../src/main/notifications.ts';

let db:PrefsDb;
beforeEach(()=>{db=openPrefs(':memory:');mocks.handlers.clear();mocks.shown=[];});
afterEach(()=>db.close());
function setup(){
  let sessions:NotificationSession[]=[{provider:'claude',sessionId:'one',activity:'working'}];
  const win={isDestroyed:()=>false,isFocused:()=>false,webContents:{mainFrame:{},send:vi.fn()}};
  const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};
  const open=vi.fn();
  const service=registerNotifications({db,window:()=>win as any,open,sessions:()=>sessions});
  const invoke=(name:string,...args:unknown[])=>mocks.handlers.get(`notifications:${name}`)!(event,...args);
  return {service,win,event,open,invoke,setSessions:(s:NotificationSession[])=>{sessions=s;}};
}
describe('native notification integration',()=>{
  it('persists validated preferences and refuses other frames',()=>{
    const {invoke,event}=setup();
    const prefs={...DEFAULT_NOTIFICATIONS,enabled:true};
    expect(invoke('set',prefs).preferences).toEqual(prefs);
    expect(JSON.parse(readAllPrefs(db)[NOTIFICATION_PREF_KEY]!)).toEqual(prefs);
    expect(()=>invoke('set',{...prefs,enabled:'true'})).toThrow('Invalid');
    expect(()=>mocks.handlers.get('notifications:set')!({...event,senderFrame:{}},prefs)).toThrow('unavailable');
  });
  it('opens a still-live session from a generic native alert and supports reload recovery',()=>{
    const {invoke,service,win,open}=setup();
    invoke('set',{...DEFAULT_NOTIFICATIONS,enabled:true});
    service.observe([{provider:'claude',sessionId:'one',activity:'working'}]);
    service.observe([{provider:'claude',sessionId:'one',activity:'waiting_input',name:'Secret'}]);
    expect(mocks.shown[0].options).toEqual({title:'Fleet needs you',body:'A session is waiting for your input.'});
    mocks.shown[0].emit('click');
    expect(open).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('notifications:open',expect.objectContaining({provider:'claude',sessionId:'one'}));
    expect(invoke('take-open')).toMatchObject({provider:'claude',sessionId:'one'});
    expect(invoke('take-open')).toBeNull();
  });
  it('does not navigate to an ended identity and reports delivery failure',()=>{
    const {invoke,service,win,setSessions}=setup();
    invoke('set',{...DEFAULT_NOTIFICATIONS,enabled:true});
    service.observe([{provider:'claude',sessionId:'one',activity:'working'}]);
    service.observe([{provider:'claude',sessionId:'one',activity:'waiting_permission'}]);
    setSessions([{provider:'claude',sessionId:'replacement',activity:'idle'}]);
    mocks.shown[0].emit('click');
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(invoke('take-open')).toBeNull();
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    mocks.shown[0].emit('failed',{},'OS refused');
    expect(invoke('get').error).toContain('delivery failed');
    log.mockRestore();
  });
  it('rate limits test notifications and closes retained native handles',()=>{
    const {invoke,service}=setup();
    expect(()=>invoke('test')).toThrow('Enable');
    invoke('set',{...DEFAULT_NOTIFICATIONS,enabled:true});
    invoke('test');
    expect(()=>invoke('test')).toThrow('Wait');
    const close=vi.spyOn(mocks.shown[0],'close');service.dispose();expect(close).toHaveBeenCalledOnce();
  });
});
