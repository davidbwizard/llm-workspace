import { useEffect, useRef } from 'react';
import {
  APPEARANCES, COMPACT_CARDS, MESSAGE_STYLES, TEXT_SIZES, setSettings, useSettings,
  type Appearance, type CompactCards, type MessageStyle, type TextSize,
} from '../state/settings.ts';
import './SettingsModal.css';

/** Human wording for each stored value. Kept beside the store's own allowed
 *  sets so adding a value without labelling it is a compile error, not a
 *  blank option. */
const APPEARANCE_LABEL: Record<Appearance, string> = {
  system: 'System', light: 'Light', dark: 'Dark',
};
const MESSAGE_STYLE_LABEL: Record<MessageStyle, string> = {
  a: 'A -- a rule down the agent\'s replies',
  c: 'C -- your messages in a bubble on the right',
};
const COMPACT_LABEL: Record<CompactCards, string> = {
  off: 'Off', sidebar: 'Sidebar only', fleet: 'Fleet only', both: 'Both',
};

/** The class that carries the background scroll lock. On the root element,
 *  not on body: this app's scrolling lives in .mainpane, .conv and
 *  .railcards, none of which body's own overflow reaches (see
 *  SettingsModal.css). */
const LOCK_CLASS = 'modal-open';

/** A native <dialog>, not a hand-rolled overlay: it supplies the top layer,
 *  the focus trap and the inert background for free, and this renderer has
 *  no focus-trap infrastructure to borrow (ReplyPopover is an inline
 *  popover, not a model for this).
 *
 *  Focus returns to the gear on close -- LaunchBar owns that, since it owns
 *  the button. */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettings();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (el === null) return;
    // jsdom 30 -- this project's test environment -- implements <dialog> as
    // an element but NOT showModal/close: both read undefined, verified
    // directly. Chromium has both. Falling back to the `open` attribute
    // keeps the same component renderable and assertable under test instead
    // of throwing at mount, and costs nothing in the real app.
    if (open) {
      if (typeof el.showModal === 'function') { if (!el.open) el.showModal(); }
      else el.setAttribute('open', '');
    } else {
      if (typeof el.close === 'function') { if (el.open) el.close(); }
      else el.removeAttribute('open');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.documentElement.classList.add(LOCK_CLASS);
    // Removed on close AND on unmount: a modal open when its owner
    // unmounts would otherwise leave the whole app unscrollable with
    // nothing on screen to explain why.
    return () => { document.documentElement.classList.remove(LOCK_CLASS); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // preventDefault, then close through React: Chromium's own dialog
      // Escape closes the ELEMENT directly, which would leave this
      // component's `open` prop stale and the gear unable to reopen it.
      // Routing both environments through onClose keeps one source of truth.
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="settingsdlg"
      aria-label="Settings"
      onCancel={e => { e.preventDefault(); onClose(); }}
      // A click on a native dialog's BACKDROP targets the dialog element
      // itself; a click on anything inside targets that child and bubbles.
      // Comparing the target is what tells the two apart.
      onClick={e => { if (e.target === dialogRef.current) onClose(); }}
    >
      <div className="settingspanel">
        <header className="settingshead">
          <h2>Settings</h2>
          <button type="button" className="settingsclose" aria-label="Close settings" onClick={onClose}>
            Close
          </button>
        </header>

        <label className="settingsrow">
          <span>Appearance</span>
          <select value={settings.appearance}
            onChange={e => setSettings({ appearance: e.target.value as Appearance })}>
            {APPEARANCES.map(a => <option key={a} value={a}>{APPEARANCE_LABEL[a]}</option>)}
          </select>
        </label>

        <label className="settingsrow">
          <span>Conversation text size</span>
          <select value={String(settings.textSize)}
            onChange={e => setSettings({ textSize: Number(e.target.value) as TextSize })}>
            {TEXT_SIZES.map(n => <option key={n} value={n}>{n}px</option>)}
          </select>
        </label>

        <label className="settingsrow">
          <span>Message style</span>
          <select value={settings.messageStyle}
            onChange={e => setSettings({ messageStyle: e.target.value as MessageStyle })}>
            {MESSAGE_STYLES.map(m => <option key={m} value={m}>{MESSAGE_STYLE_LABEL[m]}</option>)}
          </select>
        </label>

        <label className="settingsrow">
          <span>Compact cards</span>
          <select value={settings.compactCards}
            onChange={e => setSettings({ compactCards: e.target.value as CompactCards })}>
            {COMPACT_CARDS.map(c => <option key={c} value={c}>{COMPACT_LABEL[c]}</option>)}
          </select>
        </label>

        <div className="settingsfoot">
          <button type="button" className="settingsdone" onClick={onClose}>Done</button>
        </div>
      </div>
    </dialog>
  );
}
