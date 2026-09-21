// Aliased: an unaliased `KeyboardEvent` here would shadow the DOM one the
// document listener below is typed against, and the two are not the same
// type (React's is a synthetic wrapper).
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
// Type-only and value imports from src/core/**, which carries no node
// import (unlike src/main/**) -- the same rule ConversationView.tsx's
// MAX_REPLY_CHARS comment sets out for what this folder may reach.
import { modeMenuFor, labelFor, toneFor, type Mode } from '../../core/mode.ts';
import type { SessionMode } from '../state/useSessionLive.ts';
import './ModeChip.css';

/** The permission-mode chip. Spec: docs/superpowers/specs/
 *  2026-09-21-mode-switcher-design.md §2 (layout C) and §4.
 *
 *  Closed: a coloured dot, the mode name, a caret. Open: that provider's
 *  own modes, each with a one-line description and the current one marked.
 *  The menu is built PER PROVIDER and the two never share a list (§3.2):
 *  Claude has four modes, Codex two plus a link out to the terminal.
 *
 *  The chip renders nothing at all when the mode is unknown. §5: "A mode
 *  the reader cannot identify is reported as unknown. The chip then shows
 *  nothing rather than a guess: claiming Manual on a session that is
 *  actually on Auto is the worst failure this feature has." There is
 *  nothing to switch FROM either -- main refuses the press for the same
 *  reason (`unreadable`) -- so a chip here would be a control that could
 *  only fail. */

/** What a refusal from main is shown as. Every reason setModeFor can
 *  return has a line: an unmapped one would show nothing at all, which is
 *  the silent failure this app's other refusal tables exist to avoid. */
const REFUSAL_TEXT: Record<string, string> = {
  invalid_pid: 'That session is not running.',
  not_tmux: 'This app did not start that session, so it cannot switch its mode.',
  session_gone: 'That session has ended.',
  invalid_mode: 'That mode does not exist for this session.',
  busy: 'Not while the session is working.',
  prompt_open: 'Answer the prompt above first.',
  unreadable: 'Could not read the mode from the session.',
  unconfirmed: 'The session did not switch. Change it in the Terminal instead.',
  exhausted: 'The session did not switch. Change it in the Terminal instead.',
  in_flight: 'Already switching this session.',
};

/** Why the chip is disabled, as a title/aria hint (§4.1: "The chip is
 *  disabled with a reason while the session is working"). */
const BLOCKED_TEXT: Record<NonNullable<SessionMode['blocked']>, string> = {
  busy: 'Not while the session is working',
  prompt_open: 'Answer the prompt above first',
  session_gone: 'That session has ended',
  unreadable: 'Could not read the mode from the session',
};

export function ModeChip({ pid, state, onOpenTerminal }: {
  pid: number | null;
  /** Straight off the session:live push, or null when there is no chip to
   *  show -- a session this app did not launch has no pane to read. */
  state: SessionMode | null;
  /** The Codex menu's Permissions… row, and nothing else, uses this: it
   *  ONLY opens the session in the terminal. The app does not type
   *  `/permissions` and does not drive that menu (§3.2). */
  onOpenTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const mode = state?.mode ?? null;
  const blocked = state?.blocked ?? null;

  // Escape closes and returns focus to the chip; a click anywhere outside
  // closes too (§2). Both are only bound while the menu is actually open,
  // so a pane full of closed chips costs no document listeners.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onClick = (e: MouseEvent) => {
      if (chipRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  // The mockup focuses the menu's first row on open; this does the same,
  // after the commit that mounted it.
  useEffect(() => {
    if (open) menuRef.current?.querySelector('button')?.focus();
  }, [open]);

  // §5's rule, and the reason this comes before the disabled check below:
  // a chip with no mode would have to show a placeholder, and there is no
  // honest placeholder for "we do not know".
  if (state === null || mode === null) return null;

  const provider = state.provider;
  const items = modeMenuFor(provider);
  const disabled = blocked !== null || sending || pid === null;

  async function pick(next: Mode): Promise<void> {
    setOpen(false);
    buttonRef.current?.focus();
    if (pid === null) return;
    setMessage(null);
    setSending(true);
    try {
      const r = await window.fleet?.setMode(pid, next);
      if (!r) { setMessage('Could not reach the app.'); return; }
      // 'set' and 'unchanged' are both successes and both say nothing: the
      // chip itself updates from the next session:live push, which is the
      // only source that reflects the PANE rather than this click.
      if (r.status === 'refused') setMessage(REFUSAL_TEXT[r.reason] ?? 'The mode did not change.');
    } catch (err) {
      // A rejected invoke means the mode did NOT change, and the one thing
      // that must never happen is the chip looking like it did.
      console.error('session:mode:set failed:', err);
      setMessage('Could not reach the app.');
    } finally {
      setSending(false);
    }
  }

  /** Arrow keys walk the open menu. Not in the mockup, which is a static
   *  page -- but a `role="menu"` that cannot be arrowed is a real defect,
   *  and the rows are already focusable buttons, so this is only the
   *  movement. */
  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...(menuRef.current?.querySelectorAll('button') ?? [])];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at === -1 ? 0 : (at + step + rows.length) % rows.length;
    rows[next]?.focus();
  }

  return (
    <>
      <span className="modechip" data-mode={toneFor(mode)} ref={chipRef}>
        <button
          type="button"
          ref={buttonRef}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Permission mode: ${labelFor(provider, mode)}`}
          disabled={disabled}
          title={blocked ? BLOCKED_TEXT[blocked] : undefined}
          onClick={() => { setMessage(null); setOpen(o => !o); }}
        >
          <span className="dot" aria-hidden="true" />
          <span className="label">{labelFor(provider, mode)}</span>
          {/* An SVG, not the text glyph the mockup used. U+25B2 is not in
              IBM Plex Mono, so macOS substitutes some other font for that
              one character -- a different shape at a different size than
              the 9px this rule asks for, which is what David saw. Every
              other mark in this app is drawn (StatusIcon.tsx, Icon.tsx)
              for exactly this reason: a glyph the font does not have is
              not a glyph you have chosen. */}
          <svg className="caret" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 5 5 1l4 4" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="modemenu" role="menu" aria-label="Permission mode" ref={menuRef} onKeyDown={onMenuKeyDown}>
            {items.map(item => (item.kind === 'mode' ? (
              <button
                key={item.mode}
                type="button"
                role="menuitemradio"
                aria-checked={item.mode === mode}
                onClick={() => void pick(item.mode)}
              >
                <i data-tone={toneFor(item.mode)} aria-hidden="true" />
                <span>{item.label}</span>
                <small>{item.description}</small>
              </button>
            ) : (
              // Not a mode and not a radio: it changes nothing here, it
              // opens the terminal so the person can run /permissions
              // themselves (§3.2).
              <button
                key="permissions"
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onOpenTerminal(); }}
              >
                <i data-tone="none" aria-hidden="true" />
                <span>{item.label}</span>
                <small>{item.description}</small>
              </button>
            )))}
          </div>
        )}
      </span>
      {message !== null && <p className="modemsg" role="status">{message}</p>}
    </>
  );
}
