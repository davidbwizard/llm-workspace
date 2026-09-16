import { useEffect, useId, useRef } from 'react';
import {
  APPEARANCES, COMPACT_CARDS, DEFAULT_SETTINGS, MESSAGE_STYLES, TEXT_SIZES, setSettings, useSettings,
  type Appearance, type CompactCards, type MessageStyle, type TextSize,
} from '../state/settings.ts';
import { ProviderMark } from './ProviderMark.tsx';
import './SettingsModal.css';

/** Human wording for each stored value. Kept beside the store's own allowed
 *  sets so adding a value without labelling it is a compile error, not a
 *  blank option. Matches the wording in the design mockup David sent
 *  2026-09-16 (single words on the segmented controls, not the longer
 *  "Sidebar only" phrasing the old <select> used). */
const APPEARANCE_LABEL: Record<Appearance, string> = {
  system: 'System', light: 'Light', dark: 'Dark',
};
const COMPACT_LABEL: Record<CompactCards, string> = {
  off: 'Off', sidebar: 'Sidebar', fleet: 'Fleet', both: 'Both',
};
/** The middle dot is read straight off the mockup image, not a guess at a
 *  separator -- it is not the "--" the old <select> option text used. */
const MESSAGE_STYLE_LABEL: Record<MessageStyle, string> = {
  a: 'A · Margin rule',
  c: 'C · Your messages in a bubble',
};
const COMPACT_HELP =
  "Compact cards show the logo, name, status and terminal. The folder path always appears at the top of a session's conversation.";
const FOOTER_CAPTION = 'Changes apply right away and are remembered.';

/** Fixed sample turns for the live preview -- never real session data, so the
 *  preview cannot leak transcript content into a settings panel, and never
 *  changes shape as sessions come and go. Timestamps are the ones in the
 *  mockup, typed as plain strings since there is no real message to derive
 *  them from. */
const PREVIEW_ASSISTANT_TEXT = 'Yes, the real version would look and work just like that window.';
const PREVIEW_ASSISTANT_WHEN = '9:42 PM';
const PREVIEW_USER_TEXT = 'lets also fix the conversation layout.';
const PREVIEW_USER_WHEN = '9:52 PM';

/** The class that carries the background scroll lock. On the root element,
 *  not on body: this app's scrolling lives in .mainpane, .conv and
 *  .railcards, none of which body's own overflow reaches (see
 *  SettingsModal.css). */
const LOCK_CLASS = 'modal-open';

/** One row of a segmented control: a full-width group of equal buttons, the
 *  selected one filled, the rest transparent. Selection is exposed with
 *  aria-pressed rather than colour alone (spec: keyboard and screen readers
 *  must see the same state a sighted reader does) -- the previous <select>
 *  got this for free from the platform, so this is what replaces it.
 *
 *  Generic over the option type so Appearance (string) and TextSize (number)
 *  share one implementation rather than two near-identical ones. */
