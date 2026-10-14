import { DeviceMobile } from '@phosphor-icons/react';
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import QRCode from 'qrcode';
import { parseLocalPreviewUrl, type PreviewOpenResult } from '../../core/preview.ts';
import { useCopy } from '../state/useCopy.ts';
import './LocalWebsiteLink.css';

export interface LocalWebsiteAccess { open(url: string): Promise<PreviewOpenResult>; mobile?: boolean; disabled?: boolean }
export const LocalWebsiteContext = createContext<LocalWebsiteAccess | null>(null);

function privateWebsite(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function WebsiteAction({ url, access }: { url: string; access: LocalWebsiteAccess }) {
  const [result, setResult] = useState<PreviewOpenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(''); const [qrError, setQrError] = useState('');
  const generation = useRef(0); const running = useRef(false);
  const { state: copyState, copy } = useCopy();
  const notice = useId();
  useEffect(() => {
    generation.current++; running.current = false; setResult(null); setBusy(false);
    return () => { generation.current++; };
  }, [access.open, url]);
  useEffect(() => {
    let alive = true; setQr(''); setQrError('');
    if (result?.ok && !access.mobile) {
      void QRCode.toDataURL(result.url, { errorCorrectionLevel: 'M', width: 200, margin: 4 }).then(
        value => { if (alive) setQr(value); },
        () => { if (alive) setQrError('Could not generate a QR code. Use Copy link instead.'); },
      );
    }
    return () => { alive = false; };
  }, [result, access.mobile]);
  async function open() {
    if (running.current || access.disabled || !parseLocalPreviewUrl(url)) return;
    const current = generation.current; running.current = true; setBusy(true); setResult(null);
    try {
      const next = await access.open(url);
      if (generation.current !== current) return;
      setResult(next.ok && !privateWebsite(next.url) ? { ok: false, message: 'Fleet returned an invalid private website address.' } : next);
    } catch (error) {
      if (generation.current === current) setResult({ ok: false, message: error instanceof Error ? error.message : 'Could not connect this website. Try again.' });
    } finally {
      if (generation.current === current) { running.current = false; setBusy(false); }
    }
  }
  return <span className="local-website-action">
    <button type="button" className="local-website-trigger" disabled={busy || access.disabled || !parseLocalPreviewUrl(url)} aria-describedby={notice} onClick={() => void open()}>
      {!access.mobile && <DeviceMobile size={16} aria-hidden="true" />}{access.mobile ? 'Open website' : 'Open on phone'}
    </button>
    <span id={notice} className="local-website-notice">Makes this site accessible to your Tailscale devices.</span>
    {busy && <span className="local-website-result" role="status">Connecting the website on your Mac…</span>}
    {result && <span className="local-website-result">
      {result.ok ? <>
        <span>Keep the development server running on your Mac.</span>
        <a href={result.url} target="_blank" rel="noopener noreferrer">Open website</a>
        <code>{result.url}</code>
        <button type="button" onClick={() => copy(result.url)}>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy link'}</button>
        {qr && <img src={qr} width="200" height="200" alt="Scan to open this website on your phone" />}
        {qrError && <span role="alert">{qrError}</span>}
      </> : <span role="alert">{result.message}</span>}
      <button type="button" className="local-website-dismiss" onClick={() => setResult(null)}>Dismiss</button>
    </span>}
  </span>;
}

/** Context changes update only the links, without reparsing the transcript Markdown. */
export function LocalWebsiteLink(props: ComponentProps<'a'>) {
  const access = useContext(LocalWebsiteContext);
  if (!access || !props.href || !parseLocalPreviewUrl(props.href)) return <a {...props} target="_blank" rel="noopener noreferrer" />;
  return <span className="local-website-link">
    {access.mobile ? <span>{props.children}</span> : <a {...props} target="_blank" rel="noopener noreferrer" />}
    <WebsiteAction url={props.href} access={access} />
  </span>;
}

export function LocalWebsiteInput() {
  const access = useContext(LocalWebsiteContext);
  const [url, setUrl] = useState('');
  const id = useId();
  if (!access) return null;
  return <div className="local-website-input"><label htmlFor={id}>Website address on your Mac</label>
    <input id={id} type="url" placeholder="http://localhost:3000" value={url} onChange={event => setUrl(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
    {url && !parseLocalPreviewUrl(url.trim()) && <span role="status">Use an http://localhost address with a development server port.</span>}
    <WebsiteAction url={url.trim()} access={access} />
  </div>;
}
