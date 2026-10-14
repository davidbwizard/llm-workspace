import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { RemoteStatus } from '../../main/remote/lifecycle.ts';
import type { RemoteConfig } from '../../main/remote/config.ts';
import './RemoteSettings.css';
export function RemoteSettings() {
  const [status, setStatus] = useState<RemoteStatus | null>(null); const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [qr, setQr] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.fleet?.remoteGet?.().then(result => { if (alive) { setStatus(result); setConfig(result.config); } }, e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true; setQr('');
    if (status?.state === 'ready' && status.config.enabled) {
      void QRCode.toDataURL(status.config.origin, { errorCorrectionLevel: 'M', width: 240, margin: 4 }).then(value => { if (alive) setQr(value); }, () => { if (alive) setError('Could not generate the QR code. Use the address below.'); });
    }
    return () => { alive = false; };
  }, [status]);
  async function save(enabled: boolean) {
    if (!config || !window.fleet?.remoteConfigure) return;
    setBusy(true); setError('');
    try { const next = await window.fleet.remoteConfigure({ ...config, enabled }); setStatus(next); setConfig(next.config); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save remote access settings.'); } finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setError('');
    try { const next = await window.fleet?.remoteDisable?.(); if (next) { setStatus(next); setConfig(next.config); } }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  if (!config) return <section className="settingssection"><h3 className="settingssectitle">Remote access</h3><p>{error || 'Loading remote settings…'}</p></section>;
  const change = (patch: Partial<RemoteConfig>) => setConfig({ ...config, ...patch });
  return <section className="settingssection remote-settings"><h3 className="settingssectitle">Remote access</h3>
    <p className="settingshelp">Pick up the same sessions on your phone or tablet. Keep this Mac awake, Fleet running, and both devices connected to Tailscale.</p>
    <p role="status">{status?.state === 'ready' ? 'Local service running — Tailscale Serve must be configured below.' : status?.state === 'disabled' ? 'Remote access is off.' : status?.state === 'starting' ? 'Starting…' : 'Remote access could not start.'}</p>
    {(error || status?.error) && <p className="settingserror" role="alert">{error || status?.error}</p>}
    <fieldset disabled={busy}><label>Private Fleet address<input type="url" placeholder="https://your-mac.your-tailnet.ts.net" value={config.origin} onChange={e => change({ origin: e.target.value })} /></label>
    <label>Your Tailscale login<input type="text" autoComplete="off" placeholder="you@example.com" value={config.login} onChange={e => change({ login: e.target.value })} /></label>
    <label>Local Fleet port<input type="number" min="1024" max="65535" value={config.port} onChange={e => change({ port: Number(e.target.value) })} /></label>
    <div className="remote-settings-actions"><button type="button" onClick={() => void save(true)}>{status?.config.enabled ? 'Save and restart remote access' : 'Enable remote access'}</button>{status?.config.enabled && <button type="button" onClick={() => void disable()}>Disable remote access</button>}</div>
    <details><summary>Project previews</summary><p className="settingshelp">Use Open on phone beside a localhost link to connect a website automatically. Each website needs a running development server. Manual previews need a separate private HTTPS port and Serve mapping.</p>
      {config.previews.map((p, index) => <div className="remote-preview" key={p.id}>{(['label', 'project', 'localPort', 'url'] as const).map(key => <label key={key}>{({ label: 'Name', project: 'Project folder', localPort: 'Development server port', url: 'Private preview address' })[key]}<input type={key === 'localPort' ? 'number' : 'text'} value={p[key]} readOnly={p.managed && key !== 'label'} onChange={e => change({ previews: config.previews.map((q, i) => i === index ? { ...q, [key]: key === 'localPort' ? Number(e.target.value) : e.target.value } : q) })} /></label>)}{p.managed && <p className="settingshelp">Managed by Fleet. Removing this preview and saving closes its route. To use another address, connect a new localhost link.</p>}<button type="button" onClick={() => change({ previews: config.previews.filter((_, i) => i !== index) })}>Remove preview</button></div>)}
      <button type="button" onClick={() => change({ previews: [...config.previews, { id: crypto.randomUUID(), label: '', project: '', localPort: 3000, url: '' }] })}>Add preview</button><p className="settingshelp">Save remote access settings to apply preview changes.</p>
    </details></fieldset>
    {status?.state === 'ready' && <div className="remote-pairing">{qr && <img src={qr} width="240" height="240" alt="Scan to open private Fleet" />}<div><p>Scan on your phone or tablet</p><p className="settingshelp">Connect Tailscale first. The QR contains only this private address.</p><code>{status.config.origin}</code><button type="button" onClick={() => { void navigator.clipboard.writeText(status.config.origin).catch(() => setError('Could not copy. Select the address to copy it.')); }}>Copy address</button></div></div>}
    {status?.config.origin && <details><summary>Tailscale setup on this Mac</summary><p className="settingshelp">Inspect existing mappings first. Use Serve, which is private to your tailnet. Restrict your tailnet policy to your own devices; Fleet also checks your login. These commands are shown for you to run.</p><pre>{`tailscale serve status\ntailscale serve --bg --https=${new URL(status.config.origin).port || '443'} http://127.0.0.1:${status.config.port}`}{status.config.previews.map(p => `\ntailscale serve --bg --https=${new URL(p.url).port || '443'} http://127.0.0.1:${p.managed ? (status.config.port === 65535 ? 65534 : status.config.port + 1) : p.localPort}`).join('')}</pre></details>}
  </section>;
}