function Segmented<T extends string | number>({ labelId, options, value, onChange }: {
  labelId: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="settingsseg" role="group" aria-labelledby={labelId}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          className="settingssegbtn"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The abstract grey-bars-and-accent-mark preview inside each message-style
 *  card. Decorative only -- the card's own aria-pressed state and title text
 *  already carry what a screen reader needs, so this is aria-hidden rather
 *  than described. */
function StyleWireframe({ styleKey }: { styleKey: MessageStyle }) {
  if (styleKey === 'a') {
    return (
      <div className="settingswire settingswire-a" aria-hidden="true">
        <span className="settingswirerule" />
        <span className="settingswirebars">
          <span className="settingswirebar" />
          <span className="settingswirebar settingswirebar-short" />
        </span>
      </div>
    );
  }
  return (
    <div className="settingswire settingswire-c" aria-hidden="true">
      <span className="settingswirebubble" />
      <span className="settingswirebar" />
    </div>
  );
}

/** The live sample conversation under the message-style cards. Rendered from
 *  fixed text at the CURRENTLY selected text size and message style, so
 *  moving either control visibly changes it -- mirrors the actual rules in
 *  ConversationView.css (the accent rule down an assistant turn for style a,
 *  the neutral right-aligned bubble on the user's turn for style c) under
 *  its own class names, since this file's classes must not collide with
 *  ConversationView.css's.
 *
 *  aria-hidden: this is a worked example, not a real exchange, and reading
 *  it out as though "You" had just said something would be actively
 *  misleading to a screen reader user. */
function SettingsPreview({ textSize, messageStyle }: { textSize: TextSize; messageStyle: MessageStyle }) {
  return (
    <div
      className="settingsprev"
      data-style={messageStyle}
      style={{ ['--prev-size' as string]: `${textSize}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      <article className="settingsprevturn settingsprevturn-assistant">
        <div className="settingsprevmeta">
          <span className="settingsprevwho"><ProviderMark provider="claude" size={13} /></span>
          <span className="settingsprevwhen">{PREVIEW_ASSISTANT_WHEN}</span>
        </div>
        <p className="settingsprevtext">{PREVIEW_ASSISTANT_TEXT}</p>
      </article>
      <article className="settingsprevturn settingsprevturn-user">
        <div className="settingsprevmeta">
          <span className="settingsprevwho">You</span>
          <span className="settingsprevwhen">{PREVIEW_USER_WHEN}</span>
        </div>
        <p className="settingsprevtext">{PREVIEW_USER_TEXT}</p>
      </article>
    </div>
  );
}

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
  const appearanceLabelId = useId();
  const compactLabelId = useId();
  const textSizeLabelId = useId();
  const styleLabelId = useId();

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
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <section className="settingssection">
          <h3 className="settingssectitle">General</h3>
          <div className="settingsfield">
            <div className="settingslabel" id={appearanceLabelId}>Appearance</div>
            <Segmented
              labelId={appearanceLabelId}
              options={APPEARANCES.map(a => ({ value: a, label: APPEARANCE_LABEL[a] }))}
              value={settings.appearance}
              onChange={appearance => setSettings({ appearance })}
            />
          </div>
        </section>

        <section className="settingssection">
          <h3 className="settingssectitle">Sessions</h3>
          <div className="settingsfield">
            <div className="settingslabel" id={compactLabelId}>Compact cards</div>
            <Segmented
              labelId={compactLabelId}
              options={COMPACT_CARDS.map(c => ({ value: c, label: COMPACT_LABEL[c] }))}
              value={settings.compactCards}
              onChange={compactCards => setSettings({ compactCards })}
            />
            <p className="settingshelp">{COMPACT_HELP}</p>
          </div>
        </section>

        <section className="settingssection">
          <h3 className="settingssectitle">Conversation</h3>
          <div className="settingsfield">
            <div className="settingslabel" id={textSizeLabelId}>Text size</div>
            <Segmented
              labelId={textSizeLabelId}
              options={TEXT_SIZES.map(n => ({ value: n, label: `${n} px` }))}
              value={settings.textSize}
              onChange={textSize => setSettings({ textSize })}
            />
          </div>

          <div className="settingsfield">
            <div className="settingslabel" id={styleLabelId}>Message style</div>
            <div className="settingsstyles" role="group" aria-labelledby={styleLabelId}>
              {MESSAGE_STYLES.map(m => (
                <button
                  key={m}
                  type="button"
                  className="settingsstylecard"
                  aria-pressed={settings.messageStyle === m}
                  onClick={() => setSettings({ messageStyle: m })}
                >
                  <span className="settingsstyletitle">
                    {MESSAGE_STYLE_LABEL[m]}
                    {m === DEFAULT_SETTINGS.messageStyle && (
                      <>{' '}<span className="settingsstyledefault">default</span></>
                    )}
                  </span>
                  <StyleWireframe styleKey={m} />
                </button>
              ))}
            </div>
          </div>

          <SettingsPreview textSize={settings.textSize} messageStyle={settings.messageStyle} />
        </section>

        <div className="settingsfoot">
          <p className="settingscaption">{FOOTER_CAPTION}</p>
          <button type="button" className="settingsdone" onClick={onClose}>Done</button>
        </div>
      </div>
    </dialog>
  );
}
