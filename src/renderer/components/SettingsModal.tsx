import { useEffect, useId, useRef, useState } from 'react';
import {
  APPEARANCES, COMPACT_CARDS, DEFAULT_SETTINGS, MESSAGE_STYLES, TEXT_SIZES, setSettings, useSettings,
  type Appearance, type CompactCards, type MessageStyle, type TextSize,
} from '../state/settings.ts';
import { ProviderMark } from './ProviderMark.tsx';
import { DependencyChecks } from './DependencyChecks.tsx';
import { HooksConsent } from './HooksConsent.tsx';
import { useChecks } from '../state/useChecks.ts';
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

/** Design §4's wording, with the consent step named. Turning this ON no
 *  longer writes anything on its own (first-run design §6): it shows what
 *  would be written and waits for a yes. Turning it OFF still just removes
 *  our own entries, immediately -- a gate on leaving is not consent. */
const QUICK_ANSWERS_HELP =
  "Lets the app show what Claude is asking, using hooks in ~/.claude/settings.json. "
  + "Turning this on shows you exactly what it would add before anything is written. "
  + "Turning it off removes only the entries it added.";

/** Usage design, Part B, plus the coordinator's own review note: the base
 *  two sentences are the design's exact text; the third names the two
 *  preconditions (Part A's own concerns 1/2) that would otherwise leave
 *  someone staring at "No data yet" with no idea why. */
const USAGE_HELP =
  "Adds a status line to ~/.claude/settings.json so the app can show context and plan usage. "
  + "Claude Code hides most footer hints while any status line is set. "
  + "Needs a trusted folder; off when hooks are disabled.";

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

/** The Quick answers switch (design §4/§9): a standard ARIA `switch`
 *  (aria-checked, not aria-pressed -- this is an on/off setting, not one
 *  option among several the way the segmented controls above are).
 *  `checked` is `null` while the initial `hooksGet()` is still in flight, in
 *  which case the switch renders off but disabled -- there is nothing true
 *  yet to show as on. */
