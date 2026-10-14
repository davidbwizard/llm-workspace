import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationSettings } from '../../src/renderer/components/NotificationSettings.tsx';
import { DEFAULT_NOTIFICATIONS } from '../../src/core/notifications.ts';
afterEach(()=>{cleanup();delete window.fleet;});
describe('notification settings',()=>{
  it('saves opt-in choices, keeps previews private and mutes a session',async()=>{
    const set=vi.fn(async preferences=>({preferences,supported:true,error:null}));
    window.fleet={notificationsGet:async()=>({preferences:DEFAULT_NOTIFICATIONS,supported:true,error:null}),notificationsSet:set} as any;
    render(<NotificationSettings session={{provider:'claude',sessionId:'one'}}/>);
    fireEvent.click(screen.getByRole('button',{name:'Notifications'}));
    const enabled=await screen.findByLabelText('Enable desktop notifications');
    expect((enabled as HTMLInputElement).checked).toBe(false);
    fireEvent.click(enabled);
    await waitFor(()=>expect(set).toHaveBeenCalledWith({...DEFAULT_NOTIFICATIONS,enabled:true}));
    await waitFor(()=>expect((screen.getByRole('button',{name:'Mute this session'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'Mute this session'}));
    await waitFor(()=>expect(set).toHaveBeenLastCalledWith({...DEFAULT_NOTIFICATIONS,enabled:true,muted:['["claude","one"]']}));
    expect(screen.getByText(/Notification text stays generic/)).toBeTruthy();
  });
  it('shows a failed save without pretending the setting changed',async()=>{
    window.fleet={notificationsGet:async()=>({preferences:DEFAULT_NOTIFICATIONS,supported:true,error:null}),notificationsSet:async()=>{throw new Error('Disk unavailable');}} as any;
    render(<NotificationSettings/>);fireEvent.click(screen.getByRole('button',{name:'Notifications'}));
    fireEvent.click(await screen.findByLabelText('Enable desktop notifications'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Disk unavailable');
    expect((screen.getByLabelText('Enable desktop notifications') as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button',{name:'Notifications'}));
  });
});
