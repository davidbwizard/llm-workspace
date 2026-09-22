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
 *  §5's rule holds and is why the chip never NAMES a mode it does not
 *  know: "claiming Manual on a session that is actually on Auto is the
 *  worst failure this feature has." What it does instead of vanishing
 *  (2026-09-22) is stay on screen, disabled, labelled "Mode", with the
 *  reason in its title and aria-label. The common case is a session
 *  started in iTerm or VS Code: no pane, so no mode -- and a control that
 *  is simply absent teaches nobody why. Same treatment missing
 *  dependencies already get: disabled with a reason, not hidden.
 *
 *  The one case that still draws nothing is `state === null`: the pane
 *  before its first live push, where nothing has been established yet.
 *  `.convfoot:empty` collapses the row until it lands. */

/** What a refusal from main is shown as. Every reason setModeFor can
 *  return has a line: an unmapped one would show nothing at all, which is
 *  the silent failure this app's other refusal tables exist to avoid. */
const REFUSAL_TEXT: Record<string, string> = {
  invalid_pid: 'That session is not running.',
  not_tmux: 'This app did not start that session, so it cannot switch its mode.',
  session_gone: 'That session has ended.',
  invalid_mode: 'That mode does not exist for this session.',
  prompt_open: 'Answer the prompt above first.',
  unreadable: 'Could not read the mode from the session.',
  unconfirmed: 'The session did not switch. Change it in the Terminal instead.',
  exhausted: 'The session did not switch. Change it in the Terminal instead.',
  in_flight: 'Already switching this session.',
};

/** Why the chip is disabled, as a title/aria hint (§4.1: "The chip is
 *  disabled with a reason"). Each line has to make sense to a person
 *  reading it in a tooltip, so none of them names an internal state -- the
 *  key is main's word, the sentence is not. */
const BLOCKED_TEXT: Record<NonNullable<SessionMode['blocked']>, string> = {
  prompt_open: 'Answer the prompt above first',
  not_tmux: 'This app did not start this session, so its mode cannot be read or changed',
  session_gone: 'That session has ended',
  unreadable: 'Could not read the mode from the session',
};

/** The label on a chip with no mode to name. NOT a mode name: "Auto" on a
 *  session nobody has read is exactly the lie §5 exists to prevent. "Mode"
 *  names the control without asserting any state -- an em dash reads as a
 *  value ("the mode is --") and announces as nothing to a screen reader,
 *  and the reason itself is a sentence, too long for a pill sitting beside
 *  "Enter to send". The reason goes in the title and the aria-label, where
 *  there is room for it. */
const NO_MODE_LABEL = 'Mode';

export function ModeChip({ pid, state, onOpenTerminal }: {
  pid: number | null;
  /** Straight off the session:live push, or null before the first one
   *  lands (and for a pid whose provider main cannot tell -- there is no
   *  menu, and no label, to draw without it). */
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

  // Nothing has been established about this pane yet -- see the note at
  // the top of the file on why this one case draws nothing at all.
  if (state === null) return null;

  const provider = state.provider;
  const items = modeMenuFor(provider);
  // Main only ever sends a null mode with a reason beside it, but the chip
  // does not lean on that: an unknown mode with no reason still says the
  // one thing that is certainly true.
  const reason = blocked !== null ? BLOCKED_TEXT[blocked]
    : mode === null ? BLOCKED_TEXT.unreadable
      : null;
  // A null mode disables the chip through `reason` above, and must: the
  // menu switches FROM the mode the pane reports, and main refuses a press
  // it could not read a mode for (`unreadable`), so an openable chip here
  // would be a control that could only fail.
  const disabled = reason !== null || sending || pid === null;
  const label = mode === null ? NO_MODE_LABEL : labelFor(provider, mode);

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
      {/* `unknown` is a fifth colour slot, not a missing one: the pill's
          --m/--m-soft have to resolve to something or `color:var(--m)` is
          invalid and the chip loses its colour entirely. */}
      <span className="modechip" data-mode={mode === null ? 'unknown' : toneFor(mode)} ref={chipRef}>
        <button
          type="button"
          ref={buttonRef}
          aria-haspopup="menu"
          aria-expanded={open}
          // The reason, not the label, for a chip with no mode: "Permission
          // mode: Mode" would tell a screen-reader user nothing at all.
          aria-label={mode === null
            ? `Permission mode unavailable: ${reason}`
            : `Permission mode: ${label}`}
          disabled={disabled}
          title={reason ?? undefined}
          onClick={() => { setMessage(null); setOpen(o => !o); }}
        >
          <span className="dot" aria-hidden="true" />
          <span className="label">{label}</span>
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
