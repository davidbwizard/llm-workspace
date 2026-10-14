import { useEffect, useRef, useState } from 'react';
import { Bell, BellSlash, X } from '@phosphor-icons/react';
import { sessionNotificationKey, type NotificationPreferences, type NotificationStatus } from '../../core/notifications.ts';
import './NotificationSettings.css';

export function NotificationSettings({session}: {session?:{provider:string;sessionId:string|null}}) {
  const [open,setOpen] = useState(false);
  const [status,setStatus] = useState<NotificationStatus|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [tested,setTested] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const key = session ? sessionNotificationKey(session) : null;
  useEffect(()=>{
    if (!open) return;
    let active = true;
    setError(null);
    window.fleet?.notificationsGet?.().then(s=>{if(active) setStatus(s);}, e=>{if(active) setError(String(e));});
    panel.current?.focus();
    return ()=>{active=false;};
  },[open]);
  if (!window.fleet?.notificationsGet) return null;
  function close(){setOpen(false);button.current?.focus();}
  async function save(next: NotificationPreferences) {
    setBusy(true);setError(null);
    try { const updated=await window.fleet?.notificationsSet?.(next); if (!updated) throw new Error('Could not reach Fleet.');setStatus(updated); }
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  const muted=!!key && !!status?.preferences.muted.includes(key);
  return <div className="notification-settings">
    <button ref={button} type="button" className="notification-button" aria-label="Notifications" aria-expanded={open} onClick={()=>setOpen(!open)}><Bell size={18}/></button>
    {open && <div ref={panel} className="notification-panel" role="dialog" aria-label="Notifications" tabIndex={-1} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}}>
      <div className="notification-heading"><h2>Notifications</h2><button type="button" aria-label="Close notifications" onClick={close}><X size={16}/></button></div>
      <p>Alerts on this Mac. Fleet must be running.</p>
      {!status && !error && <p>Loading…</p>}
      {status && <>
        {!status.supported && <p role="status">Notifications are unavailable on this computer.</p>}
        {([['enabled','Enable desktop notifications'],['needsYou','A session needs a decision'],['finished','A session finishes working'],['onlyAway','Only when Fleet is in the background'],['previews','Show session names and reply previews']] as const).map(([field,label])=><label key={field}>
          <input type="checkbox" checked={status.preferences[field]} disabled={busy || !status.supported || (field!=='enabled'&&!status.preferences.enabled)} onChange={e=>void save({...status.preferences,[field]:e.target.checked})}/>{label}
        </label>)}
        <p className="notification-privacy">{status.preferences.previews?'Names and reply text may appear on your lock screen.':'Notification text stays generic. Session names and replies stay private.'}</p>
        {key && <button type="button" disabled={busy} onClick={()=>void save({...status.preferences,muted:muted?status.preferences.muted.filter(k=>k!==key):[...status.preferences.muted,key]})}>{muted?<Bell size={16}/>:<BellSlash size={16}/>} {muted?'Unmute this session':'Mute this session'}</button>}
        <button type="button" disabled={busy||!status.supported||!status.preferences.enabled} onClick={async()=>{
          setBusy(true);setError(null);setTested(false);
          try{const s=await window.fleet?.notificationsTest?.();if(!s)throw new Error('Could not reach Fleet.');setStatus(s);setTested(true);}
          catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
        }}>Send test notification</button>
        {tested && <p role="status">Test requested. If it does not appear, allow Fleet in macOS System Settings → Notifications.</p>}
      </>}
      {(error||status?.error) && <p role="alert">{error||status?.error}</p>}
    </div>}
  </div>;
}