function QuickAnswersSwitch({ checked, disabled, labelId, onToggle }: {
  checked: boolean | null;
  disabled: boolean;
  labelId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      aria-labelledby={labelId}
      className="settingsswitch"
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="settingsswitchknob" aria-hidden="true" />
    </button>
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
  const quickAnswersLabelId = useId();
  const usageLabelId = useId();

  // Quick answers (design §4): `null` means "not yet read" -- distinct from
  // `false`, so the switch can render disabled rather than a possibly-wrong
  // "off" while the very first hooksGet() is in flight. Re-read every time
  // the modal opens (not just once on mount), per design §4: "re-read each
  // time Settings opens, so a hand edit cannot make it lie" -- the modal
  // stays mounted by its owner, so `open` going false-then-true is the only
  // signal a reopen gives this component.
  const checks = useChecks();
  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null);
  const [hooksError, setHooksError] = useState<string | null>(null);
  const [hooksBusy, setHooksBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const api = window.fleet;
    if (!api) return;
    let alive = true;
    setHooksInstalled(null);
    setHooksError(null);
    setConsentOpen(false);
    // Two-arg .then, not a bare .then/chained .catch (same reasoning as
    // useFleet.ts): ipcRenderer.invoke rejects rather than hangs when main
    // has no handler, and an unhandled rejection here would leave the
    // switch stuck disabled with no indication why.
    void api.hooksGet().then(
      r => { if (alive) { setHooksInstalled(r.installed); setHooksError(r.error); } },
      err => { if (alive) setHooksError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { alive = false; };
  }, [open]);

  // Turning it ON opens the consent panel and writes NOTHING. That is the
  // gate (first-run design §6): main refuses an install it has not just
  // previewed, so the switch could not write here even if it tried.
  // Turning it OFF removes our own entries straight away.
  const [consentOpen, setConsentOpen] = useState(false);

  const onToggleHooks = () => {
    const api = window.fleet;
    if (!api || hooksBusy || hooksInstalled === null) return;
    if (!hooksInstalled) { setConsentOpen(true); return; }
    setHooksBusy(true);
    void api.hooksSet(false).then(
      r => { setHooksInstalled(r.installed); setHooksError(r.error); setHooksBusy(false); },
      err => { setHooksError(err instanceof Error ? err.message : String(err)); setHooksBusy(false); },
    );
  };

  // Usage and context (usage design, Part B): same pattern as Quick answers
  // above -- `null` means "not yet read", re-read fresh every time the
  // modal opens, never trusting a remembered copy over what settings.json
  // actually says right now.
  const [usageInstalled, setUsageInstalled] = useState<boolean | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const api = window.fleet;
    // Guarded on the specific method, not just `api` itself (unlike Quick
    // answers' own effect above): several existing tests elsewhere in this
    // app stub window.fleet with only the methods THEY exercise (e.g.
    // LaunchBar.test.tsx's {launch, chooseDirectory, hooksGet, hooksSet}),
    // and this modal mounts inside every one of them via the gear. Calling
    // an absent usageSwitchGet would throw and take that unrelated test's
    // render down with it.
    if (!api?.usageSwitchGet) return;
    let alive = true;
    setUsageInstalled(null);
    setUsageError(null);
    void api.usageSwitchGet().then(
      r => { if (alive) { setUsageInstalled(r.installed); setUsageError(r.error); } },
      err => { if (alive) setUsageError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { alive = false; };
  }, [open]);

  const onToggleUsage = () => {
    const api = window.fleet;
    if (!api?.usageSwitchSet || usageBusy || usageInstalled === null) return;
    setUsageBusy(true);
    void api.usageSwitchSet(!usageInstalled).then(
      r => { setUsageInstalled(r.installed); setUsageError(r.error); setUsageBusy(false); },
      err => { setUsageError(err instanceof Error ? err.message : String(err)); setUsageBusy(false); },
    );
  };

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

        <section className="settingssection">
          <h3 className="settingssectitle">Quick answers</h3>
          <div className="settingsfield">
            <div className="settingsswitchrow">
              <div className="settingslabel" id={quickAnswersLabelId}>Quick answers</div>
              <QuickAnswersSwitch
                checked={hooksInstalled}
                disabled={hooksInstalled === null || hooksBusy}
                labelId={quickAnswersLabelId}
                onToggle={onToggleHooks}
              />
            </div>
            <p className="settingshelp">{QUICK_ANSWERS_HELP}</p>
            {hooksError !== null && <p className="settingserror" role="alert">{hooksError}</p>}
            {/* Shown only once someone has asked for it, and it is what
                actually performs the install -- the switch above cannot. */}
            {(consentOpen || hooksInstalled === true) && (
              <HooksConsent
                onSettled={setHooksInstalled}
                onDeclined={() => setConsentOpen(false)}
              />
            )}
          </div>
        </section>

        <section className="settingssection">
          <h3 className="settingssectitle">Usage and context</h3>
          <div className="settingsfield">
            <div className="settingsswitchrow">
              <div className="settingslabel" id={usageLabelId}>Usage and context</div>
              <QuickAnswersSwitch
                checked={usageInstalled}
                disabled={usageInstalled === null || usageBusy}
                labelId={usageLabelId}
                onToggle={onToggleUsage}
              />
            </div>
            <p className="settingshelp">{USAGE_HELP}</p>
            {usageError !== null && <p className="settingserror" role="alert">{usageError}</p>}
          </div>
        </section>

        {/* Design §5: the first-run checks stay reachable afterwards, because
            a dependency can disappear later -- an uninstall, a Homebrew
            cleanup, a PATH change. Same component the first-run surface
            uses, driven by the same hook. */}
        <section className="settingssection">
          <h3 className="settingssectitle">What this app needs</h3>
          <div className="settingsfield">
            <DependencyChecks {...checks} />
          </div>
        </section>

        <div className="settingsfoot">
          <p className="settingscaption">{FOOTER_CAPTION}</p>
          <button type="button" className="settingsdone" onClick={onClose}>Done</button>
        </div>
      </div>
    </dialog>
  );
}
