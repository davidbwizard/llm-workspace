import { useEffect, useId, useRef, useState } from 'react';
import { COPY_LABEL, useCopy } from '../state/useCopy.ts';

export function MobileSessionMenu({ pid, sessionId, canClose, onClose, onWebsites }: {
  pid: number; sessionId: string | null; canClose: boolean; onClose(): void; onWebsites(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null); const id = useId(); const copied = useCopy();
  function dismiss() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="mobile-menu-anchor" ref={root} onBlur={event => {
    // Safari taps can blur to null before click; outside pointerdown still dismisses the menu.
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(); }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }}>
    <button type="button" ref={trigger} aria-label="Session actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>…</button>
    {open && <div id={id} ref={menu} className="mobile-session-menu" role="menu" aria-label="Session actions">
      <button type="button" role="menuitem" disabled={!canClose} onClick={() => { dismiss(); onClose(); }}>Close session</button>
      <button type="button" role="menuitem" onClick={() => { dismiss(); onWebsites(); }}>Websites</button>
      <button type="button" role="menuitem" onClick={() => copied.copy(sessionId === null ? `pid ${pid}` : `pid ${pid} session ${sessionId}`)}>
        {copied.state === 'idle' ? (sessionId === null ? 'Copy PID' : 'Copy session ID and PID') : COPY_LABEL[copied.state]}
      </button>
      <span className="visually-hidden" role="status">{copied.state === 'idle' ? '' : COPY_LABEL[copied.state]}</span>
    </div>}
  </div>;
}
